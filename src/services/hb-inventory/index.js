// Happy Bakers inventory agent.
//
// Daily (7:30am CT): reads the Ledger (Inventory, Items, Offers, Settings, Box
// Calendar) + every Box subscription and one-off sale in Checkout Champ, forecasts how
// many of each month's Box item we'll ship (see forecast.js), and emails Alan an
// [HB-INV-n] report: stock, when it runs out, how many to order now. Goal is as few
// leftovers as possible, so orders cover only until the next one could land (lead +
// review days, +buffer) and it asks for top-ups as real rebill results come in.
//
// Alan replies by email (through the support agent's GHL inbox) to log an order, set
// a month's item, or change an assumption; Claude turns the reply into Ledger writes.
// The agent never buys anything itself.

const axios = require('axios');
const store = require('../hb-support/store');
const ghl = require('../hb-support/ghl');
const { callTool } = require('../hb-support/llm');
const ledger = require('./ledger');
const { forecast, addDays } = require('./forecast');
const { syncTemu, emailImages } = require('./temu');

const OWNER = () => (process.env.HB_SUPPORT_ALAN_EMAIL || 'alan@2by4llc.com').toLowerCase();
const tag = (id) => `HB-INV-${id}`;
const COC_START = '09/01/2026';
const SETTING_KEYS = {
  inv_lead_days: ['Days from placing an order to it landing at Shipsem', 10],
  inv_review_days: ['Each order covers this many days past its arrival (then a top-up)', 7],
  inv_buffer_pct: ['Extra % ordered on top of the forecast', 5],
  inv_signups_per_day: ['Blank = trailing 7-day average of Box signups', ''],
  inv_box_product_id: ['CoC product of the monthly Box subscription', 255],
  inv_box_trial_days: ['Days from Box signup to the first $25 rebill', 14],
};

const ctToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
const fmt = (n) => Math.round(n).toLocaleString('en-US');
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '?');
const monthName = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
const money = (n) => `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let state = null;
const load = () => { state = store.load('inventory', { nextId: 1, reports: [], log: [] }); };
const save = () => store.save('inventory', state);

// ─── Checkout Champ ─────────────────────────────────────────────────────────
// On Dash: direct (IP-whitelisted). Locally: set HB_INV_RELAY=1 + DASH_URL/DASH_PASSWORD to go through the relay.
async function cocQuery(resource, params) {
  const mdy = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const out = [];
  for (let page = 1; page < 200; page++) {
    const q = { campaignId: process.env.HB_COC_CAMPAIGN_ID || '15', startDate: COC_START, endDate: mdy(new Date(Date.now() + 86400000)), resultsPerPage: 200, page, ...params };
    let j;
    if (process.env.HB_INV_RELAY) {
      const r = await axios.get(`${process.env.DASH_URL || 'https://dash.2by4llc.com'}/api/coc-relay/${resource}`, { params: { loginId: 'brianreports-api', ...q }, headers: { 'x-dash-password': process.env.DASH_PASSWORD }, timeout: 60000 });
      j = r.data;
    } else {
      const body = new URLSearchParams({ loginId: process.env.HB_COC_LOGIN_ID, password: process.env.HB_COC_PASSWORD, ...q });
      j = (await axios.post(`https://api.checkoutchamp.com/${resource}/query/`, body.toString(), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 60000 })).data;
    }
    if (j.result !== 'SUCCESS') {
      if (/no .*found/i.test(JSON.stringify(j.message))) break;
      throw new Error(`CoC ${resource}: ${JSON.stringify(j.message).slice(0, 200)}`);
    }
    const rows = j.message.data || [];
    out.push(...rows);
    if (rows.length < 200 || out.length >= Number(j.message.totalResults || 0)) break;
  }
  return out;
}

const LIVE = /^(ACTIVE|TRIAL|RECYCLE_BILLING|PAUSED)$/;

async function gather() {
  const L = await ledger.read();
  const setting = (k) => (L.settings[k] === undefined || L.settings[k] === null || L.settings[k] === '' ? SETTING_KEYS[k][1] : L.settings[k]);
  const testPatterns = String(L.settings.test_emails || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const isTest = (email) => testPatterns.some((p) => String(email || '').toLowerCase().includes(p));
  const boxId = String(setting('inv_box_product_id'));
  const trialDays = Number(setting('inv_box_trial_days'));

  const purchases = (await cocQuery('purchase', {})).filter((p) => String(p.productId) === boxId && !isTest(p.emailAddress));
  const subs = purchases.map((p) => ({
    created: String(p.dateCreated).slice(0, 10),
    status: p.status,
    live: LIVE.test(String(p.status)),
    nextBillDate: p.nextBillDate ? String(p.nextBillDate).slice(0, 10) : null,
    intervalDays: Number(p.billingIntervalDays) || 30,
    trialDays,
    // A box ships on every approved charge of at least $5 (the $1 card check doesn't count).
    boxBills: (p.transactions || []).filter((t) => t.responseType === 'SUCCESS' && Number(t.totalAmount) >= 5).map((t) => String(t.txnDate).slice(0, 10)),
  }));

  // One-off products that ship a calendar item (e.g. 275 = SCALE on /Confirmation).
  const calSkus = new Set(L.calendar.map((c) => c.sku).filter(Boolean));
  const oneOffOffers = L.offers.filter((o) => String(o.productId) !== boxId && o.first.some((c) => calSkus.has(c.sku)));
  const oneOffSales = [];
  if (oneOffOffers.length) {
    const since = L.inventory.filter((r) => calSkus.has(r.sku) && r.date).map((r) => r.date).sort()[0];
    const byId = new Map(oneOffOffers.map((o) => [String(o.productId), o]));
    const start = since ? `${since.slice(5, 7)}/${since.slice(8, 10)}/${since.slice(0, 4)}` : COC_START;
    for (const o of await cocQuery('order', { orderStatus: 'COMPLETE', startDate: start })) {
      if (isTest(o.emailAddress)) continue;
      for (const it of Object.values(o.items || {})) {
        const offer = byId.get(String(it.productId));
        if (!offer) continue;
        for (const c of offer.first) if (calSkus.has(c.sku)) oneOffSales.push({ date: String(o.dateCreated).slice(0, 10), sku: c.sku, qty: c.qty * (Number(it.qty) || 1) });
      }
    }
  }

  const cfg = {
    leadDays: Number(setting('inv_lead_days')),
    reviewDays: Number(setting('inv_review_days')),
    bufferPct: Number(setting('inv_buffer_pct')),
    signupsPerDay: setting('inv_signups_per_day') === '' ? null : Number(setting('inv_signups_per_day')),
    minResolved: 20,
  };
  const f = forecast({ today: ctToday(), calendar: L.calendar, subs, oneOffSales, inventory: L.inventory, cfg });
  return { L, cfg, f, oneOffOffers };
}

// ─── report ──────────────────────────────────────────────────────────────────
// The Temu → 3PL tracking sheet (temu.js), as report lines. Not-logged POs are
// ignored when the sheet's Notes say sample/test (e.g. the whisk).
function temuLines(t) {
  if (t.error) return ['TEMU SHIPMENTS', `  Sync FAILED: ${t.error}. The 3PL sheet was not updated today.`];
  const out = ['TEMU SHIPMENTS (3PL sheet updated)'];
  out.push(`  ${t.packages} packages: ${t.delivered} delivered, ${t.inTransit.length} on the way${t.notShipped.length ? `, ${t.notShipped.length} order${t.notShipped.length > 1 ? 's' : ''} not shipped yet` : ''}.`);
  for (const p of t.newlyDelivered) out.push(`  Delivered: ${p.units} × ${p.item} (${p.carrier} ${p.tracking}, ${p.po})`);
  for (const p of t.inTransit) out.push(`  On the way: ${p.units} × ${p.item} · ${p.status} (${p.carrier} ${p.tracking})`);
  for (const po of t.notLogged) out.push(`  NOT IN THE LEDGER: ${po}. Forward its confirmation to log it, or note "sample" on it in the sheet.`);
  for (const e of t.errors) out.push(`  CHECK: ${e}`);
  out.push(`  Sheet: ${t.sheetUrl}`);
  return out;
}

function temuHtml(t, box, h, C) {
  const li = (color, s) => `<div style="font-size:14px;margin:6px 0;${color ? `color:${color}` : ''}">${s}</div>`;
  if (t.error) return box(h('Temu shipments') + li(C.bad, `✗ Sync failed: ${esc(t.error)}. The 3PL sheet was not updated today.`), C.bad);
  const parts = [li(null, `<b>${t.packages}</b> packages · <b style="color:${C.good}">${t.delivered}</b> delivered · <b>${t.inTransit.length}</b> on the way${t.notShipped.length ? ` · ${t.notShipped.length} not shipped yet` : ''}`)];
  for (const p of t.newlyDelivered) parts.push(li(C.good, `✓ Delivered: ${p.units} × ${esc(p.item)} <span style="color:${C.mute}">${p.carrier} ${p.tracking}</span>`));
  for (const p of t.inTransit) parts.push(li(null, `→ ${p.units} × ${esc(p.item)} · ${esc(p.status)} <span style="color:${C.mute}">${p.carrier} ${p.tracking}</span>`));
  for (const po of t.notLogged) parts.push(li(C.bad, `✗ ${po} isn't in the Ledger. Forward its confirmation to log it, or note "sample" on it in the sheet.`));
  for (const e of t.errors) parts.push(li(C.bad, `Check: ${esc(e)}`));
  parts.push(`<div style="margin-top:10px"><a href="${t.sheetUrl}" style="color:${C.terra};font-weight:700">Open the 3PL sheet</a></div>`);
  return box(h('Temu shipments') + parts.join(''), t.errors.length || t.notLogged.length ? C.bad : C.line);
}

function report({ L, cfg, f, temu }) {
  const lines = [];
  const headline = [];
  if (!L.calendar.length) {
    return { subject: 'Box Calendar is empty', text: `There is no month → item row in the Ledger's "${ledger.CALENDAR_TAB}" tab, so I can't tell what each month's Box ships. Reply with e.g. "November = SCALE".` };
  }
  for (const it of f.items) {
    const name = L.items[it.sku]?.name || it.sku;
    const monthsTxt = it.months.map(monthName).join(' + ');
    lines.push(`${it.sku} · ${name} (${monthsTxt} box)`);
    lines.push(`  Stock: ${fmt(it.bought)} bought − ${fmt(it.usedBoxes)} boxes billed − ${fmt(it.usedOneOff)} one-off sales = ${fmt(it.remaining)} left (includes units still in transit)`);
    lines.push(`  Still to ship through ${md(it.lastDay)}: ~${fmt(it.totalDemand)}${it.oneOffPerDay ? ` (incl. ~${it.oneOffPerDay.toFixed(1)}/day one-offs)` : ''}`);
    if (it.action === 'order_now') {
      lines.push(`  Runs out: ${md(it.stockout)}${it.lateRisk ? ` (before an order placed today would land ~${md(it.arrives)}: some boxes will ship late)` : ''}`);
      lines.push(`  → ORDER ${fmt(it.orderNow)} NOW. Lands ~${md(it.arrives)}, covers rebills through ${md(it.coverEnd)} with a ${cfg.bufferPct}% buffer.${it.unitCost ? ` About ${money(it.orderNow * it.unitCost)} at the ${money(it.unitCost)} average.` : ''}`);
      lines.push(`  To finish ${monthName(it.months[it.months.length - 1])}: ~${fmt(it.toFinish)} more in total. I'll ask for top-ups as real rebills come in rather than buying it all now.`);
      headline.push(`${it.sku}: order ${fmt(it.orderNow)} now`);
    } else if (it.action === 'watch') {
      lines.push(`  Runs out: ${md(it.stockout)}. Next order by ${md(it.orderBy)}: nothing needed today.`);
      lines.push(`  To finish ${monthName(it.months[it.months.length - 1])}: ~${fmt(it.toFinish)} more in total.`);
      headline.push(`${it.sku} OK until ${md(it.stockout)}`);
    } else {
      lines.push(`  Covered through ${md(it.lastDay)}. Expected leftover: ~${fmt(it.leftover)}.${it.leftover > it.totalDemand * 0.1 && it.leftover > 10 ? ' That\'s more than I\'d like: hold off on any more.' : ''}`);
      headline.push(`${it.sku} covered (~${fmt(it.leftover)} spare)`);
    }
    lines.push('');
  }
  for (const g of f.gaps) {
    lines.push(`${monthName(g.month).toUpperCase()}: no item chosen yet. ~${fmt(g.boxes)} boxes bill in ${monthName(g.month)} (first one ${md(g.firstBill)}, ${g.daysAway} days away). With a ${cfg.leadDays}-day lead time, pick it by ${md(addDays(g.firstBill, -cfg.leadDays - 3))}.`);
    if (g.daysAway <= cfg.leadDays + 21) headline.push(`${monthName(g.month)} item needed`);
  }
  if (f.gaps.length) lines.push('');
  if (temu) {
    lines.push(...temuLines(temu));
    lines.push('');
    if (temu.error || temu.errors?.length) headline.push('Temu sync problem');
    else if (temu.notLogged?.length) headline.push(`${temu.notLogged.length} Temu order${temu.notLogged.length > 1 ? 's' : ''} not in the Ledger`);
  }

  lines.push('BOXES BY MONTH (expected, still to bill)');
  for (const [m, n] of Object.entries(f.months).sort()) lines.push(`  ${monthName(m)}: ~${fmt(n)}${f.boxesBilledByMonth[m] ? ` (+${fmt(f.boxesBilledByMonth[m])} already billed)` : ''} · ${L.calendar.find((c) => c.month === m)?.sku || 'item TBD'}`);
  lines.push('');
  lines.push('ASSUMPTIONS');
  lines.push(`  First $25 rebill success: ${Math.round(f.rate * 100)}% ${f.measured ? `(measured: ${f.billed} of ${f.resolved} due so far billed)` : `(ASSUMED until ${cfg.minResolved} first rebills are due; ${f.resolved} so far). This is the big unknown: real declines will shrink every number above.`}`);
  lines.push(`  Later rebills: same rate. New signups: ${f.signupsPerDay.toFixed(1)}/day (${f.signupsPinned ? 'set in Settings' : 'trailing 7 days'}), continuing through the forecast. ${fmt(f.liveCount)} live Box subscriptions now.`);
  lines.push(`  Lead time ${cfg.leadDays} days · each order covers ${cfg.reviewDays} days past arrival · buffer ${cfg.bufferPct}%`);
  lines.push('');
  lines.push('REPLY TO');
  lines.push('  • Log an order: "ordered 200 scales, $918 total, PO-211-…, ETA 11/1"');
  lines.push('  • Set a month: "December = silicone baking mat, SKU MAT"');
  lines.push('  • Change an assumption: "lead time 12 days", "assume 30 signups a day", "buffer 3%"');
  return { subject: headline.join(' · ') || 'Inventory update', text: lines.join('\n') };
}

// Same content as report(), as an email page in the HB dashboard palette. Single-level
// tables with inline styles only: nested template HTML broke in Gmail before.
const C = { bg: '#fbf6ec', card: '#fffdf8', ink: '#3b2a20', mute: '#8a7566', line: '#eadfcb', terra: '#c4643f', honey: '#c99a4e', good: '#4f7d4a', bad: '#b4432f', soft: '#f4ead8' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function reportHtml({ L, cfg, f, temu }, intro) {
  const box = (inner, border = C.line) => `<div style="background:${C.card};border:1px solid ${border};border-radius:10px;padding:18px 20px;margin:0 0 16px">${inner}</div>`;
  const h = (t) => `<div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:${C.mute};font-weight:700;margin:0 0 10px">${t}</div>`;
  const row = (k, v, strong) => `<tr><td style="padding:6px 0;color:${C.mute};border-bottom:1px solid ${C.line}">${k}</td><td align="right" style="padding:6px 0;border-bottom:1px solid ${C.line};${strong ? `font-weight:700;color:${strong}` : ''}">${v}</td></tr>`;
  const table = (rows) => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px">${rows.join('')}</table>`;
  const callout = (color, bg, title, body) => `<div style="background:${bg};border-left:4px solid ${color};border-radius:6px;padding:12px 14px;margin:14px 0 0"><div style="font-weight:700;color:${color};font-size:16px">${title}</div>${body ? `<div style="color:${C.ink};font-size:13px;margin-top:4px;line-height:1.5">${body}</div>` : ''}</div>`;

  const parts = [];
  if (intro) parts.push(box(intro));
  for (const it of f.items) {
    const name = esc(L.items[it.sku]?.name || it.sku);
    const last = monthName(it.months[it.months.length - 1]);
    let action;
    if (it.action === 'order_now') {
      action = callout(C.terra, '#fbeee7', `Order ${fmt(it.orderNow)} now${it.unitCost ? ` · about ${money(it.orderNow * it.unitCost)}` : ''}`,
        `Lands ~${md(it.arrives)} and covers rebills through ${md(it.coverEnd)} (+${cfg.bufferPct}% buffer).${it.lateRisk ? ` <b style="color:${C.bad}">Stock runs out ${md(it.stockout)}, before it lands: some boxes will ship late.</b>` : ''}<br>All of ${last} needs ~${fmt(it.toFinish)} more; I'll ask for top-ups as real rebills come in.`);
    } else if (it.action === 'watch') {
      action = callout(C.honey, C.soft, `Nothing to order today`, `Next order by ${md(it.orderBy)}. All of ${last} needs ~${fmt(it.toFinish)} more.`);
    } else {
      const heavy = it.leftover > it.totalDemand * 0.1 && it.leftover > 10;
      action = callout(heavy ? C.honey : C.good, heavy ? C.soft : '#eef3ec', `Covered through ${md(it.lastDay)}`, `Expected leftover ~${fmt(it.leftover)}.${heavy ? ' More than I\'d like: hold off on any more.' : ''}`);
    }
    parts.push(box(
      `<div style="font-size:12px;color:${C.mute};text-transform:uppercase;letter-spacing:.08em;font-weight:700">${esc(it.months.map(monthName).join(' + '))} box</div>`
      + `<div style="font-size:20px;font-weight:700;margin:2px 0 12px">${name} <span style="font-size:13px;color:${C.mute};font-weight:400">${it.sku}</span></div>`
      + table([
        row('Bought (incl. in transit)', fmt(it.bought)),
        row('Boxes billed so far', `−${fmt(it.usedBoxes)}`),
        row('One-off sales', `−${fmt(it.usedOneOff)}`),
        row('Left', fmt(it.remaining), C.ink),
        row(`Still to ship through ${md(it.lastDay)}`, `~${fmt(it.totalDemand)}`),
        row('Runs out', it.stockout ? md(it.stockout) : 'Not this month', it.stockout ? C.bad : C.good),
        ...(it.unitCost ? [row('Average cost', money(it.unitCost))] : []),
      ])
      + action,
      it.action === 'order_now' ? C.terra : C.line,
    ));
  }
  for (const g of f.gaps) {
    parts.push(callout(C.bad, '#f8e9e6', `${monthName(g.month)}: no item chosen yet`,
      `~${fmt(g.boxes)} boxes. The first one ships ${md(g.firstBill)} (${g.daysAway} days away). With a ${cfg.leadDays}-day lead time, <b>pick it by ${md(addDays(g.firstBill, -cfg.leadDays - 3))}</b>.`).replace('margin:14px 0 0', 'margin:0 0 16px'));
  }
  if (temu) parts.push(temuHtml(temu, box, h, C));
  parts.push(box(h('Boxes by month · still to bill') + table(Object.entries(f.months).sort().map(([m, n]) => {
    const sku = L.calendar.find((c) => c.month === m)?.sku;
    return row(`${monthName(m)} · ${sku ? esc(sku) : `<span style="color:${C.bad}">item TBD</span>`}`, `~${fmt(n)}${f.boxesBilledByMonth[m] ? ` <span style="color:${C.mute}">(+${fmt(f.boxesBilledByMonth[m])} billed)</span>` : ''}`);
  }))));
  parts.push(box(h('Assumptions') + table([
    row('First $25 rebill success', f.measured ? `${Math.round(f.rate * 100)}% <span style="color:${C.mute}">(${f.billed} of ${f.resolved})</span>` : `<span style="color:${C.bad}">${Math.round(f.rate * 100)}% assumed</span>`),
    row('New Box signups', `${f.signupsPerDay.toFixed(1)}/day <span style="color:${C.mute}">(${f.signupsPinned ? 'set' : 'last 7 days'})</span>`),
    row('Live Box subscriptions', fmt(f.liveCount)),
    row('Lead time · cover after arrival · buffer', `${cfg.leadDays}d · ${cfg.reviewDays}d · ${cfg.bufferPct}%`),
  ]) + (f.measured ? '' : `<div style="font-size:12px;color:${C.mute};margin-top:10px;line-height:1.5">The success rate is assumed until ${cfg.minResolved} first rebills are due (${f.resolved} so far). Real declines will shrink every number above.</div>`)));
  parts.push(`<div style="font-size:13px;color:${C.mute};line-height:1.7;padding:0 4px"><b style="color:${C.ink}">Reply to this email to</b><br>• log an order: “ordered 200 scales, $918 total, PO-211-…, ETA 11/1”<br>• set a month: “December = silicone baking mat, SKU MAT”<br>• change an assumption: “lead time 12 days”, “assume 30 signups a day”</div>`);

  return `<html><body style="margin:0;padding:0;background:${C.bg}"><div style="background:${C.bg};padding:20px 12px;font-family:Arial,Helvetica,sans-serif;color:${C.ink}"><div style="max-width:600px;margin:0 auto">`
    + `<div style="font-size:13px;color:${C.mute};margin:0 0 4px">The Happy Bakers · Inventory · ${md(f.today)}</div>`
    + `<div style="font-size:22px;font-weight:700;margin:0 0 16px">${esc(report({ L, cfg, f, temu }).subject)}</div>`
    + parts.join('') + '</div></div></body></html>';
}

async function sendOwner(subject, text, html) {
  if (!state.ownerContactId) state.ownerContactId = await ghl.contactIdFor(OWNER());
  await ghl.sendEmail({ contactId: state.ownerContactId, to: OWNER(), fromName: 'HB Inventory Agent', subject, text, html });
}

// ─── daily run ───────────────────────────────────────────────────────────────
let running = false;
let lastRun = null;

async function seedLedger() {
  // First run: the Box Calendar tab + the agent's Settings rows (Alan edits them there).
  const L = await ledger.read();
  if (!L.hasCalendarTab) await ledger.ensureCalendarTab([['2026-11', 'SCALE', 'Box #1. Oct 30–31 rebills ship this too (before the first month = first month).'], ['2026-12', '', 'TBD']]);
  for (const [k, [note, def]] of Object.entries(SETTING_KEYS)) if (!(k in L.settings)) await ledger.setSetting(k, def, note);
}

async function runInventory({ send = true, force = false } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    load();
    await seedLedger();
    const today = ctToday();
    if (send && !force && state.lastSentDate === today) return { skipped: `already sent ${tag(state.reports[state.reports.length - 1]?.id)} today` };
    const g = await gather();
    // The daily email also refreshes the Temu → 3PL sheet. A failure is reported in the email, never silent.
    if (send) g.temu = await syncTemu({ ledgerInventory: g.L.inventory }).catch((e) => ({ error: e.message }));
    const r = report(g);
    const out = {
      at: new Date().toISOString(), subject: r.subject, text: r.text, html: reportHtml(g), temu: g.temu ? { ...g.temu, rows: undefined } : undefined, items: g.f.items, gaps: g.f.gaps, rate: g.f.rate, measured: g.f.measured,
      // Everything the HB dashboard's Inventory tab shows (GET /api/hb/inventory/forecast).
      forecast: g.f, cfg: g.cfg, calendar: g.L.calendar.map(({ month, sku, notes }) => ({ month, sku, notes })),
      names: Object.fromEntries(Object.values(g.L.items).map((i) => [i.sku, i.name])),
    };
    if (send) {
      const id = state.nextId++;
      await sendOwner(`[${tag(id)}] ${r.subject}`, r.text, reportHtml(g));
      state.lastSentDate = today;
      state.reports.push({ id, at: out.at, subject: r.subject, items: g.f.items.map(({ sku, remaining, stockout, orderNow, totalDemand }) => ({ sku, remaining, stockout, orderNow, totalDemand })) });
      state.reports = state.reports.slice(-90);
      save();
      out.id = id;
    }
    return (lastRun = out);
  } finally { running = false; }
}

// ─── Alan's replies ──────────────────────────────────────────────────────────
const ACTION_TOOL = {
  name: 'inventory_actions',
  description: 'Turn the owner\'s email into Ledger changes.',
  input_schema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['log_purchase', 'set_month', 'set_setting'] },
            sku: { type: 'string', description: 'Existing SKU from the Items list when it matches, else a new short UPPERCASE SKU' },
            item_name: { type: 'string', description: 'Only for a NEW sku' },
            qty: { type: 'number' },
            total_cost: { type: 'number', description: 'All-in total paid incl. tax/shipping, minus coupons' },
            unit_cost: { type: 'number', description: 'Only if no total was given' },
            date: { type: 'string', description: 'YYYY-MM-DD order date; today if not said' },
            paid_by: { type: 'string', description: 'Alan unless he says otherwise' },
            notes: { type: 'string', description: 'Supplier, PO / order number, ETA, model, as given' },
            month: { type: 'string', description: 'YYYY-MM for set_month' },
            key: { type: 'string', enum: Object.keys(SETTING_KEYS) },
            value: { type: ['string', 'number'] },
          },
          required: ['type'],
        },
      },
      question: { type: 'string', description: 'If something needed is missing or ambiguous (e.g. the quantity), ask instead of guessing. Empty when all clear.' },
      confirmation: { type: 'string', description: 'One or two plain sentences on what you read in his email. Say "Read:" not "Logged": the lines under it report what actually got written' },
    },
    required: ['actions', 'confirmation'],
  },
};

const poNumbers = (s) => [...new Set(String(s || '').match(/PO-\d{3}-\d{10,}/g) || [])];

function isInventoryMail(msg) {
  return /HB-INV/i.test(`${msg.subject} ${msg.text}`) || /\btemu\b/i.test(msg.subject || '');
}

async function handleOwner(msg) {
  if (!isInventoryMail(msg)) return false;
  load();
  const L = await ledger.read();
  const today = ctToday();
  // A forward's text is all "quoted", so read the whole body, not msg.text.
  const body = msg.html ? ghl.htmlToText(msg.html).slice(0, 6000) : msg.text;
  const images = await emailImages(msg.html);
  const out = await callTool({
    images,
    system: [
      'You keep the Happy Bakers inventory Ledger for Alan, the owner. The Box is a monthly subscription kit; each calendar month ships one item (Box Calendar). Alan buys stock himself (mostly Temu) and tells you about it by email.',
      'Only record what he actually said or what the forwarded order shows. Never invent a quantity, price or date: if the quantity of a purchase is missing, ask.',
      'Forwarded Temu order emails draw the line items (name, variant, unit price, ×qty) and the payment summary (item total, bonuses, coupons, tax, Order total) as images; those are attached when present. Read them. Ignore "add more items" and recommendation images. One log_purchase per line item; split the Order total across lines by their item prices. Put the order ID (PO-…) plus the line, price, coupons and tax math in notes, like the existing Inventory rows. If the images are missing or unreadable, ask for the quantity and total.',
      'Money: total_cost is what was actually paid (after coupons, with tax). If he gives only a unit price, use unit_cost.',
      'Settings he can change: ' + Object.entries(SETTING_KEYS).map(([k, [n]]) => `${k} (${n})`).join('; ') + '. For "assume N signups a day" set inv_signups_per_day; "go back to the real signup pace" sets it to "".',
      `Today is ${today}.`,
    ].join('\n'),
    tool: ACTION_TOOL,
    prompt: [
      `ITEMS (sku · name · avg unit cost)\n${Object.values(L.items).map((i) => `${i.sku} · ${i.name} · ${i.unitCost ?? '?'}`).join('\n')}`,
      `BOX CALENDAR\n${L.calendar.map((c) => `${c.month}: ${c.sku || 'TBD'}`).join('\n') || '(empty)'}`,
      `ALAN'S EMAIL (subject "${msg.subject}")${images.length ? ` — ${images.length} image${images.length > 1 ? 's' : ''} attached above` : ''}\n${body}`,
    ].join('\n\n'),
  });

  const done = [], failed = [], skipped = [];
  for (const a of out.actions || []) {
    try {
      if (a.type === 'log_purchase') {
        const sku = String(a.sku || '').toUpperCase();
        if (!sku || !(a.qty > 0) || (a.total_cost == null && a.unit_cost == null)) throw new Error('purchase is missing the SKU, quantity or cost');
        // The same order forwarded twice must not count twice.
        const po = poNumbers(`${a.notes} ${msg.subject}`)[0];
        const dupe = po && L.inventory.find((r) => r.sku === sku && String(r.notes || '').includes(po));
        if (dupe) { skipped.push(`${po} is already in the Ledger (${dupe.qty} × ${sku}, ${dupe.date}). Nothing added.`); continue; }
        if (!L.items[sku]) { await ledger.addItem({ sku, name: a.item_name || sku, notes: 'Added by the inventory agent' }); L.items[sku] = { sku, name: a.item_name || sku }; }
        const unit = a.total_cost != null ? a.total_cost / a.qty : a.unit_cost;
        await ledger.addPurchase({ date: a.date || today, sku, qty: a.qty, unitCost: Number(unit.toFixed(4)), paidBy: a.paid_by || 'Alan', location: 'Shipsem', notes: `${a.notes || ''}${a.total_cost != null ? ` (${money(a.total_cost)} total)` : ''} [logged by inventory agent from Alan's email]`.trim() });
        const fresh = await ledger.read();
        const rows = fresh.inventory.filter((r) => r.sku === sku);
        const qty = rows.reduce((s, r) => s + r.qty, 0), spent = rows.reduce((s, r) => s + r.qty * (r.unitCost || 0), 0);
        if (fresh.items[sku] && qty) await ledger.setItemCost(fresh.items[sku].row, Number((spent / qty).toFixed(2)));
        done.push(`Logged ${a.qty} × ${sku} at ${money(unit)} each${a.total_cost != null ? ` (${money(a.total_cost)})` : ''}. ${sku} average is now ${money(spent / qty)} over ${fmt(qty)} units.`);
      } else if (a.type === 'set_month') {
        const sku = a.sku ? String(a.sku).toUpperCase() : null;
        const month = ledger.monthKey(a.month);
        if (!month) throw new Error(`can't read the month "${a.month}"`);
        if (sku && !L.items[sku]) { await ledger.addItem({ sku, name: a.item_name || sku, notes: 'Added by the inventory agent' }); L.items[sku] = { sku, name: a.item_name || sku }; }
        await ledger.setMonth(month, sku, a.item_name || '');
        done.push(`${monthName(month)} ${month.slice(0, 4)} box = ${sku || 'TBD'}${a.item_name ? ` (${a.item_name})` : ''}.`);
      } else if (a.type === 'set_setting') {
        if (!SETTING_KEYS[a.key]) throw new Error(`unknown setting ${a.key}`);
        await ledger.setSetting(a.key, a.value ?? '', SETTING_KEYS[a.key][0]);
        done.push(`Settings ${a.key} = ${a.value === '' ? '(blank)' : a.value}.`);
      }
    } catch (e) { failed.push(`${a.type}: ${e.message}`); }
  }
  state.log.push({ at: new Date().toISOString(), subject: msg.subject, text: body.slice(0, 2000), images: images.length, actions: out.actions, done, failed, skipped, question: out.question || null });
  state.log = state.log.slice(-200);
  save();

  const parts = [out.confirmation];
  if (done.length) parts.push(done.map((d) => `Done: ${d}`).join('\n'));
  if (skipped.length) parts.push(skipped.map((d) => `Skipped: ${d}`).join('\n'));
  if (failed.length) parts.push(failed.map((d) => `FAILED: ${d}`).join('\n'));
  if (out.question) parts.push(`QUESTION\n${out.question}`);
  // The reply on top, then the refreshed forecast as the usual formatted report.
  const intro = [
    `<div style="font-size:15px;line-height:1.5">${esc(out.confirmation)}</div>`,
    ...done.map((d) => `<div style="color:${C.good};font-size:14px;margin-top:8px">✓ ${esc(d)}</div>`),
    ...skipped.map((d) => `<div style="font-size:14px;margin-top:8px">= ${esc(d)}</div>`),
    ...failed.map((d) => `<div style="color:${C.bad};font-size:14px;margin-top:8px">✗ ${esc(d)}</div>`),
    out.question ? `<div style="background:${C.soft};border-radius:6px;padding:10px 12px;margin-top:10px;font-size:14px"><b>Question:</b> ${esc(out.question)}</div>` : '',
  ].join('');
  let html;
  if (done.length) {
    const g = await gather();
    parts.push(`UPDATED FORECAST\n${report(g).text}`);
    html = reportHtml(g, intro);
  } else {
    html = `<html><body style="margin:0;background:${C.bg}"><div style="padding:20px 12px;font-family:Arial,Helvetica,sans-serif;color:${C.ink}"><div style="max-width:600px;margin:0 auto;background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:18px 20px">${intro}</div></div></body></html>`;
  }
  const id = state.nextId++;
  save();
  await sendOwner(`[${tag(id)}] ${out.question ? 'Question' : failed.length ? 'Problem' : 'Done'}: ${done.length ? `${done.length} change${done.length > 1 ? 's' : ''}` : skipped.length ? 'already logged' : 'nothing changed'}`, parts.join('\n\n'), html);
  return true;
}

function inventoryStatus() {
  load();
  return { lastSentDate: state.lastSentDate || null, lastRun, reports: state.reports.slice(-14), log: state.log.slice(-20) };
}

module.exports = { runInventory, handleOwner, inventoryStatus, _emailImages: emailImages, _report: report, _reportHtml: reportHtml, _gather: gather };

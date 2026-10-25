// Control panel (/control): live status of every moving part + a needs-you inbox, a few
// confirm-first controls, and the 7:15 CT morning email. Registry in registry.js, probes
// in probes.js, state on the volume via store.js.
const axios = require('axios');
const nodemailer = require('nodemailer');
const registry = require('./registry');
const store = require('./store');
const { track } = require('./runlog');
const { probe, launchd, pilotCookie } = require('./probes');

const CACHE_MS = 60 * 1000;
let cache = null;

// ── status ───────────────────────────────────────────────────────────────────
async function rows() {
  const out = await Promise.all(registry.map(async (item) => {
    let p;
    try { p = await probe(item); } catch (e) { p = { status: 'unknown', reason: `probe crashed: ${e.message}` }; }
    const { type, needsEnv, env, url, ...pub } = item;
    return { ...pub, ...p };
  }));
  // Mini launchd jobs the registry doesn't know about yet still get a row.
  const hb = store.load('mini', null);
  const known = new Set(registry.filter((r) => r.label).map((r) => r.label));
  for (const j of (hb && hb.jobs) || []) {
    if (known.has(j.label)) continue;
    const item = { id: j.label, group: 'Mac mini', label: j.label, name: `${j.label} (unregistered)`, schedule: j.keepAlive ? 'always on' : (j.interval ? `every ${Math.round(j.interval / 60)} min` : 'scheduled') };
    out.push({ ...item, ...launchd(item, hb) });
  }
  return out;
}

async function inbox(list) {
  const items = [];
  // Autopilot alerts that need a human (severity error / warn); info ones are counted only.
  const ap = registry.find((r) => r.id === 'autopilot');
  try {
    const { data } = await axios.get(`${ap.url}/api/alerts`, { timeout: 15000, headers: { Cookie: pilotCookie() } });
    const by = {};
    for (const a of data.alerts) {
      const k = a.account_name || a.slug || `account ${a.account_id}`;
      by[k] = by[k] || { error: 0, warn: 0, info: 0, first: null, slug: a.slug, id: a.account_id };
      const sev = a.severity === 'error' ? 'error' : a.severity === 'warn' || a.severity === 'warning' ? 'warn' : 'info';
      by[k][sev]++;
      if (sev !== 'info' && !by[k].first) by[k].first = String(a.message).split('\n')[0].slice(0, 160);
    }
    for (const [name, c] of Object.entries(by)) {
      if (c.error + c.warn) items.push({ source: 'Autopilot', level: c.error ? 'bad' : 'warn', title: `${name}: ${c.error + c.warn} alert${c.error + c.warn > 1 ? 's' : ''} ${c.error + c.warn > 1 ? 'need' : 'needs'} you`, note: c.first, count: c.error + c.warn, link: c.slug ? `${ap.url}/#${c.slug}` : ap.url });
    }
    const info = Object.values(by).reduce((s, c) => s + c.info, 0);
    if (info) items.push({ source: 'Autopilot', level: 'info', title: `${info} info alerts (graduate candidates, new test sets…)`, count: info, link: ap.url });
  } catch (e) { items.push({ source: 'Autopilot', level: 'unknown', title: `Couldn't read Autopilot alerts: ${e.response ? `HTTP ${e.response.status}` : e.message}` }); }

  // HB support cases waiting on Alan's email answer.
  try {
    const s = require('../hb-support').supportStatus();
    for (const c of s.cases.filter((x) => x.status === 'awaiting_owner').slice(0, 8)) {
      items.push({ source: 'HB support', level: 'warn', title: `[HB-CS-${c.id}] ${c.email || 'customer'}`, note: c.summary, link: 'https://mail.google.com/mail/u/0/#search/' + encodeURIComponent(`"HB-CS-${c.id}"`) });
    }
  } catch (e) { items.push({ source: 'HB support', level: 'unknown', title: `Couldn't read HB cases: ${e.message}` }); }

  const opsRow = list.find((r) => r.id === 'ops-dashboard');
  if (opsRow && opsRow.detail && opsRow.detail.actionable) items.push({ source: 'Ops triage', level: 'warn', title: `${opsRow.detail.actionable} SSS leads to act on`, count: opsRow.detail.actionable, link: opsRow.link });

  for (const r of list.filter((x) => x.status === 'bad')) items.push({ source: r.group, level: 'bad', title: `${r.name} is red`, note: r.reason, rowId: r.id });
  const rank = { bad: 0, warn: 1, unknown: 2, info: 3 };
  return items.sort((a, b) => rank[a.level] - rank[b.level]);
}

async function status({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const list = await rows();
  const counts = list.reduce((c, r) => ((c[r.status] = (c[r.status] || 0) + 1), c), {});
  const value = { at: new Date().toISOString(), counts, rows: list, inbox: await inbox(list), commands: store.load('commands', []).slice(-10), audit: store.load('audit', []).slice(-15).reverse() };
  cache = { at: Date.now(), value };
  return value;
}

// ── mini heartbeat ───────────────────────────────────────────────────────────
// The mini POSTs its launchd snapshot; the reply hands back any queued commands, and the
// next heartbeat reports their results.
function heartbeat(body) {
  const commands = store.load('commands', []);
  for (const r of body.results || []) {
    const c = commands.find((x) => x.id === r.id);
    if (c) Object.assign(c, { status: r.ok ? 'done' : 'failed', result: String(r.out || '').slice(0, 300), doneAt: new Date().toISOString() });
  }
  const send = commands.filter((c) => c.status === 'queued');
  send.forEach((c) => { c.status = 'sent'; c.sentAt = new Date().toISOString(); });
  store.save('commands', commands.slice(-50));
  const { results, ...snap } = body;
  store.save('mini', { ...snap, receivedAt: new Date().toISOString() });
  cache = null;
  return { ok: true, commands: send.map(({ id, label, action }) => ({ id, label, action })) };
}

// ── controls ─────────────────────────────────────────────────────────────────
// Re-runnable on demand = idempotent only. hb-inventory is NOT here: a re-run re-sends its email.
const RERUN = {
  'hb-support': () => require('../hb-support').runHbSupport(),
  'hb-ghl-sync': () => require('../hb-ghl-sync').runHbGhlSync({ days: 3 }),
  'temu-sync': () => require('../hb-inventory').runTemuSync(),
  'cpp-snapshot': () => require('../../routes/api').runCppSnapshot(),
};

function audit(entry) {
  const log = store.load('audit', []);
  log.push({ at: new Date().toISOString(), ...entry });
  store.save('audit', log.slice(-200));
}

async function action({ target, action: act, value }, who = 'panel') {
  const item = registry.find((r) => r.id === target);
  if (!item || !(item.controls || []).includes(act)) throw new Error(`${act} is not allowed on ${target}`);
  let result;
  if (act === 'rerun') {
    track(target, RERUN[target]).catch((e) => console.error(`[control] rerun ${target}:`, e.message));
    result = { started: true };
  } else if (act === 'mode') {
    result = { mode: require('../hb-support').setMode(String(value)) };
  } else if (act === 'kill') {
    const { data } = await axios.post(`${item.url}/api/flags/kill_switch`, { on: value === true }, { timeout: 15000, headers: { Cookie: pilotCookie() } });
    result = data;
  } else if (act === 'restart') {
    const commands = store.load('commands', []);
    const c = { id: `${Date.now().toString(36)}`, label: item.label, action: 'restart', status: 'queued', queuedAt: new Date().toISOString(), by: who };
    commands.push(c);
    store.save('commands', commands.slice(-50));
    result = { queued: c.id, note: 'runs on the next mini heartbeat (≤5 min)' };
  }
  audit({ target, action: act, value, who, result });
  cache = null;
  return result;
}

// ── morning email ────────────────────────────────────────────────────────────
const PANEL = 'https://dash.2by4llc.com/control';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function digest(s) {
  const bad = s.rows.filter((r) => r.status === 'bad');
  const warn = s.rows.filter((r) => r.status === 'warn');
  const needs = s.inbox.filter((i) => i.level !== 'info' && !i.rowId);
  const head = bad.length || warn.length ? `${bad.length} red, ${warn.length} amber` : 'all green';
  const subject = `[Control] ${head}${needs.length ? ` · ${needs.length} need you` : ''}`;
  const line = (r) => `${r.name}: ${r.reason}`;
  const text = [
    `${head.toUpperCase()} (${s.rows.filter((r) => r.status === 'ok').length} ok, ${s.counts.unknown || 0} unchecked)`,
    ...(bad.length ? ['', 'RED', ...bad.map(line)] : []),
    ...(warn.length ? ['', 'AMBER', ...warn.map(line)] : []),
    ...(needs.length ? ['', 'NEEDS YOU', ...needs.map((i) => `${i.source}: ${i.title}${i.note ? ` (${i.note})` : ''}`)] : []),
    '', `Panel: ${PANEL}`,
  ].join('\n');
  const li = (r, color) => `<li style="margin:4px 0"><b style="color:${color}">${esc(r.name)}</b>: ${esc(r.reason)}</li>`;
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;font-size:14px;color:#0f172a;line-height:1.45">
<p style="font-size:16px;margin:0 0 12px"><b>${esc(head)}</b> <span style="color:#64748b">(${s.rows.filter((r) => r.status === 'ok').length} ok, ${s.counts.unknown || 0} unchecked)</span></p>
${bad.length ? `<p style="margin:12px 0 4px;font-weight:700;color:#b91c1c">Red</p><ul style="margin:0;padding-left:18px">${bad.map((r) => li(r, '#b91c1c')).join('')}</ul>` : ''}
${warn.length ? `<p style="margin:12px 0 4px;font-weight:700;color:#b45309">Amber</p><ul style="margin:0;padding-left:18px">${warn.map((r) => li(r, '#b45309')).join('')}</ul>` : ''}
${needs.length ? `<p style="margin:12px 0 4px;font-weight:700">Needs you</p><ul style="margin:0;padding-left:18px">${needs.map((i) => `<li style="margin:4px 0">${i.link ? `<a href="${esc(i.link)}">${esc(i.title)}</a>` : esc(i.title)}${i.note ? ` <span style="color:#64748b">(${esc(i.note)})</span>` : ''}</li>`).join('')}</ul>` : ''}
<p style="margin:16px 0 0"><a href="${PANEL}" style="color:#0f172a;font-weight:700">Open the Control panel</a></p></div>`;
  return { subject, text, html };
}

// Gmail SMTP, not GHL: the HB GHL token is one of the things this email checks.
async function sendDigest({ to } = {}) {
  const user = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/[\s ]/g, ''); // app passwords get pasted with (NB)spaces
  if (!user || !pass) throw new Error('GMAIL_USER / GMAIL_APP_PASSWORD not set');
  const d = digest(await status({ fresh: true }));
  const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transport.sendMail({ from: `2by4 Control <${user}>`, to: to || process.env.CONTROL_EMAIL_TO || 'alan@2by4llc.com', subject: d.subject, text: d.text, html: d.html });
  return { sent: true, subject: d.subject };
}

module.exports = { status, heartbeat, action, digest, sendDigest, track };

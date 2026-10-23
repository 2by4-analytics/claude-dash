// Temu shipment tracker for the 3PL (Shipsem / Eric).
//
// Temu order mail goes to alan2by4@gmail.com (not a 2by4 inbox). Read over IMAP
// with an app password, from All Mail AND Trash: Alan trashes them after forwarding,
// and Gmail empties Trash after 30 days, so every parsed message is kept in
// /data/hb-support/temu.json and the sheet is rebuilt from that cache.
//
// Order #, tracking # and every status (shipped / with carrier / out for delivery /
// delivered) are plain text keyed by tracking number. What's IN a package is only in
// images, so Claude reads each order's item rows once (confirmation, or the first
// shipped email if the confirmation is gone) and each split package's "Package N ×qty"
// image once. Results are cached; a day with no new mail makes no model calls.
//
// Output: the "Temu Shipments → 3PL" sheet (HB_TEMU_SHEET_ID), rewritten in place so
// the link the 3PL has keeps working. Notes typed into the sheet are kept across runs.

// imapflow/mailparser call crypto.getRandomValues, which isn't a global on Railway's Node.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;

const axios = require('axios');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { google } = require('googleapis');
const store = require('../hb-support/store');
const { htmlToText } = require('../hb-support/ghl');
const { callTool } = require('../hb-support/llm');

const SHEET_ID = () => process.env.HB_TEMU_SHEET_ID || '1VXLZLO6cudctCottxfuQXvhFYwTcUGN6W3p1BIGaWYQ';
const SHEET_URL = () => `https://docs.google.com/spreadsheets/d/${SHEET_ID()}/edit`;
const SENDER = 'orders@transaction.temu.com';
const LOOKBACK_DAYS = 45;
const HEADER = ['Order #', 'Ordered', 'Package', 'Carrier', 'Tracking #', 'Item', 'Variant', 'Seller', 'Qty', 'Shipped', 'Status', 'In Ledger', 'Notes'];

let state = null;
const load = () => { state = store.load('temu', { msgs: {}, orders: {}, packages: {}, delivered: [], lastSync: null }); };
const save = () => store.save('temu', state);

const ctDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date(d));
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}` : '');

// Temu order emails draw the line items and totals as images (pos-u / pfs-u on
// file.temu.com, plus the commimg header). Skip the "recommended for you" grid
// (cmsgr-ud) and static icons on aimg.kwcdn.com.
const TEMU_IMG = /^https:\/\/(pos-u\.file\.temu\.com\/cmsg-ud\/|pfs-u\.file\.temu\.com\/|commimg\.us\.kwcdn\.com\/mail-combine)/;
async function emailImages(html) {
  const urls = [...new Set([...String(html || '').matchAll(/<img[^>]+src="([^"]+)"/gi)].map((m) => m[1].replace(/&amp;/g, '&')))].filter((u) => TEMU_IMG.test(u)).slice(0, 10);
  const out = [];
  for (const u of urls) {
    try {
      const r = await axios.get(u, { responseType: 'arraybuffer', timeout: 15000 });
      const type = String(r.headers['content-type'] || '').split(';')[0];
      if (/^image\/(png|jpeg|gif|webp)$/.test(type) && r.data.length < 3e6) out.push({ media_type: type, data: Buffer.from(r.data).toString('base64') });
    } catch { /* one missing image shouldn't stop the rest */ }
  }
  return out;
}

// ─── parse one Temu email (text only) ────────────────────────────────────────
function parse({ subject, text, date }) {
  const all = `${subject}\n${text}`;
  const po = (all.match(/PO-\d{3}-\d{10,}/) || [])[0] || null;
  const kind = /order confirmation/i.test(subject) ? 'ordered'
    : /tracking number is ready/i.test(subject) ? 'shipped'
      : /transferred to/i.test(subject) ? 'with_carrier'
        : /out-for-delivery/i.test(subject) ? 'out_for_delivery'
          : /delivered/i.test(subject) ? 'delivered' : 'other';
  const tracking = (text.match(/tracking number is ([A-Z0-9]{8,})/i)
    || text.match(/View details on (?:FedEx|UPS|USPS)\s*\n\s*([A-Z0-9]{8,})/i)
    || text.match(/Tracking Number:\s*\n?\s*([A-Z0-9]{8,})/i) || [])[1] || null;
  const carrier = (all.match(/\b(FedEx|UPS|USPS)\b/) || [])[1] || null;
  const pkg = Number((text.match(/Package (\d+) of your order/i) || [])[1]) || null;
  let at = ctDate(date);
  const d = text.match(/delivered on (\w+ \d{1,2}, \d{4})/i) || text.match(/Delivery Date:\s*\n?\s*\w+, (\d{1,2}\/\d{1,2}\/\d{4})/i);
  if (kind === 'delivered' && d && !Number.isNaN(new Date(d[1]).getTime())) at = ctDate(`${d[1]} 12:00`);
  return { po, kind, tracking, carrier, pkg, at };
}

// ─── IMAP ────────────────────────────────────────────────────────────────────
async function fetchNew() {
  const user = process.env.TEMU_GMAIL_USER, pass = String(process.env.TEMU_GMAIL_APP_PASSWORD || '').replace(/[\s ]/g, '');
  if (!user || !pass) throw new Error('TEMU_GMAIL_USER / TEMU_GMAIL_APP_PASSWORD missing');
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  const fresh = [];
  try {
    for (const box of ['[Gmail]/All Mail', '[Gmail]/Trash']) {
      const lock = await client.getMailboxLock(box, { readOnly: true });
      try {
        const uids = await client.search({ from: SENDER, since: new Date(Date.now() - LOOKBACK_DAYS * 86400000) }, { uid: true });
        if (!uids || !uids.length) continue;
        const todo = [];
        for await (const m of client.fetch(uids, { envelope: true }, { uid: true })) {
          const id = m.envelope.messageId;
          if (id && !state.msgs[id]) todo.push(m.uid);
        }
        for (const uid of todo) {
          const m = await client.fetchOne(uid, { source: true }, { uid: true });
          const p = await simpleParser(m.source);
          if (!p.messageId || state.msgs[p.messageId]) continue;
          const html = p.html || '';
          const text = html ? htmlToText(html) : (p.text || '');
          fresh.push({ id: p.messageId, subject: p.subject || '', date: p.date || new Date(), text, html });
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
  return fresh;
}

// ─── reading the images ──────────────────────────────────────────────────────
const ITEM = { type: 'object', properties: { name: { type: 'string' }, variant: { type: 'string' }, seller: { type: 'string' }, unit_price: { type: 'number' }, qty: { type: 'number' } }, required: ['name', 'qty'] };
const ORDER_TOOL = {
  name: 'temu_order',
  description: 'The line items and payment summary of one Temu order, as drawn in the email images.',
  input_schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: ITEM, description: 'Every ordered line item (name as shown, variant line, seller/store line, unit price, ×qty). Not recommendations.' },
      item_total: { type: 'number', description: '"Item(s) total" from the payment summary, if shown (even when struck through)' },
      subtotal: { type: 'number', description: '"Subtotal", if shown' },
      order_total: { type: 'number', description: '"Order total", if shown' },
      unreadable: { type: 'string', description: 'Why, if the images do not show the line items. Else empty.' },
    },
    required: ['items'],
  },
};
const PACKAGE_TOOL = {
  name: 'temu_package',
  description: 'What is inside ONE package of a split Temu order.',
  input_schema: {
    type: 'object',
    properties: {
      items: { type: 'array', items: ITEM, description: 'The items in THIS package with THIS package\'s quantity' },
      unreadable: { type: 'string' },
    },
    required: ['items'],
  },
};

async function readOrder(msg) {
  const images = await emailImages(msg.html);
  if (!images.length) return { items: [], unreadable: 'no Temu images in the email' };
  return callTool({
    images,
    system: 'You read Temu order emails. The line items (thumbnail, name, variant, seller/store, unit price, ×qty) and the payment summary are drawn as images. Copy exactly what is shown; a name that ends in "..." stays cut off. Never guess a number.',
    tool: ORDER_TOOL,
    prompt: `Email subject: ${msg.subject}\nRead the ordered line items and the payment summary from the images above.`,
  });
}

async function readPackage(msg, orderItems) {
  const images = await emailImages(msg.html);
  if (!images.length) return { items: [], unreadable: 'no Temu images in the email' };
  return callTool({
    images,
    system: 'You read Temu "part of your order shipped" emails. One image shows "Package N" with a thumbnail per item and a ×count badge: that badge is the quantity IN THIS PACKAGE. The line-item rows below it show the WHOLE order\'s quantity, so do not use their ×qty for the package. Never guess a number.',
    tool: PACKAGE_TOOL,
    prompt: `Email subject: ${msg.subject}\nThe email text says: "${(msg.text.match(/Package \d+ of your order[^.]*\./i) || [''])[0]}"\nThe whole order: ${orderItems.map((i) => `${i.qty} × ${i.name} (${i.variant || ''})`).join('; ') || 'unknown'}\nWhat is inside this package, with this package's quantities?`,
  });
}

// ─── build the sheet rows ────────────────────────────────────────────────────
const STATUS_RANK = { shipped: 1, with_carrier: 2, out_for_delivery: 3, delivered: 4 };
const STATUS_TXT = { shipped: 'Shipped', with_carrier: 'With carrier', out_for_delivery: 'Out for delivery', delivered: 'Delivered' };

function build(ledgerPos) {
  const msgs = Object.values(state.msgs);
  const pos = [...new Set(msgs.map((m) => m.po).filter(Boolean))];
  const rows = [];
  for (const po of pos) {
    const mine = msgs.filter((m) => m.po === po);
    const order = state.orders[po] || { items: [] };
    const ordered = (mine.find((m) => m.kind === 'ordered') || mine.slice().sort((a, b) => a.at.localeCompare(b.at))[0]).at;
    const ships = [...new Map(mine.filter((m) => m.kind === 'shipped' && m.tracking).map((m) => [m.tracking, m])).values()].sort((a, b) => (a.pkg || 0) - (b.pkg || 0));
    const split = ships.some((s) => s.pkg);
    const ledger = ledgerPos ? (ledgerPos.has(po) ? 'Yes' : 'NOT LOGGED') : '';
    const base = { po, ordered, ledger };
    if (!ships.length) {
      for (const it of order.items) rows.push({ ...base, pkg: '', carrier: '', tracking: '', item: it, shipped: '', status: 'Ordered, not shipped' });
      continue;
    }
    ships.forEach((s, i) => {
      // Status events carry the tracking number; an order with one package can also use PO-only events.
      const events = msgs.filter((m) => (m.tracking === s.tracking || (ships.length === 1 && m.po === po && !m.tracking)) && STATUS_RANK[m.kind]);
      const last = events.sort((a, b) => STATUS_RANK[b.kind] - STATUS_RANK[a.kind] || b.at.localeCompare(a.at))[0] || s;
      const status = `${STATUS_TXT[last.kind]}${last.kind === 'shipped' ? '' : ` ${md(last.at)}`}`;
      const items = split ? (state.packages[s.id]?.items || []) : order.items;
      const pkg = `${s.pkg || i + 1} of ${ships.length}`;
      if (!items.length) rows.push({ ...base, pkg, carrier: s.carrier, tracking: s.tracking, item: { name: '(contents not read yet)' }, shipped: s.at, status, delivered: last.kind === 'delivered' });
      for (const it of items) rows.push({ ...base, pkg, carrier: s.carrier, tracking: s.tracking, item: it, shipped: s.at, status, delivered: last.kind === 'delivered' });
    });
  }
  return rows.sort((a, b) => a.ordered.localeCompare(b.ordered) || a.po.localeCompare(b.po) || a.pkg.localeCompare(b.pkg));
}

// ─── the sheet ───────────────────────────────────────────────────────────────
let sheetsClient = null;
function sheets() {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}
const noteKey = (po, tracking) => `${po}|${String(tracking || '-').replace(/[="]/g, '')}`;

// Whatever Alan or the 3PL typed in Notes, keyed by order + tracking (one note per package), so it survives the rewrite.
async function readSheet() {
  const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), fields: 'sheets.properties' });
  const tab = meta.data.sheets[0].properties.title;
  const cur = (await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `'${tab}'!A1:Z2000`, valueRenderOption: 'FORMATTED_VALUE' })).data.values || [];
  const h = cur[0] || [];
  const col = (n) => h.findIndex((x) => String(x).trim().startsWith(n));
  const [cPo, cTrk, cNotes] = [col('Order #'), col('Tracking #'), col('Notes')];
  const notes = new Map();
  if (cNotes >= 0) for (const r of cur.slice(1)) if (r[cNotes]) notes.set(noteKey(r[cPo], r[cTrk]), r[cNotes]);
  return { tab, notes };
}

async function writeSheet(tab, rows) {
  const values = [HEADER, ...rows.map((r) => [
    r.po, r.ordered, r.pkg, r.carrier || '', r.tracking ? `="${r.tracking}"` : '', r.item.name || '', r.item.variant || '', r.item.seller || '',
    r.item.qty ?? '', r.shipped || '', r.status, r.ledger, r.note,
  ])];
  await sheets().spreadsheets.values.clear({ spreadsheetId: SHEET_ID(), range: `'${tab}'!A1:Z2000` });
  await sheets().spreadsheets.values.update({ spreadsheetId: SHEET_ID(), range: `'${tab}'!A1`, valueInputOption: 'USER_ENTERED', requestBody: { values } });
  return values.length - 1;
}

// ─── run ─────────────────────────────────────────────────────────────────────
// ledgerInventory: the Ledger's Inventory rows (to flag POs nobody logged). write=false = dry run.
let running = null;
function syncTemu(opts) {
  // The hourly sync and the 7:30 email can overlap: share one run.
  if (!running) running = doSync(opts).finally(() => { running = null; });
  return running;
}

async function doSync({ ledgerInventory = null, write = true } = {}) {
  load();
  const errors = [];
  const fresh = await fetchNew();
  for (const m of fresh) {
    const p = parse(m);
    state.msgs[m.id] = { id: m.id, subject: m.subject, ...p };
    m.parsed = p;
  }
  // Contents: once per order, and once per split package.
  for (const m of fresh.filter((x) => x.parsed.po)) {
    const { po, kind, pkg } = m.parsed;
    const o = state.orders[po];
    const better = kind === 'ordered' && o && o.from !== 'ordered';
    if ((!o || !o.items.length || better) && (kind === 'ordered' || kind === 'shipped')) {
      try {
        const r = await readOrder(m);
        const items = r.items || [];
        const sum = items.reduce((s, i) => s + (i.unit_price || 0) * (i.qty || 0), 0);
        // Unit prices are shown after item discounts, so they may add to the Subtotal instead of a struck-through Item(s) total.
        const off = (x) => x == null || Math.abs(sum - x) > 0.02;
        const check = r.item_total && off(r.item_total) && off(r.subtotal) ? `items add to $${sum.toFixed(2)} but the receipt says $${r.item_total}` : null;
        if (items.length || !o) state.orders[po] = { items, itemTotal: r.item_total ?? null, subtotal: r.subtotal ?? null, orderTotal: r.order_total ?? null, from: kind, check, unreadable: r.unreadable || null };
        if (check) errors.push(`${po}: ${check}`);
        if (!items.length) errors.push(`${po}: couldn't read the items (${r.unreadable || 'no rows'})`);
      } catch (e) { errors.push(`${po}: reading the order failed: ${e.message}`); }
    }
  }
  for (const m of fresh.filter((x) => x.parsed.kind === 'shipped' && x.parsed.pkg)) {
    try {
      const r = await readPackage(m, state.orders[m.parsed.po]?.items || []);
      state.packages[m.id] = { po: m.parsed.po, pkg: m.parsed.pkg, items: r.items || [] };
      if (!(r.items || []).length) errors.push(`${m.parsed.po} package ${m.parsed.pkg}: couldn't read the contents (${r.unreadable || 'no rows'})`);
    } catch (e) { errors.push(`${m.parsed.po} package ${m.parsed.pkg}: ${e.message}`); }
  }
  // Split packages must add up to the order.
  for (const [po, o] of Object.entries(state.orders)) {
    const pk = Object.values(state.packages).filter((p) => p.po === po);
    if (!pk.length || !o.items.length) continue;
    const want = o.items.reduce((s, i) => s + (i.qty || 0), 0), got = pk.reduce((s, p) => s + p.items.reduce((t, i) => t + (i.qty || 0), 0), 0);
    if (got > want) errors.push(`${po}: packages hold ${got} but the order is for ${want}`);
  }

  const ledgerPos = ledgerInventory ? new Set(ledgerInventory.flatMap((r) => String(r.notes || '').match(/PO-\d{3}-\d{10,}/g) || [])) : null;
  const rows = build(ledgerPos);
  const sheet = await readSheet();
  for (const r of rows) r.note = sheet.notes.get(noteKey(r.po, r.tracking)) || '';
  const written = write ? await writeSheet(sheet.tab, rows) : 0;

  // Deliveries the 3PL hasn't been told about yet (new since the last run).
  const seen = new Set(state.delivered);
  const pkgs = [...new Map(rows.filter((r) => r.tracking).map((r) => [r.tracking, r])).values()];
  const newlyDelivered = pkgs.filter((r) => r.delivered && !seen.has(r.tracking));
  if (write) { state.delivered = [...seen, ...newlyDelivered.map((r) => r.tracking)]; state.lastSync = new Date().toISOString(); }
  save();

  const units = (list) => list.reduce((s, r) => s + (Number(r.item.qty) || 0), 0);
  const inTransit = rows.filter((r) => r.tracking && !r.delivered);
  return {
    sheetUrl: SHEET_URL(), newEmails: fresh.length, written, errors,
    packages: pkgs.length,
    delivered: pkgs.filter((r) => r.delivered).length,
    inTransit: [...new Map(inTransit.map((r) => [r.tracking, r])).values()].map((r) => ({ po: r.po, tracking: r.tracking, carrier: r.carrier, status: r.status, units: units(inTransit.filter((x) => x.tracking === r.tracking)), item: r.item.name })),
    newlyDelivered: newlyDelivered.map((r) => ({ po: r.po, tracking: r.tracking, carrier: r.carrier, status: r.status, units: units(rows.filter((x) => x.tracking === r.tracking)), item: r.item.name })),
    notShipped: [...new Set(rows.filter((r) => !r.tracking).map((r) => r.po))],
    // A sample/test order (noted so in the sheet) isn't stock, so it needn't be in the Ledger.
    notLogged: [...new Set(rows.filter((r) => r.ledger === 'NOT LOGGED' && !/sample|test/i.test(r.note)).map((r) => r.po))],
    // What the inventory agent needs to log those orders itself.
    orders: Object.fromEntries([...new Set(rows.map((r) => r.po))].map((po) => [po, { ...state.orders[po], ordered: rows.find((r) => r.po === po).ordered }])),
    rows,
  };
}

module.exports = { syncTemu, emailImages, _parse: parse, _build: build };

// Happy Bakers: per-order fulfillment details (e.g. canvas set designs, size, frame
// choices) that Checkout Champ can't carry into ShipStation. Checkout Champ's
// ShipStation plugin only sends SKU/name/qty, so the site posts the details to Dash
// against the CoC order id, and a 5-min job writes them onto the matching HB
// ShipStation order(s) (ShipStation orderNumber = CoC orderId) as a marked block in
// BOTH "Notes from Buyer" (customerNotes, on the default packing slip) and Internal
// Notes. Idempotent: the block is replaced, never duplicated. It keeps checking for
// 10 days after writing, because the bad-address flow re-creates orders (orderKey
// + "-R") and the new copy needs the block too.
const nodemailer = require('nodemailer');
const store = require('./hb-support/store');
const ss = require('./hb-support/shipstation');

const FILE = 'fulfillment-notes';
const OPEN = '[HB order details]';
const CLOSE = '[/HB order details]';
const EDITABLE = /^(awaiting_payment|awaiting_shipment|on_hold|pending_fulfillment)$/;
const H = 3600e3, D = 24 * H;
const NOT_FOUND_ALERT_MS = Number(process.env.HB_FNOTE_ALERT_HOURS || 6) * H;
const RECHECK_AFTER_WRITE_MS = 10 * D;
const GIVE_UP_MS = 30 * D;

const load = () => store.load(FILE, { notes: {} });
const save = (s) => store.save(FILE, s);

function validate({ orderId, note }) {
  const id = String(orderId || '').trim().toUpperCase();
  const text = String(note || '').replace(/\r\n?/g, '\n').replace(/\[\/?HB order details\]/gi, '').trim();
  const errors = [];
  if (!/^[A-Z0-9]{6,30}$/.test(id)) errors.push('orderId must be the Checkout Champ order id (6–30 letters/digits)');
  if (!text || text.length > 1000) errors.push('note is required (max 1000 characters)');
  return { errors, id, text };
}

/** Site → Dash. Saves (or replaces) the details for one CoC order. */
function upsertNote(body) {
  const { errors, id, text } = validate(body || {});
  if (errors.length) return { status: 400, body: { ok: false, error: 'invalid', details: errors } };
  const s = load();
  const prev = s.notes[id];
  if (prev && prev.note === text) return { status: 200, body: { ok: true, orderId: id, status: prev.status, unchanged: true } };
  s.notes[id] = { note: text, status: 'pending', createdAt: prev?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), writtenTo: [], alerted: false };
  save(s);
  return { status: 200, body: { ok: true, orderId: id, status: 'pending' } };
}

function getNotes(orderId) {
  const s = load();
  if (orderId) {
    const id = String(orderId).toUpperCase();
    return s.notes[id] ? { [id]: s.notes[id] } : {};
  }
  return s.notes;
}

function withBlock(existing, note) {
  const esc = (x) => x.replace(/[[\]/\\^$.*+?()|{}]/g, '\\$&');
  const stripped = String(existing || '').replace(new RegExp(`\\n*${esc(OPEN)}[\\s\\S]*?${esc(CLOSE)}`, 'g'), '').trim();
  return [stripped, `${OPEN}\n${note}\n${CLOSE}`].filter(Boolean).join('\n\n');
}

async function notify(subject, lines) {
  const user = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/[\s ]/g, '');
  if (!user || !pass) return;
  try {
    await nodemailer.createTransport({ service: 'gmail', auth: { user, pass } }).sendMail({
      from: `2by4 Dash <${user}>`, to: process.env.HB_PRODUCT_NOTIFY_TO || 'alan@2by4llc.com', subject, text: lines.join('\n'),
    });
  } catch (e) { console.error('[hb-fnotes] email failed:', e.message); }
}

/** 5-min job: push pending/recent details onto the ShipStation orders. */
async function runFulfillmentNotes() {
  const s = load();
  const now = Date.now();
  const summary = { checked: 0, written: 0, waiting: 0, errors: [] };
  for (const [id, rec] of Object.entries(s.notes)) {
    const age = now - Date.parse(rec.createdAt);
    const sinceWrite = rec.writtenAt ? now - Date.parse(rec.writtenAt) : 0;
    if (rec.status === 'expired' || rec.status === 'missed') continue;
    if (rec.status === 'written' && sinceWrite > RECHECK_AFTER_WRITE_MS) continue;
    if (age > GIVE_UP_MS) { rec.status = 'expired'; continue; }
    summary.checked++;
    try {
      const r = await ss.http().get('/orders', { params: { orderNumber: id } });
      const orders = (r.data.orders || []).filter(ss.isHb).filter((o) => o.orderNumber === id);
      const editable = orders.filter((o) => EDITABLE.test(o.orderStatus));
      if (!orders.length) {
        summary.waiting++;
        if (age > NOT_FOUND_ALERT_MS && !rec.alerted) {
          rec.alerted = true;
          await notify(`[HB order details] ${id} not in ShipStation yet`, [
            `Order ${id} has fulfillment details from the site, but no Happy Bakers ShipStation order after ${Math.round(age / H)}h.`,
            'Dash keeps checking every 5 minutes and will add them when it shows up.', '', rec.note]);
        }
        continue;
      }
      let wrote = 0;
      for (const o of editable) {
        const customerNotes = withBlock(o.customerNotes, rec.note);
        const internalNotes = withBlock(o.internalNotes, rec.note);
        if (customerNotes === (o.customerNotes || '') && internalNotes === (o.internalNotes || '')) continue;
        const res = await ss.http().post('/orders/createorder', { ...o, advancedOptions: ss.postableOptions(o), customerNotes, internalNotes });
        if (!String(res.data.customerNotes || '').includes(OPEN)) throw new Error(`ShipStation didn't keep the notes on ${o.orderId}`);
        if (!rec.writtenTo.includes(o.orderId)) rec.writtenTo.push(o.orderId);
        wrote++;
      }
      if (wrote) { summary.written += wrote; rec.status = 'written'; rec.writtenAt = new Date().toISOString(); }
      else if (rec.status === 'pending' && !editable.length) {
        rec.status = 'missed';
        await notify(`[HB order details] ${id} shipped/cancelled before the details were added`, [
          `ShipStation order(s) for ${id} are ${orders.map((o) => o.orderStatus).join(', ')}, so Dash couldn't add the details. Check with Eric:`, '', rec.note]);
      } else if (rec.status === 'pending') { rec.status = 'written'; rec.writtenAt = rec.writtenAt || new Date().toISOString(); }
    } catch (e) {
      const msg = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
      summary.errors.push(`${id}: ${msg}`);
      rec.lastError = msg;
      if (e.response?.status === 429) break; // ShipStation rate limit: try the rest next run
    }
  }
  save(s);
  if (summary.checked) console.log('[hb-fnotes]', JSON.stringify(summary));
  return summary;
}

module.exports = { upsertNote, getNotes, runFulfillmentNotes, _withBlock: withBlock, _validate: validate };

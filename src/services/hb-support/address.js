// Bad shipping addresses (Alan, 10-20). ShipStation flags an order's address as
// "validation warning/failed"; Eric fixes the obvious typos himself, so an order still
// flagged after HB_ADDRESS_GRACE_HOURS is cancelled in ShipStation and the customer gets
// an email from Maggie asking for their full address. Their reply is parsed and the new
// address is emailed to Alan, who has Eric make a fresh label.
//
// Modes (address.mode, Alan emails "address: auto|approve|off"):
//   approve  Alan gets a numbered batch [HB-ADDR-n] and replies yes / skip 2 5 / only 1 3 / no
//   auto     cancel + email straight away, Alan gets an FYI
//   off      nothing runs
// Every order is re-read right before it is cancelled: if Eric fixed it (no longer flagged)
// or it shipped, it is left alone.

const store = require('./store');
const ghl = require('./ghl');
const coc = require('./coc');
const ss = require('./shipstation');
const { callTool } = require('./llm');

const GRACE_HOURS = () => Number(process.env.HB_ADDRESS_GRACE_HOURS || 24);
const PROPOSAL_GAP_MS = 3 * 3600 * 1000;
const tag = (id) => `HB-ADDR-${id}`;
const SIGNATURE = 'Happy baking!\nMaggie Bennett\nThe Happy Bakers';

let st = null;
const load = () => { st = store.load('address', null) || { mode: process.env.HB_ADDRESS_MODE || 'approve', nextBatch: 1, lastProposalAt: 0, orders: {}, batches: {} }; };
const save = () => store.save('address', st);

// ShipStation timestamps are Pacific wall-clock with no offset.
const ssTime = (s) => new Date(`${String(s).slice(0, 19)}-07:00`).getTime();
const firstName = (name) => String(name || '').trim().split(/\s+/)[0].replace(/^./, (c) => c.toUpperCase()) || 'there';
const addressLines = (a) => [a.name, a.street1, a.street2, a.street3, `${a.city}, ${a.state} ${a.postalCode}`].filter((x) => x && String(x).trim()).join('\n');
const oneLine = (a) => addressLines(a).split('\n').slice(1).join(', ');

function record(o) {
  const t = o.shipTo || {};
  return {
    ssOrderId: o.orderId, orderNumber: o.orderNumber, storeId: o.advancedOptions.storeId,
    email: String(o.customerEmail || '').trim().toLowerCase(), orderDate: o.orderDate, createDate: o.createDate,
    shipTo: { name: t.name, street1: t.street1, street2: t.street2, street3: t.street3, city: t.city, state: t.state, postalCode: t.postalCode, country: t.country, phone: t.phone },
    verified: t.addressVerified, status: 'found', firstSeenAt: new Date().toISOString(),
  };
}

// ─── customer outreach ───────────────────────────────────────────────────────
function askText(r) {
  return [
    `Hi ${firstName(r.shipTo.name)},`,
    "Thanks so much for your Happy Bakers order! When we went to pack it, the shipping address didn't come up as a deliverable address, and I don't want your package getting lost on the way.",
    `Here's what we have:\n${addressLines(r.shipTo)}`,
    "Could you reply with your full shipping address, including any apartment or unit number? If it's already right, just reply \"looks good\" and I'll send it as is.",
    "As soon as I hear from you, I'll get your order on its way.",
    SIGNATURE,
  ].join('\n\n');
}

async function cancelAndAsk(r) {
  const o = await ss.getOrder(r.ssOrderId);
  if (o.orderStatus !== 'awaiting_shipment' || !ss.badAddress(o)) {
    r.status = 'fixed'; r.fixedNote = o.orderStatus !== 'awaiting_shipment' ? `now ${o.orderStatus}` : 'address fixed in ShipStation';
    return r;
  }
  const date = new Date().toISOString().slice(0, 10);
  await ss.cancelOrder(r.ssOrderId, `${date} HB agent: cancelled for a bad address; customer emailed for a correction. Make a new label from the address Alan sends.`);
  r.cancelledAt = new Date().toISOString();
  const [first, ...rest] = String(r.shipTo.name || '').trim().split(/\s+/);
  r.contactId = await ghl.contactIdFor(r.email, first || 'Customer', rest.join(' '));
  r.askMessageId = await ghl.sendEmail({ contactId: r.contactId, to: r.email, fromName: 'Maggie Bennett', subject: 'Quick question about your Happy Bakers order', text: askText(r) });
  r.askSentAt = new Date().toISOString();
  r.status = 'awaiting_customer';
  return r;
}

async function actOn(recs) {
  const lines = [];
  for (const r of recs) {
    try {
      await cancelAndAsk(r);
      lines.push(r.status === 'fixed' ? `Skipped ${r.orderNumber} ${r.shipTo.name}: ${r.fixedNote}` : `Cancelled ${r.orderNumber} + emailed ${r.shipTo.name} <${r.email}>`);
    } catch (e) {
      r.status = 'failed'; r.error = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
      lines.push(`FAILED ${r.orderNumber} ${r.shipTo.name}: ${r.error}`);
    }
    save();
  }
  return lines;
}

// ─── scan (every support-agent run) ──────────────────────────────────────────
async function runAddressScan({ sendOwner }) {
  load();
  if (st.mode === 'off') return { mode: 'off' };
  const orders = (await ss.awaitingShipment()).filter(ss.isHb);
  const flagged = new Map(orders.filter(ss.badAddress).map((o) => [String(o.orderId), o]));
  for (const [id, o] of flagged) if (!st.orders[id]) st.orders[id] = record(o);
  // Eric fixed it (or it shipped) before we got to it.
  for (const [id, r] of Object.entries(st.orders)) if ((r.status === 'found' || r.status === 'proposed') && !flagged.has(id)) { r.status = 'fixed'; r.fixedNote = 'no longer flagged before we acted'; }
  // Alan already approved these; a ShipStation error gets two more tries on later runs.
  const retry = Object.values(st.orders).filter((r) => r.status === 'failed' && (r.tries || 1) < 3 && !r.cancelledAt);
  if (retry.length) {
    retry.forEach((r) => { r.tries = (r.tries || 1) + 1; });
    const lines = await actOn(retry);
    await sendOwner(`[${tag('RETRY')}] ${retry.length} bad-address order${retry.length > 1 ? 's' : ''} retried`, lines.join('\n'));
  }
  const cutoff = Date.now() - GRACE_HOURS() * 3600 * 1000;
  const due = Object.values(st.orders).filter((r) => r.status === 'found' && ssTime(r.createDate || r.orderDate) <= cutoff);
  const out = { flagged: flagged.size, due: due.length };

  if (due.length && st.mode === 'auto') {
    const lines = await actOn(due);
    await sendOwner(`[${tag('FYI')}] ${due.length} bad address${due.length > 1 ? 'es' : ''} handled`, `${lines.join('\n')}\n\nWhen they reply, I'll email you the corrected address.`);
    out.acted = lines;
  } else if (due.length && Date.now() - st.lastProposalAt >= PROPOSAL_GAP_MS) {
    const id = st.nextBatch++;
    st.batches[id] = { id, at: new Date().toISOString(), orderIds: due.map((r) => String(r.ssOrderId)), status: 'awaiting_owner' };
    due.forEach((r) => { r.status = 'proposed'; r.batchId = id; });
    st.lastProposalAt = Date.now();
    save();
    const list = due.map((r, i) => `${i + 1}. ${r.shipTo.name} <${r.email}>, order ${r.orderNumber} (${String(r.orderDate).slice(0, 10)})\n   ${oneLine(r.shipTo)}\n   ShipStation: ${r.verified}`);
    await sendOwner(`[${tag(id)}] ${due.length} bad address${due.length > 1 ? 'es' : ''}: cancel + email?`, [
      `These Happy Bakers orders are still flagged in ShipStation more than ${GRACE_HOURS()}h after they came in:`,
      list.join('\n\n'),
      'Reply "yes" to cancel all of them in ShipStation and send each customer the email below. Or "skip 2 5", "only 1 3", or "no".',
      'Each order is re-checked first: if Eric has fixed it or it shipped, I leave it alone.',
      `THE EMAIL (example for #1)\nSubject: Quick question about your Happy Bakers order\n\n${askText(due[0])}`,
    ].join('\n\n'));
    out.proposed = id;
  }
  save();
  return out;
}

// ─── Alan's answer to a batch ────────────────────────────────────────────────
const numbers = (s) => (s.match(/\d+/g) || []).map(Number);

async function handleOwner(msg, { sendOwner }) {
  const m = /HB-ADDR-(\d+)/i.exec(`${msg.subject} ${msg.text}`);
  const text = msg.text.trim();
  const modeCmd = /^\s*address:\s*(auto|approve|off)\b/i.exec(text);
  if (!m && !modeCmd) return null;
  load();
  if (!m) { st.mode = modeCmd[1].toLowerCase(); save(); return { addressMode: st.mode }; }
  const b = st.batches[m[1]];
  if (!b) return { ignored: `unknown address batch ${m[1]}` };
  const recs = b.orderIds.map((id) => st.orders[id]);
  let pick;
  const first = text.split('\n')[0];
  if (/^\s*(no|nope|don'?t|stop)\b/i.test(first)) pick = [];
  else if (/\bonly\b/i.test(first)) pick = numbers(first.replace(/HB-ADDR-\d+/gi, ''));
  else if (/\bskip\b|\bexcept\b/i.test(first)) { const s = new Set(numbers(first.replace(/HB-ADDR-\d+/gi, ''))); pick = recs.map((_, i) => i + 1).filter((n) => !s.has(n)); }
  else if (/^\s*(yes|yep|yeah|y|ok|okay|approve[d]?|do it|go( ahead)?|send( it| them)?|sounds good|looks good)\b/i.test(first)) pick = recs.map((_, i) => i + 1);
  else {
    await sendOwner(`Re: [${tag(b.id)}] didn't understand`, `I didn't recognise "${first.slice(0, 120)}". Reply "yes", "skip 2 5", "only 1 3" or "no".`);
    return { address: b.id, unclear: true };
  }
  const chosen = recs.filter((r, i) => pick.includes(i + 1) && r.status === 'proposed');
  recs.forEach((r, i) => { if (r.status === 'proposed' && !pick.includes(i + 1)) r.status = 'skipped'; });
  b.status = 'answered'; b.answer = text.slice(0, 300);
  save();
  const lines = await actOn(chosen);
  await sendOwner(`Re: [${tag(b.id)}] done`, `${lines.join('\n') || 'Nothing cancelled or sent.'}\n\nWhen they reply, I'll email you the corrected address.`);
  return { address: b.id, acted: lines.length };
}

// ─── the customer's reply ────────────────────────────────────────────────────
const EXTRACT_TOOL = {
  name: 'read_address_reply',
  description: "Read a customer's reply to our request for their correct shipping address.",
  input_schema: {
    type: 'object',
    required: ['kind', 'name', 'street1', 'street2', 'city', 'state', 'zip', 'other_request'],
    properties: {
      kind: { type: 'string', enum: ['new_address', 'confirms_existing', 'not_an_address'], description: 'new_address: they gave an address (even partial corrections, like adding an apt number, applied to the old one). confirms_existing: they say the address we have is right. not_an_address: anything else.' },
      name: { type: 'string' }, street1: { type: 'string' }, street2: { type: 'string', description: 'Apt/unit/suite, or empty' },
      city: { type: 'string' }, state: { type: 'string', description: '2-letter US state' }, zip: { type: 'string' },
      other_request: { type: 'string', description: 'Anything else they asked for (refund, cancel, question), or empty.' },
    },
  },
};

function pendingFor(email) {
  load();
  return Object.values(st.orders).filter((r) => r.email === String(email || '').toLowerCase() && r.status === 'awaiting_customer');
}

// Returns true when the reply was an address answer (handled here); false hands it to the
// normal support agent.
async function handleReply(batch, { sendOwner, replyAsMaggie }) {
  const recs = pendingFor(batch[batch.length - 1].from);
  if (!recs.length) return false;
  const r = recs[0];
  const said = batch.map((b) => b.text).join('\n\n');
  const x = await callTool({
    system: 'You read customer emails for a small US baking-products shop and extract shipping addresses exactly as written, fixing only obvious capitalisation. Never invent missing parts: leave a field empty if the customer did not give it and the old address does not supply it.',
    tool: EXTRACT_TOOL,
    prompt: `The address we had (flagged as undeliverable):\n${addressLines(r.shipTo)}\n\nThe customer's reply:\n${said}`,
  });
  if (x.kind === 'not_an_address') return false;
  const fresh = x.kind === 'confirms_existing' ? { ...r.shipTo } : { name: x.name || r.shipTo.name, street1: x.street1, street2: x.street2, city: x.city, state: x.state, postalCode: x.zip };
  r.reply = { at: batch[batch.length - 1].at, text: said.slice(0, 2000), kind: x.kind };
  r.newAddress = fresh; r.status = 'replied';
  save();

  let subs = '';
  try {
    const snap = await coc.snapshot(r.email);
    const live = snap.purchases.filter((p) => p.live);
    if (live.length) subs = `They have ${live.length} live subscription${live.length > 1 ? 's' : ''} (${live.map((p) => p.product).join('; ')}). Update the shipping address in CoC too, or the monthly shipments go to the old address.`;
  } catch (e) { subs = `(Couldn't check CoC subscriptions: ${e.message})`; }

  const others = recs.length > 1 ? `They also have ${recs.length - 1} other cancelled order(s) waiting on an address: ${recs.slice(1).map((o) => o.orderNumber).join(', ')}. The same address probably applies.` : '';
  await sendOwner(`[${tag('FIX')}] ${r.shipTo.name}: ${x.kind === 'confirms_existing' ? 'address confirmed as is' : 'new address'} for order ${r.orderNumber}`, [
    `NEW LABEL ADDRESS (order ${r.orderNumber}, cancelled in ShipStation)\n${addressLines(fresh)}${r.shipTo.phone ? `\n${r.shipTo.phone}` : ''}`,
    `OLD ADDRESS\n${addressLines(r.shipTo)}`,
    `WHAT THEY WROTE\n${said.slice(0, 1500)}`,
    x.other_request ? `THEY ALSO ASKED: ${x.other_request}\n(I haven't acted on that; handle it in GHL.)` : '',
    subs, others,
  ].filter(Boolean).join('\n\n'));

  await replyAsMaggie(r, [
    `Hi ${firstName(fresh.name)},`,
    x.kind === 'confirms_existing' ? 'Thank you for confirming! We\'ll ship to:' : 'Thank you! I\'ve got your address as:',
    addressLines(fresh),
    "I've passed it along so we can get your order on its way.",
    SIGNATURE,
  ].join('\n\n'), batch[batch.length - 1].id);
  r.ackSentAt = new Date().toISOString(); r.status = 'sent_to_owner';
  save();
  return true;
}

function addressStatus() {
  load();
  return { mode: st.mode, graceHours: GRACE_HOURS(), batches: st.batches, orders: Object.values(st.orders).map((r) => ({ order: r.orderNumber, name: r.shipTo.name, email: r.email, status: r.status, batch: r.batchId || null, askSentAt: r.askSentAt || null, newAddress: r.newAddress ? oneLine(r.newAddress) : null, note: r.fixedNote || r.error || null })) };
}

// Read-only preview of what the scan would find right now.
async function previewScan() {
  const orders = (await ss.awaitingShipment()).filter(ss.isHb).filter(ss.badAddress);
  const cutoff = Date.now() - GRACE_HOURS() * 3600 * 1000;
  return orders.map((o) => ({ order: o.orderNumber, name: o.shipTo.name, email: o.customerEmail, address: oneLine(o.shipTo), verified: o.shipTo.addressVerified, created: o.createDate, pastGrace: ssTime(o.createDate || o.orderDate) <= cutoff }));
}

module.exports = { runAddressScan, handleOwner, handleReply, addressStatus, previewScan, _EXTRACT_TOOL: EXTRACT_TOOL };

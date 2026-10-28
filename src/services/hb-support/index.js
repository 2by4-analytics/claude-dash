// Happy Bakers customer-service agent.
//
// Every 5 min: new inbound emails in the HB GHL location → look the customer up in
// Checkout Champ → Claude decides (rules + Alan's lessons) → either act and reply as
// Maggie, or email Alan a proposal and wait. Alan answers by replying to that email
// ("yes", or what to do instead); his answer is executed and, when it generalizes,
// saved as a lesson that goes into every future prompt.
//
// Modes (state.mode overrides HB_SUPPORT_MODE; Alan can switch by emailing
// "agent: auto" / "agent: approve" / "agent: off"):
//   approve  every case goes to Alan first (rollout default)
//   auto     clear cases are done straight away; Alan gets a short FYI; odd ones are asked
//   off      nothing runs
// Code-enforced limits regardless of what the model says: the agent never refunds on
// its own (Alan's rule 10-24: everything ships quickly); only Alan's answer can refund,
// and only the customer's own COMPLETE orders. Cancels only on that customer's live purchases.

const store = require('./store');
const ghl = require('./ghl');
const coc = require('./coc');
const { callTool } = require('./llm');
const prompt = require('./prompt');
const address = require('./address');
const inventory = require('../hb-inventory');

const OWNER = () => (process.env.HB_SUPPORT_ALAN_EMAIL || 'alan@2by4llc.com').toLowerCase();
const OUR_ADDRESSES = /@(mg\.)?happybakerhq\.com$/i;
// Automated senders are never customers: dropped before Claude or a case (Alan 10-22, after TestFlight spam made
// HB-CS-12/27/28). Not mailer-daemon/postmaster: a bounce of one of our replies should still reach Alan.
const AUTOMATED_SENDERS = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|notifications?)@|^testflight[^@]*@|@email\.apple\.com$/i;
const AUTO_REFUND_MAX = () => Number(process.env.HB_SUPPORT_AUTO_REFUND_MAX || 75);
const tag = (id) => `HB-CS-${id}`;
const money = (n) => `$${Number(n || 0).toFixed(2)}`;
// Forwarding can SRS-rewrite the sender (SRS0=hash=tt=2by4llc.com=alan@happybakerhq.com),
// which looked like our own address, so Alan's HB-CS-6 answer was skipped (10-18).
const unSrs = (a) => { const m = /^srs[01]=[^=]+=[^=]+=([^=]+)=([^@]+)@/i.exec(a); return m ? `${m[2]}@${m[1]}` : a; };
const addr = (from) => unSrs((String(from).match(/<([^>]+)>/) || [null, from])[1].trim().toLowerCase());
const displayName = (from) => String(from).replace(/<[^>]*>/, '').replace(/"/g, '').trim();

let state = null, cases = null, lessons = null;
function loadAll() {
  state = store.load('state', null);
  cases = store.load('cases', {});
  lessons = store.load('lessons', []);
}
// Ids stay unique after a rule is deleted.
const nextLessonId = () => lessons.reduce((max, l) => Math.max(max, l.id || 0), 0) + 1;
function saveAll() { store.save('state', state); store.save('cases', cases); store.save('lessons', lessons); }
const mode = () => (state && state.mode) || process.env.HB_SUPPORT_MODE || 'approve';

// Customers often write from one address and ordered with another (Lorretta 10-24:
// wrote from fuesting57@, ordered as lorretta57@, and the agent could only ask Alan).
// Look up any other address they give in their messages and merge those orders in,
// flagged, so Alan can see them. Orders from an address someone merely typed are never
// auto-handled (anyone can name an email), see planFor.
async function accountFor(email, texts) {
  const snap = await coc.snapshot(email);
  const others = [...new Set((texts.join('\n').match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) || []).map((x) => x.toLowerCase()))]
    .filter((x) => x !== email.toLowerCase() && x !== OWNER() && !OUR_ADDRESSES.test(x) && !AUTOMATED_SENDERS.test(x)).slice(0, 3);
  snap.altEmails = [];
  for (const alt of others) {
    const s = await coc.snapshot(alt);
    if (!s.orders.length) continue;
    snap.altEmails.push(alt);
    snap.orders.push(...s.orders.map((o) => ({ ...o, email: alt })));
    snap.purchases.push(...s.purchases);
    snap.customerIds.push(...s.customerIds.filter((id) => !snap.customerIds.includes(id)));
    snap.name = snap.name || s.name;
  }
  return snap;
}

// ─── account formatting (for prompts and for Alan) ──────────────────────────
function describeAccount(snap) {
  if (!snap.orders.length) return `No Checkout Champ orders for ${snap.email}.`;
  const lines = [];
  if ((snap.altEmails || []).length) lines.push(`Orders marked (other email) are under ${snap.altEmails.join(', ')}, an address they gave in their message, not the one they wrote from. On the site they must sign in / create their account with that address.`);
  for (const o of snap.orders) {
    const ship = o.shipped ? 'SHIPPED' : `not shipped (${o.fulfillments.map((f) => f.status).join(', ') || 'digital/no fulfillment'})`;
    lines.push(`Order ${o.orderId}${o.email ? ` (other email ${o.email})` : ''} · ${o.date} · ${o.type} · ${o.status} · ${money(o.total)} (refundable ${money(o.refundRemaining)}) · ${o.card || 'card ?'} · ${ship}`);
    for (const i of o.items) lines.push(`  - [${i.productId}] ${i.name} ${money(i.price)}${i.shipping ? ` + ${money(i.shipping)} s&h` : ''}${i.purchaseId ? ` · subscription ${i.purchaseId} ${i.purchaseStatus}${i.nextBillDate ? ` next bill ${i.nextBillDate}` : ''}` : ''}`);
  }
  const subs = snap.purchases;
  lines.push(subs.length ? 'Subscriptions:' : 'Subscriptions: none');
  for (const p of subs) lines.push(`  - ${p.purchaseId} ${p.product} · ${p.status} · ${money(p.price)}/cycle · cycle ${p.cycle} · billed ${money(p.totalBilled)}${p.nextBillDate ? ` · next bill ${p.nextBillDate}` : ''}`);
  return lines.join('\n');
}

function describePlan(plan, snap) {
  const byId = new Map(snap.orders.map((o) => [o.orderId, o]));
  const parts = plan.actions.map((a) => {
    if (a.type === 'refund_order') return `Full refund + cancel order ${a.order_id} (${money(byId.get(a.order_id)?.refundRemaining)})`;
    if (a.type === 'partial_refund') return `Refund ${money(a.amount)} on order ${a.order_id}`;
    if (a.type === 'change_tee_size') return `Change tee to size ${a.size}: subscription ${a.purchase_id} + any unshipped tee`;
    return `Cancel subscription ${a.purchase_id}`;
  });
  if (plan.stopEmails) parts.push('Stop all emails to them (GHL email DND)');
  if (!parts.length) parts.push(plan.action === 'no_reply' ? 'Nothing (no reply needed)' : 'No account changes');
  return parts.join('\n');
}

// ─── policy: turn the model's decision into concrete, checked actions ───────
function planFor(decision, snap) {
  const orders = new Map(snap.orders.map((o) => [o.orderId, o]));
  const purchases = new Map(snap.purchases.map((p) => [p.purchaseId, p]));
  const problems = [];
  const actions = [];
  let action = decision.action;

  if (action === 'refund_unshipped' || decision.order_ids.length) {
    problems.push('the agent never refunds; refunds are owner-only');
  } else if (action === 'cancel_subscriptions') {
    for (const id of decision.purchase_ids) {
      const p = purchases.get(id);
      if (!p) problems.push(`subscription ${id} is not on this customer's account`);
      else if (!p.live) problems.push(`subscription ${id} is already ${p.status}`);
      else actions.push({ type: 'cancel_purchase', purchase_id: id });
    }
    if (!decision.purchase_ids.length) problems.push('no live subscription named to cancel');
  } else if (action === 'change_tee_size') {
    const size = decision.tee_size;
    const ids = decision.purchase_ids.length ? decision.purchase_ids : snap.purchases.filter((p) => p.live && coc.TEE_PRODUCT_IDS.has(p.productId)).map((p) => p.purchaseId);
    if (!coc.TEE_SIZES[size]) problems.push('no tee size named');
    else if (!ids.length) problems.push('no tee subscription on this account');
    for (const id of ids) {
      const p = purchases.get(id);
      if (!p) problems.push(`subscription ${id} is not on this customer's account`);
      else if (!coc.TEE_PRODUCT_IDS.has(p.productId)) problems.push(`subscription ${id} is not a tee`);
      else if (coc.TEE_SIZES[size]) actions.push({ type: 'change_tee_size', purchase_id: id, size });
    }
  }

  if (problems.length) action = 'escalate';
  const refundTotal = actions.filter((a) => a.type === 'refund_order').reduce((s, a) => s + orders.get(a.order_id).refundRemaining, 0);
  const autoOk = action !== 'escalate' && Number(decision.confidence) >= 0.75 && refundTotal <= AUTO_REFUND_MAX() && !(snap.altEmails || []).length;
  return { action, actions: action === 'escalate' ? [] : actions, proposedActions: actions, problems, refundTotal, autoOk, stopEmails: !!decision.stop_emails };
}

// Owner-directed actions: same ownership checks, but shipped orders are allowed.
function checkOwnerActions(list, snap) {
  const orders = new Map(snap.orders.map((o) => [o.orderId, o]));
  const purchases = new Map(snap.purchases.map((p) => [p.purchaseId, p]));
  const ok = [], problems = [];
  for (const a of list || []) {
    if (a.type === 'refund_order' || a.type === 'partial_refund') {
      const o = orders.get(a.order_id);
      if (!o) problems.push(`order ${a.order_id} is not on this customer's account`);
      else if (o.refundRemaining <= 0) problems.push(`order ${a.order_id} has nothing left to refund`);
      else if (a.type === 'partial_refund' && !(a.amount > 0 && a.amount <= o.refundRemaining)) problems.push(`refund ${money(a.amount)} on ${a.order_id} is more than the ${money(o.refundRemaining)} left`);
      else ok.push(a);
    } else if (a.type === 'cancel_purchase') {
      const p = purchases.get(a.purchase_id);
      if (!p) problems.push(`subscription ${a.purchase_id} is not on this customer's account`);
      else if (p.live) ok.push(a);
    } else if (a.type === 'change_tee_size') {
      const p = purchases.get(a.purchase_id);
      if (!p) problems.push(`subscription ${a.purchase_id} is not on this customer's account`);
      else if (!coc.TEE_PRODUCT_IDS.has(p.productId)) problems.push(`subscription ${a.purchase_id} is not a tee`);
      else if (!coc.TEE_SIZES[a.size]) problems.push(`unknown tee size ${a.size}`);
      else ok.push(a);
    }
  }
  return { ok, problems };
}

async function execute(c, actions) {
  c.executed = c.executed || [];
  const reason = `Customer request (${tag(c.id)})`;
  const results = [];
  for (const a of actions) {
    const key = `${a.type}:${a.order_id || a.purchase_id}:${a.amount || a.size || ''}`;
    if (c.executed.some((e) => e.key === key && e.ok)) continue;
    let ok = true, message;
    try {
      if (a.type === 'refund_order') message = await coc.refundOrder(a.order_id, reason);
      else if (a.type === 'partial_refund') message = await coc.partialRefund(a.order_id, a.amount, reason);
      else if (a.type === 'change_tee_size') message = await coc.changeTeeSize(a.purchase_id, a.size, unshippedTees(c.snapshot, a.purchase_id, a.size));
      else message = await coc.cancelPurchase(a.purchase_id, reason);
    } catch (e) {
      message = e.message;
      // Cancelling the order can already have cancelled its subscriptions.
      ok = a.type === 'cancel_purchase' && /already|cancel/i.test(message);
    }
    const r = { key, ...a, ok, message, at: new Date().toISOString() };
    c.executed.push(r); results.push(r);
  }
  const done = results.filter((r) => r.ok).map((r) => (r.type === 'cancel_purchase' ? `cancelled subscription ${r.purchase_id}`
    : r.type === 'change_tee_size' ? `tee size → ${r.size} (${r.message})`
    : `${r.type === 'partial_refund' ? `refunded ${money(r.amount)} on` : 'refunded + cancelled'} order ${r.order_id}`));
  for (const customerId of (c.snapshot.customerIds || []).slice(0, 1)) {
    if (done.length) await coc.addNote(customerId, `HB support agent ${tag(c.id)}: ${done.join('; ')}.`).catch((e) => console.warn('[hb-support] note failed:', e.message));
  }
  return results;
}

// The tee items of this subscription still sitting in an unshipped fulfillment, minus any
// already on the target size.
function unshippedTees(snap, purchaseId, size) {
  const sku = coc.TEE_SIZES[size] && coc.TEE_SIZES[size].sku;
  const out = [];
  for (const o of snap.orders) {
    for (const f of o.fulfillments) {
      if (coc.SHIPPED.test(String(f.status || '')) || f.tracking || f.dateShipped || /CANCEL/i.test(String(f.status || ''))) continue;
      for (const i of f.items) {
        if ((i.purchaseId === purchaseId || coc.TEE_PRODUCT_IDS.has(i.productId)) && i.sku !== sku) out.push({ fulfillmentId: f.id, id: i.id, status: String(f.status || '') });
      }
    }
  }
  return out;
}

// A reply must not tell the customer something was done unless an action did it. HB-CS-68
// (10-25): "I've updated your tee to a Medium" went out after Alan's "yes" with no action
// behind it (the agent had none for sizes), so the size never changed. Each first-person
// "I've …" sentence is checked against the action types that can back its verb.
const CLAIMS = [
  [/\b(updat|chang|switch|swapp|correct|fix|replac)ed\b/i, ['change_tee_size']],
  [/\brefund(ed)?\b/i, ['refund_order', 'partial_refund']],
  [/\bcancel+ed\b/i, ['cancel_purchase', 'refund_order']],
];
function unbackedClaims(reply, actions, snap) {
  const types = new Set((actions || []).map((a) => a.type));
  // "We have canceled all future shipments" is true when nothing live is left to cancel.
  if (snap && !snap.purchases.some((p) => p.live)) types.add('cancel_purchase');
  const out = [];
  for (const sentence of String(reply || '').split(/(?<=[.!?])\s+|\n+/)) {
    if (!/\b(I'?ve|I have|I just|we'?ve|we have)\b/i.test(sentence)) continue;
    for (const [re, backers] of CLAIMS) if (re.test(sentence) && !backers.some((t) => types.has(t))) { out.push(sentence.trim()); break; }
  }
  return out;
}
const doneActions = (c) => (c.executed || []).filter((e) => e.ok);

async function replyToCustomer(c, text) {
  const subject = /^re:/i.test(c.subject) ? c.subject : `Re: ${c.subject || 'Your Happy Bakers order'}`;
  c.replyMessageId = await ghl.sendEmail({ contactId: c.contactId, conversationId: c.conversationId, to: c.email, fromName: 'Maggie Bennett', subject, text, replyMessageId: c.inboundMessageId });
  c.replySentAt = new Date().toISOString();
  c.replyText = text;
}

// After the reply: email DND would block it.
async function stopEmails(c) {
  if (c.emailsStoppedAt || !c.contactId) return false;
  await ghl.stopEmails(c.contactId, `Customer asked to stop emails (${tag(c.id)})`);
  c.emailsStoppedAt = new Date().toISOString();
  return true;
}

async function emailOwner(c, subjectTail, text) {
  if (!state.ownerContactId) { state.ownerContactId = await ghl.contactIdFor(OWNER()); }
  await ghl.sendEmail({ contactId: state.ownerContactId, to: OWNER(), fromName: 'HB Support Agent', subject: `[${tag(c.id)}] ${subjectTail}`, text });
}

async function sendOwner(subject, text) {
  if (!state.ownerContactId) { state.ownerContactId = await ghl.contactIdFor(OWNER()); }
  await ghl.sendEmail({ contactId: state.ownerContactId, to: OWNER(), fromName: 'HB Support Agent', subject, text });
}

// Helpers the bad-address flow (address.js) uses to email Alan and answer the customer.
const addressHelpers = (conv) => ({
  sendOwner,
  replyAsMaggie: (r, text, replyMessageId) => ghl.sendEmail({ contactId: r.contactId || conv.contactId, conversationId: conv && conv.id, to: r.email, fromName: 'Maggie Bennett', subject: 'Re: Quick question about your Happy Bakers order', text, replyMessageId }),
});

const customerBlock = (c) => `${c.name || c.email} <${c.email}> wrote ("${c.subject}"):\n\n${c.messages.map((m) => m.text).join('\n\n— next message —\n\n')}`;

function proposalEmail(c) {
  const p = c.plan, d = c.decision;
  const ask = p.action === 'escalate'
    ? `MY QUESTION\n${d.question_for_owner || 'How should I handle this one?'}${p.problems.length ? `\n(Checks that stopped me: ${p.problems.join('; ')}.)` : ''}`
    : 'Reply "yes" to do exactly this, or tell me what to do instead.';
  return [
    customerBlock(c),
    `THEIR ACCOUNT\n${describeAccount(c.snapshot)}`,
    `WHAT I'D DO (${p.action === 'escalate' ? 'suggestion' : p.action})\n${describePlan({ ...p, actions: p.proposedActions }, c.snapshot)}`,
    `REPLY I'D SEND AS MAGGIE\n${d.reply || '(no reply)'}`,
    ...(() => {
      const claims = unbackedClaims(d.reply, p.proposedActions, c.snapshot);
      return claims.length ? [`WARNING: this reply says "${claims.join(' / ')}", but none of my actions does that, so it would be false. Saying "yes" will not make that change. Make it by hand first, or tell me what to do.`] : [];
    })(),
    ask,
    'Anything you tell me that applies beyond this customer becomes a rule for next time.',
    `GHL conversation: ${ghl.link(c.conversationId)}`,
  ].join('\n\n');
}

// ─── customer emails ─────────────────────────────────────────────────────────
async function decide(c) {
  const priorCases = Object.values(cases).filter((x) => x.email === c.email && x.id !== c.id).slice(-3)
    .map((x) => `${tag(x.id)} (${x.createdAt.slice(0, 10)}): ${x.decision?.summary || ''} → ${x.status}${x.ownerAnswer ? `; owner said: ${x.ownerAnswer}` : ''}`);
  const text = [
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    customerBlock(c),
    `THEIR CHECKOUT CHAMP ACCOUNT\n${describeAccount(c.snapshot)}`,
    priorCases.length ? `EARLIER CASES FOR THIS CUSTOMER\n${priorCases.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return callTool({ system: prompt.system(lessons), tool: prompt.DECIDE_TOOL, prompt: text });
}

async function handleCustomer(conv, batch, { dryRun }) {
  const last = batch[batch.length - 1];
  const open = Object.values(cases).find((x) => x.conversationId === conv.id && x.status === 'awaiting_owner');
  if (open && !dryRun) {
    open.messages.push(...batch.map((b) => ({ id: b.id, at: b.at, text: b.text })));
    open.inboundMessageId = last.id;
    await emailOwner(open, `${open.name || open.email} wrote again`, `${customerBlock({ ...open, messages: batch })}\n\nStill waiting on your answer to ${tag(open.id)} — reply to the original email or this one.`);
    return { case: open.id, followUp: true };
  }

  const snapshot = await accountFor(last.from, batch.map((b) => b.text));
  const c = {
    id: dryRun ? 0 : state.nextId++, status: 'new', createdAt: new Date().toISOString(),
    conversationId: conv.id, contactId: conv.contactId, email: last.from,
    name: snapshot.name || last.fromName || conv.fullName || '', subject: last.subject,
    inboundMessageId: last.id, messages: batch.map((b) => ({ id: b.id, at: b.at, text: b.text })), snapshot,
  };
  c.decision = await decide(c);
  c.plan = planFor(c.decision, snapshot);
  if (dryRun) return c;
  cases[c.id] = c;

  if (mode() === 'auto' && (c.plan.autoOk || c.plan.action === 'no_reply')) {
    if (c.plan.action === 'no_reply') { c.status = 'done'; return c; }
    c.results = await execute(c, c.plan.actions);
    const failed = c.results.filter((r) => !r.ok);
    if (failed.length) {
      c.status = 'awaiting_owner';
      await emailOwner(c, `Problem: ${c.decision.summary}`, `I tried to handle this and Checkout Champ refused part of it:\n${failed.map((f) => `${f.type} ${f.order_id || f.purchase_id}: ${f.message}`).join('\n')}\n\nNo reply has gone to the customer yet. Tell me what to do.\n\n${proposalEmail(c)}`);
      return c;
    }
    const claims = unbackedClaims(c.decision.reply, doneActions(c), c.snapshot);
    if (claims.length) {
      c.status = 'awaiting_owner';
      await emailOwner(c, `Held: ${c.decision.summary}`, `I didn't send my reply: it says "${claims.join(' / ')}", but nothing I did makes that true.\n\n${proposalEmail(c)}`);
      return c;
    }
    await replyToCustomer(c, c.decision.reply);
    if (c.plan.stopEmails) await stopEmails(c);
    c.status = 'done';
    await emailOwner(c, `Done: ${c.decision.summary}`, `Handled automatically.\n\n${describePlan(c.plan, snapshot)}\n\nReply sent as Maggie:\n${c.decision.reply}\n\nIf this was wrong, reply and tell me what to do; I'll fix it and remember.\n\n${customerBlock(c)}\n\nGHL conversation: ${ghl.link(c.conversationId)}`);
    return c;
  }

  c.status = 'awaiting_owner';
  const prefix = c.plan.action === 'escalate' ? 'Question' : 'Approve?';
  await emailOwner(c, `${prefix}: ${c.decision.summary}`, proposalEmail(c));
  return c;
}

// ─── Alan's emails ───────────────────────────────────────────────────────────
const PLAIN_YES = /^\s*(yes|yep|yeah|y|ok|okay|approve[d]?|do it|go( ahead)?|send( it)?|sounds good|looks good|perfect|👍)[\s.!]*$/i;

async function handleOwner(msg) {
  const text = msg.text.trim();
  const m = /HB-CS-(\d+)/i.exec(`${msg.subject} ${text}`);
  if (!m) {
    const modeCmd = /^\s*agent:\s*(auto|approve|off)\b/i.exec(text);
    if (modeCmd) { state.mode = modeCmd[1].toLowerCase(); return { mode: state.mode }; }
    // "rule 9: <new text>" replaces lesson 9, "rule 9: delete" removes it.
    const edit = /^\s*(?:rule|lesson)\s+#?(\d+)\s*:\s*([\s\S]+)/i.exec(text);
    if (edit) {
      const i = lessons.findIndex((l) => l.id === Number(edit[1]));
      if (i < 0) return { ignored: `unknown rule ${edit[1]}` };
      if (/^delete\b/i.test(edit[2].trim())) { lessons.splice(i, 1); return { lessonDeleted: Number(edit[1]) }; }
      lessons[i] = { ...lessons[i], text: edit[2].trim(), editedAt: new Date().toISOString() };
      return { lessonEdited: Number(edit[1]) };
    }
    const rule = /^\s*(rule|lesson)\s*:\s*([\s\S]+)/i.exec(text);
    if (rule) { lessons.push({ id: nextLessonId(), at: new Date().toISOString(), text: rule[2].trim(), caseId: null }); return { lesson: true }; }
    return { ignored: 'no case tag' };
  }
  const c = cases[m[1]];
  if (!c) return { ignored: `unknown case ${m[1]}` };
  c.ownerAnswers = [...(c.ownerAnswers || []), { at: msg.at, text }];
  c.ownerAnswer = text;
  c.snapshot = await accountFor(c.email, c.messages.map((x) => x.text));

  // A reply held for a by-hand change (waiting_on_owner, or a held unbacked claim): the
  // owner's "done" / "yes" means he made the change, so send it as is. HB-CS-116 (10-28):
  // "Link it then reply" closed the case with nothing done and the reply never sent.
  const DONE_BY_HAND = /^\s*(done|fixed|linked|did it|all set|it'?s done|i did it|handled)[\s.!]*(send( it)?)?[\s.!]*$/i;
  let out, manual = false;
  if (c.heldReply && (PLAIN_YES.test(text) || DONE_BY_HAND.test(text))) {
    out = { actions: [], send_reply: true, reply: c.heldReply, stop_emails: false, lesson: null, confirmation: 'You made the change by hand, so I sent the reply I was holding.' };
    manual = true;
  } else if (PLAIN_YES.test(text) && c.plan.action !== 'escalate') {
    out = { actions: c.plan.proposedActions, send_reply: c.plan.action !== 'no_reply', reply: c.decision.reply, stop_emails: c.plan.stopEmails, lesson: null, confirmation: 'Doing exactly what I proposed.' };
  } else {
    out = await callTool({
      system: prompt.system(lessons), tool: prompt.ANSWER_TOOL,
      prompt: [
        customerBlock(c),
        `THEIR CHECKOUT CHAMP ACCOUNT (current)\n${describeAccount(c.snapshot)}`,
        `WHAT YOU PROPOSED\nAction: ${c.plan.action}\n${describePlan({ ...c.plan, actions: c.plan.proposedActions }, c.snapshot)}\nReply: ${c.decision.reply}\n${c.decision.question_for_owner ? `Your question: ${c.decision.question_for_owner}` : ''}`,
        c.heldReply ? `YOU ARE WAITING ON THE OWNER: ${c.waitingFor || 'a change made by hand'}\nReply you are holding until then: ${c.heldReply}\nIf the owner says it's done, send that reply (adjust only if he asks).` : '',
        c.status === 'done' ? `THIS CASE WAS ALREADY HANDLED: ${(c.executed || []).filter((e) => e.ok).map((e) => e.key).join(', ') || 'no account changes'}; reply sent: ${c.replySentAt ? 'yes' : 'no'}; emails stopped: ${c.emailsStoppedAt ? 'yes' : 'no'}. The owner is correcting it — only list ADDITIONAL actions, and only reply if the customer needs to hear something new.` : '',
        `THE OWNER'S ANSWER (this is authoritative)\n${text}`,
      ].filter(Boolean).join('\n\n'),
    });
  }

  const { ok, problems } = checkOwnerActions(out.actions, c.snapshot);
  const results = await execute(c, ok);
  const failed = results.filter((r) => !r.ok);
  const claims = out.send_reply && out.reply && !manual ? unbackedClaims(out.reply, doneActions(c), c.snapshot) : [];
  const held = claims.length > 0;
  // Nothing done and nothing sent, but the owner's ask isn't finished: a by-hand step the
  // agent has no action for, or every action it tried was skipped by the checks.
  const waiting = !failed.length && !held && !out.send_reply && !!out.reply && (out.waiting_on_owner || (problems.length > 0 && !results.length));
  if (out.send_reply && out.reply && !failed.length && !held) await replyToCustomer(c, out.reply);
  const stopped = out.stop_emails && !failed.length && await stopEmails(c);
  if (out.lesson) lessons.push({ id: nextLessonId(), at: new Date().toISOString(), text: out.lesson, caseId: c.id });
  if (held || waiting) { c.heldReply = out.reply; c.waitingFor = out.confirmation; } else if (c.replySentAt && out.send_reply) { delete c.heldReply; delete c.waitingFor; }
  c.status = failed.length || held || waiting ? 'awaiting_owner' : 'done';

  const lines = [out.confirmation];
  if (held) lines.push(`I did NOT send the reply: it says "${claims.join(' / ')}", but nothing I did makes that true. Make the change by hand and reply "done", and I'll send it. Or tell me what to do instead.`);
  if (waiting) lines.push(`This case stays open. When the change is made, reply "done" and I'll send this reply:\n${out.reply}`);
  for (const r of results) lines.push(`${r.ok ? 'Done' : 'FAILED'}: ${r.type} ${r.order_id || r.purchase_id}${r.amount ? ` ${money(r.amount)}` : ''}${r.size ? ` → ${r.size}` : ''}${r.ok && r.type !== 'change_tee_size' ? '' : ` (${r.message})`}`);
  if (stopped) lines.push('Done: stopped all emails to them (GHL email DND)');
  if (problems.length) lines.push(`Skipped: ${problems.join('; ')}`);
  lines.push(out.send_reply && !failed.length && !held ? `Reply sent to ${c.email}:\n${out.reply}` : failed.length ? 'No reply sent because something failed. Tell me how to proceed.' : held ? `Held reply:\n${out.reply}` : waiting ? null : 'No reply sent.');
  if (out.lesson) lines.push(`Saved as a rule for next time: ${out.lesson}`);
  await emailOwner(c, `${failed.length || held ? 'Problem' : waiting ? 'Waiting on you' : 'Done'}: ${c.decision.summary}`, lines.filter(Boolean).join('\n\n'));
  return { case: c.id, status: c.status };
}

// ─── poll loop ───────────────────────────────────────────────────────────────
let running = false;
let lastRun = null;

// GHL groups an email thread into ONE conversation message whose meta.email.messageIds
// lists every email in it (ours and theirs) and whose dateAdded is the latest one. So each
// email id is checked on its own and `seen` is keyed by email id: a customer's reply is
// the 2nd id under our outbound reply, not the 1st (missed Carol's reply 10-18).
// Returned `id` = the email id (dedup + reply target: replyMessageId must be an EMAIL id,
// a conversation message id 404s — Benitta 10-18); `threadId` = the conversation message.
async function inboundEmails(conv, since, seen) {
  const msgs = await ghl.getMessages(conv.id);
  const fresh = msgs.filter((m) => new Date(m.dateAdded).getTime() >= since)
    .sort((a, b) => new Date(a.dateAdded) - new Date(b.dateAdded));
  const out = [];
  for (const m of fresh) {
    if (m.messageType !== 'TYPE_EMAIL') {
      if (m.direction === 'inbound' && !seen.has(m.id)) out.push({ id: m.id, threadId: m.id, at: m.dateAdded, type: m.messageType, from: '', text: String(m.body || '').trim(), subject: '' });
      continue;
    }
    const ids = (m.meta && m.meta.email && m.meta.email.messageIds) || [m.id];
    for (const emailId of ids) {
      if (seen.has(emailId)) continue;
      const e = await ghl.emailMessage(emailId);
      const at = e.at || m.dateAdded;
      const from = addr(e.from);
      if (e.direction === 'outbound' || OUR_ADDRESSES.test(from) || new Date(at).getTime() < since) { seen.add(emailId); continue; }
      out.push({ id: emailId, threadId: m.id, at, type: 'TYPE_EMAIL', from, fromName: displayName(e.from), subject: e.subject, text: e.text.slice(0, 6000), html: e.html, attachments: e.attachments.length });
    }
  }
  return out.sort((a, b) => new Date(a.at) - new Date(b.at));
}

async function runHbSupport() {
  if (running) return { skipped: 'already running' };
  running = true;
  const startedAt = Date.now();
  const summary = { at: new Date(startedAt).toISOString(), conversations: 0, customer: 0, owner: 0, errors: [] };
  try {
    loadAll();
    if (!state) {
      // First run: start from now; earlier mail was handled by hand.
      state = { watermark: startedAt, seen: [], nextId: 1, failures: {} };
      saveAll();
      return (lastRun = { ...summary, initialized: true });
    }
    if (mode() === 'off') return (lastRun = { ...summary, mode: 'off' });
    const since = state.watermark - 10 * 60 * 1000;
    const seen = new Set(state.seen);
    let holdBack = Infinity; // oldest message an outage made us skip; the watermark waits for it
    const convs = await ghl.recentConversations(since);
    summary.conversations = convs.length;
    for (const conv of convs) {
      let msgs = [];
      try {
        msgs = await inboundEmails(conv, since, seen);
        if (!msgs.length) continue;
        const ownerMsgs = msgs.filter((x) => x.from === OWNER());
        const custMsgs = msgs.filter((x) => x.from !== OWNER() && !OUR_ADDRESSES.test(x.from) && !AUTOMATED_SENDERS.test(x.from));
        msgs.filter((x) => AUTOMATED_SENDERS.test(x.from)).forEach((x) => console.log('[hb-support] ignored automated sender', x.from, x.subject || ''));
        // Each handled message is marked seen right away: if a later one in the same
        // conversation throws, a retry must not redo (and re-email) the earlier ones.
        // All owner answers share ONE conversation (Debora got her reply twice, 10-24).
        for (const om of ownerMsgs) { if (!(await inventory.handleOwner(om)) && !(await address.handleOwner(om, addressHelpers(conv)))) await handleOwner(om); seen.add(om.id); summary.owner++; }
        const email = custMsgs.filter((x) => x.type === 'TYPE_EMAIL' && x.from);
        const other = custMsgs.filter((x) => x.type !== 'TYPE_EMAIL');
        if (email.length) {
          if (!(await address.handleReply(email, addressHelpers(conv)))) await handleCustomer(conv, email, { dryRun: false });
          email.forEach((x) => seen.add(x.id));
          summary.customer++;
        }
        if (other.length) {
          const c = { id: state.nextId++, status: 'awaiting_owner', createdAt: new Date().toISOString(), conversationId: conv.id, contactId: conv.contactId, email: conv.email || '', name: conv.fullName || '', subject: '(non-email message)', messages: other.map((o) => ({ id: o.id, at: o.at, text: o.text })), decision: { summary: `${other[0].type.replace('TYPE_', '')} message` }, plan: { action: 'escalate', proposedActions: [], problems: [] } };
          cases[c.id] = c;
          await emailOwner(c, `${c.name || 'Customer'} sent a ${other[0].type.replace('TYPE_', '').toLowerCase()} message`, `${customerBlock(c)}\n\nI only answer email, so please reply to this one in GHL yourself.\n\nGHL conversation: ${ghl.link(conv.id)}`);
        }
        msgs.forEach((x) => seen.add(x.id));
      } catch (e) {
        const detail = e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message;
        console.error('[hb-support] conversation', conv.id, detail);
        summary.errors.push(`${conv.id}: ${detail}`);
        // Retry on the next run; after 3 tries, hand it to Alan and move on. Outages
        // (CoC/GHL 5xx, 429, timeouts) don't count: on 10-24 a 90-min CoC outage burned
        // Alan's six answers into "I couldn't handle" cases (#53-58) instead of waiting.
        const status = e.response && e.response.status;
        if (status === 429 || status >= 500 || (!e.response && /timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket hang up/i.test(`${e.code} ${e.message}`))) {
          if (!msgs.length) holdBack = Math.min(holdBack, state.watermark); // the fetch itself failed
          for (const x of msgs) if (!seen.has(x.id)) holdBack = Math.min(holdBack, new Date(x.at).getTime());
          continue;
        }
        for (const x of msgs.filter((m) => !seen.has(m.id))) {
          state.failures[x.id] = (state.failures[x.id] || 0) + 1;
          if (state.failures[x.id] >= 3) {
            seen.add(x.id); delete state.failures[x.id];
            const c = { id: state.nextId++, status: 'awaiting_owner', createdAt: new Date().toISOString(), conversationId: conv.id, contactId: conv.contactId, email: x.from, name: x.fromName || '', subject: x.subject || '', messages: [{ id: x.id, at: x.at, text: x.text }], decision: { summary: 'agent error' }, plan: { action: 'escalate', proposedActions: [], problems: [] } };
            cases[c.id] = c;
            await emailOwner(c, `I couldn't handle a message from ${x.from || 'a customer'}`, `${customerBlock(c)}\n\nError: ${detail}\n\nPlease handle this one in GHL.\n\nGHL conversation: ${ghl.link(conv.id)}`).catch(() => {});
          }
        }
      } finally {
        saveAll();
      }
    }
    state.watermark = Math.min(startedAt, holdBack);
    state.seen = [...seen].slice(-3000);
    saveAll();
    if (process.env.SHIPSTATION_API_KEY) {
      try { summary.address = await address.runAddressScan({ sendOwner }); }
      catch (e) { summary.errors.push(`address scan: ${e.response ? `${e.response.status} ${JSON.stringify(e.response.data).slice(0, 200)}` : e.message}`); }
      saveAll();
    }
    summary.ms = Date.now() - startedAt;
    if (summary.customer || summary.owner || summary.errors.length) console.log('[hb-support] run', JSON.stringify({ ...summary, errors: summary.errors.length }));
    return (lastRun = summary);
  } finally { running = false; }
}

// Staff fix from Claude Code: run owner-approved actions on a case through the same checks
// and CoC calls, with no customer reply and no owner email. Holds the run lock so the
// 5-min loop can't interleave.
async function actOnCase(caseId, actions) {
  if (running) throw new Error('agent run in progress, try again in a minute');
  running = true;
  try {
    loadAll();
    const c = cases[caseId];
    if (!c) throw new Error(`unknown case ${caseId}`);
    c.snapshot = await coc.snapshot(c.email);
    const { ok, problems } = checkOwnerActions(actions, c.snapshot);
    const results = await execute(c, ok);
    if (ok.length && results.every((r) => r.ok) && !problems.length) c.status = 'done';
    saveAll();
    return { case: c.id, status: c.status, results, problems };
  } finally { running = false; }
}

// Decide (no actions, no emails) for the newest customer email in one conversation.
async function tryConversation(conversationId) {
  loadAll();
  if (!state) state = { watermark: Date.now(), seen: [], nextId: 1, failures: {} };
  const conv = await ghl.getConversation(conversationId);
  conv.id = conversationId;
  const msgs = (await inboundEmails(conv, 0, new Set())).filter((x) => x.type === 'TYPE_EMAIL' && x.from && x.from !== OWNER());
  if (!msgs.length) return { error: 'no inbound customer email in that conversation' };
  const c = await handleCustomer(conv, msgs.slice(-1), { dryRun: true });
  return { ...c, ownerEmailPreview: proposalEmail(c) };
}

// Never reload from disk mid-run: loadAll() swaps out the objects the running loop is
// editing, and its final save then writes the stale copies back (case 68 lost its "done"
// on 10-25 when a status call landed during the 22:15 run).
function supportStatus() {
  if (!running || !state) loadAll();
  const list = Object.values(cases || {}).sort((a, b) => b.id - a.id).slice(0, 50)
    .map((c) => ({ id: c.id, status: c.status, createdAt: c.createdAt, email: c.email, summary: c.decision?.summary, action: c.plan?.action, executed: (c.executed || []).map((e) => `${e.ok ? 'ok' : 'FAILED'} ${e.key}`), ownerAnswer: c.ownerAnswer || null }));
  return { mode: mode(), dir: store.DIR, watermark: state && new Date(state.watermark).toISOString(), lastRun, cases: list, lessons };
}

// Close cases by hand with no emails (cleanup of error cases; the email route sends
// Alan a "Done" per case). Refused mid-run so the run's saveAll can't overwrite it.
function closeCases(ids) {
  if (running) throw new Error('agent is mid-run, try again in a minute');
  loadAll();
  const closed = [], skipped = [];
  for (const id of ids) {
    const c = cases[id];
    if (!c || c.status === 'done') { skipped.push(id); continue; }
    c.status = 'done'; c.closedAt = new Date().toISOString(); c.closedBy = 'api';
    closed.push(id);
  }
  saveAll();
  return { closed, skipped };
}

// Same as Alan's "rule N: <text>" / "rule N: delete" emails, for fixing lessons from the laptop.
function editLesson(id, text) {
  if (running) throw new Error('agent is mid-run, try again in a minute');
  loadAll();
  const i = lessons.findIndex((l) => l.id === id);
  if (i < 0) throw new Error(`unknown lesson ${id}`);
  if (/^delete\b/i.test(text.trim())) lessons.splice(i, 1);
  else lessons[i] = { ...lessons[i], text: text.trim(), editedAt: new Date().toISOString() };
  saveAll();
  return { lessons };
}

function setMode(next) {
  if (!['auto', 'approve', 'off'].includes(next)) throw new Error('mode must be auto, approve or off');
  if (!running || !state) loadAll();
  state = state || { watermark: Date.now(), seen: [], nextId: 1, failures: {} };
  state.mode = next;
  saveAll();
  return mode();
}

module.exports = { addressStatus: address.addressStatus, addressPreview: address.previewScan, runHbSupport, tryConversation, supportStatus, actOnCase, closeCases, editLesson, setMode, _planFor: planFor, _describeAccount: describeAccount, _unbackedClaims: unbackedClaims, _unshippedTees: unshippedTees };

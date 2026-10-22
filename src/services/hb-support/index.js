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
// Code-enforced limits regardless of what the model says: refunds only on the
// customer's own COMPLETE, unshipped orders (Alan can override shipped), auto refunds
// capped at HB_SUPPORT_AUTO_REFUND_MAX, cancels only on that customer's live purchases.

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

// ─── account formatting (for prompts and for Alan) ──────────────────────────
function describeAccount(snap) {
  if (!snap.orders.length) return `No Checkout Champ orders for ${snap.email}.`;
  const lines = [];
  for (const o of snap.orders) {
    const ship = o.shipped ? 'SHIPPED' : `not shipped (${o.fulfillments.map((f) => f.status).join(', ') || 'digital/no fulfillment'})`;
    lines.push(`Order ${o.orderId} · ${o.date} · ${o.type} · ${o.status} · ${money(o.total)} (refundable ${money(o.refundRemaining)}) · ${o.card || 'card ?'} · ${ship}`);
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
    return `Cancel subscription ${a.purchase_id}`;
  });
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

  if (action === 'refund_unshipped') {
    if (!decision.order_ids.length) problems.push('no order named to refund');
    for (const id of decision.order_ids) {
      const o = orders.get(id);
      if (!o) { problems.push(`order ${id} is not on this customer's account`); continue; }
      if (o.status !== 'COMPLETE' || o.refundRemaining <= 0) { problems.push(`order ${id} is ${o.status} with ${money(o.refundRemaining)} refundable`); continue; }
      if (o.shipped) { problems.push(`order ${id} has shipped`); continue; }
      actions.push({ type: 'refund_order', order_id: id });
    }
    const refunded = new Set(actions.map((a) => a.order_id));
    const subIds = new Set(decision.purchase_ids);
    for (const p of snap.purchases) if (p.live && refunded.has(p.orderId)) subIds.add(p.purchaseId);
    for (const id of subIds) if (purchases.get(id)?.live) actions.push({ type: 'cancel_purchase', purchase_id: id });
  } else if (action === 'cancel_subscriptions') {
    for (const id of decision.purchase_ids) {
      const p = purchases.get(id);
      if (!p) problems.push(`subscription ${id} is not on this customer's account`);
      else if (!p.live) problems.push(`subscription ${id} is already ${p.status}`);
      else actions.push({ type: 'cancel_purchase', purchase_id: id });
    }
    if (!decision.purchase_ids.length) problems.push('no live subscription named to cancel');
  }

  if (problems.length) action = 'escalate';
  const refundTotal = actions.filter((a) => a.type === 'refund_order').reduce((s, a) => s + orders.get(a.order_id).refundRemaining, 0);
  const autoOk = action !== 'escalate' && Number(decision.confidence) >= 0.75 && refundTotal <= AUTO_REFUND_MAX();
  return { action, actions: action === 'escalate' ? [] : actions, proposedActions: actions, problems, refundTotal, autoOk };
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
    }
  }
  return { ok, problems };
}

async function execute(c, actions) {
  c.executed = c.executed || [];
  const reason = `Customer request (${tag(c.id)})`;
  const results = [];
  for (const a of actions) {
    const key = `${a.type}:${a.order_id || a.purchase_id}:${a.amount || ''}`;
    if (c.executed.some((e) => e.key === key && e.ok)) continue;
    let ok = true, message;
    try {
      if (a.type === 'refund_order') message = await coc.refundOrder(a.order_id, reason);
      else if (a.type === 'partial_refund') message = await coc.partialRefund(a.order_id, a.amount, reason);
      else message = await coc.cancelPurchase(a.purchase_id, reason);
    } catch (e) {
      message = e.message;
      // Cancelling the order can already have cancelled its subscriptions.
      ok = a.type === 'cancel_purchase' && /already|cancel/i.test(message);
    }
    const r = { key, ...a, ok, message, at: new Date().toISOString() };
    c.executed.push(r); results.push(r);
  }
  const done = results.filter((r) => r.ok).map((r) => (r.type === 'cancel_purchase' ? `cancelled subscription ${r.purchase_id}` : `${r.type === 'partial_refund' ? `refunded ${money(r.amount)} on` : 'refunded + cancelled'} order ${r.order_id}`));
  for (const customerId of (c.snapshot.customerIds || []).slice(0, 1)) {
    if (done.length) await coc.addNote(customerId, `HB support agent ${tag(c.id)}: ${done.join('; ')}.`).catch((e) => console.warn('[hb-support] note failed:', e.message));
  }
  return results;
}

async function replyToCustomer(c, text) {
  const subject = /^re:/i.test(c.subject) ? c.subject : `Re: ${c.subject || 'Your Happy Bakers order'}`;
  c.replyMessageId = await ghl.sendEmail({ contactId: c.contactId, conversationId: c.conversationId, to: c.email, fromName: 'Maggie Bennett', subject, text, replyMessageId: c.inboundMessageId });
  c.replySentAt = new Date().toISOString();
  c.replyText = text;
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

  const snapshot = await coc.snapshot(last.from);
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
    await replyToCustomer(c, c.decision.reply);
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
  c.snapshot = await coc.snapshot(c.email);

  let out;
  if (PLAIN_YES.test(text) && c.plan.action !== 'escalate') {
    out = { actions: c.plan.proposedActions, send_reply: c.plan.action !== 'no_reply', reply: c.decision.reply, lesson: null, confirmation: 'Doing exactly what I proposed.' };
  } else {
    out = await callTool({
      system: prompt.system(lessons), tool: prompt.ANSWER_TOOL,
      prompt: [
        customerBlock(c),
        `THEIR CHECKOUT CHAMP ACCOUNT (current)\n${describeAccount(c.snapshot)}`,
        `WHAT YOU PROPOSED\nAction: ${c.plan.action}\n${describePlan({ ...c.plan, actions: c.plan.proposedActions }, c.snapshot)}\nReply: ${c.decision.reply}\n${c.decision.question_for_owner ? `Your question: ${c.decision.question_for_owner}` : ''}`,
        c.status === 'done' ? `THIS CASE WAS ALREADY HANDLED: ${(c.executed || []).filter((e) => e.ok).map((e) => e.key).join(', ') || 'no account changes'}; reply sent: ${c.replySentAt ? 'yes' : 'no'}. The owner is correcting it — only list ADDITIONAL actions, and only reply if the customer needs to hear something new.` : '',
        `THE OWNER'S ANSWER (this is authoritative)\n${text}`,
      ].filter(Boolean).join('\n\n'),
    });
  }

  const { ok, problems } = checkOwnerActions(out.actions, c.snapshot);
  const results = await execute(c, ok);
  const failed = results.filter((r) => !r.ok);
  if (out.send_reply && out.reply && !failed.length) await replyToCustomer(c, out.reply);
  if (out.lesson) lessons.push({ id: nextLessonId(), at: new Date().toISOString(), text: out.lesson, caseId: c.id });
  c.status = failed.length ? 'awaiting_owner' : 'done';

  const lines = [out.confirmation];
  for (const r of results) lines.push(`${r.ok ? 'Done' : 'FAILED'}: ${r.type} ${r.order_id || r.purchase_id}${r.amount ? ` ${money(r.amount)}` : ''}${r.ok ? '' : ` (${r.message})`}`);
  if (problems.length) lines.push(`Skipped: ${problems.join('; ')}`);
  lines.push(out.send_reply && !failed.length ? `Reply sent to ${c.email}:\n${out.reply}` : failed.length ? 'No reply sent because something failed. Tell me how to proceed.' : 'No reply sent.');
  if (out.lesson) lines.push(`Saved as a rule for next time: ${out.lesson}`);
  await emailOwner(c, `${failed.length ? 'Problem' : 'Done'}: ${c.decision.summary}`, lines.join('\n\n'));
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
        for (const om of ownerMsgs) { if (!(await inventory.handleOwner(om)) && !(await address.handleOwner(om, addressHelpers(conv)))) await handleOwner(om); summary.owner++; }
        const email = custMsgs.filter((x) => x.type === 'TYPE_EMAIL' && x.from);
        const other = custMsgs.filter((x) => x.type !== 'TYPE_EMAIL');
        if (email.length) {
          if (!(await address.handleReply(email, addressHelpers(conv)))) await handleCustomer(conv, email, { dryRun: false });
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
        // Retry on the next run; after 3 tries, hand it to Alan and move on.
        for (const x of msgs) {
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
    state.watermark = startedAt;
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

function supportStatus() {
  loadAll();
  const list = Object.values(cases || {}).sort((a, b) => b.id - a.id).slice(0, 50)
    .map((c) => ({ id: c.id, status: c.status, createdAt: c.createdAt, email: c.email, summary: c.decision?.summary, action: c.plan?.action, executed: (c.executed || []).map((e) => `${e.ok ? 'ok' : 'FAILED'} ${e.key}`), ownerAnswer: c.ownerAnswer || null }));
  return { mode: mode(), dir: store.DIR, watermark: state && new Date(state.watermark).toISOString(), lastRun, cases: list, lessons };
}

function setMode(next) {
  if (!['auto', 'approve', 'off'].includes(next)) throw new Error('mode must be auto, approve or off');
  loadAll();
  state = state || { watermark: Date.now(), seen: [], nextId: 1, failures: {} };
  state.mode = next;
  saveAll();
  return mode();
}

module.exports = { addressStatus: address.addressStatus, addressPreview: address.previewScan, runHbSupport, tryConversation, supportStatus, setMode, _planFor: planFor, _describeAccount: describeAccount };

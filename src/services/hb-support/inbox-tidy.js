// Keeps Alan's Gmail inbox free of Happy Bakers agent mail he no longer needs to see.
// Dash sends from hello@ via GHL and never touched alan@2by4llc.com, so it piled up
// (Alan, 11-26). Uses the same app password as the Control digest (IMAP). Mail is
// MOVED to All Mail (archived), never deleted. Rules:
// - [HB-CS-n]: archived once case n is done. A new message on a closed case opens a NEW
//   case number (index.js only reopens awaiting_owner), so this can't hide anything new.
//   "Done" emails go out already closed, so they leave on the next run.
// - "<Customer> via The Happy Baker" (hello@mg.happybakerhq.com): GHL's copy of every
//   inbound customer email. The agent handles each one within 5 min and emails an
//   [HB-CS-n] when it needs Alan, so copies older than 30 min are archived.
// - [HB-ADDR-FYI]: archived. [HB-ADDR-STALE]: archived after 2 days (orders stay
//   cancelled; nothing to do). [HB-ADDR-SWEEP]: only the newest stays. [HB-ADDR-FIX]
//   <order>: archived once that order's bad-address record is fixed.
// - [HB-INV-n] (inventory reports, Temu logs/problems): only the highest n stays. Each
//   daily report repeats whatever is still open, so older ones are superseded.
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const { ImapFlow } = require('imapflow');
const store = require('./store');

const COPY_MIN_AGE_MS = 30 * 60 * 1000;
const STALE_MIN_AGE_MS = 2 * 24 * 3600 * 1000;

let running = false;
let lastRun = null;

// Pure: which inbox messages to archive. msgs = [{ uid, subject, fromName, fromAddr, date }]
function decide(msgs, { cases = {}, addressOrders = [], now = Date.now() } = {}) {
  const archive = new Set();
  const why = {};
  const mark = (m, reason) => { archive.add(m.uid); why[reason] = (why[reason] || 0) + 1; };
  const fixed = new Set(addressOrders.filter((r) => r.status === 'fixed').map((r) => String(r.orderNumber)));
  const sweeps = msgs.filter((m) => /\[HB-ADDR-SWEEP\]/i.test(m.subject)).sort((a, b) => b.date - a.date);
  const newestSweep = sweeps[0] && sweeps[0].uid;
  const invNums = msgs.map((m) => Number((/\[HB-INV-(\d+)\]/i.exec(m.subject || '') || [])[1])).filter(Boolean);
  const newestInv = invNums.length ? Math.max(...invNums) : null;
  for (const m of msgs) {
    const s = m.subject || '';
    const age = now - (m.date || now);
    const cs = /HB-CS-(\d+)/i.exec(s);
    if (cs) { if (cases[cs[1]] && cases[cs[1]].status === 'done') mark(m, 'cs closed'); continue; }
    const inv = /\[HB-INV-(\d+)\]/i.exec(s);
    if (inv) { if (Number(inv[1]) !== newestInv) mark(m, 'inv (older)'); continue; }
    if (/\[HB-ADDR-FYI\]/i.test(s)) { mark(m, 'addr fyi'); continue; }
    if (/\[HB-ADDR-STALE\]/i.test(s)) { if (age > STALE_MIN_AGE_MS) mark(m, 'addr stale'); continue; }
    if (/\[HB-ADDR-SWEEP\]/i.test(s)) { if (m.uid !== newestSweep) mark(m, 'addr sweep (older)'); continue; }
    const fix = /\[HB-ADDR-FIX\].*order\s+([A-Z0-9-]+)/i.exec(s);
    if (fix) { if (fixed.has(fix[1].replace(/-R$/i, ''))) mark(m, 'addr fixed'); continue; }
    if (/hello@mg\.happybakerhq\.com/i.test(m.fromAddr || '') && / via The Happy Baker/i.test(m.fromName || '')) {
      if (age > COPY_MIN_AGE_MS) mark(m, 'customer copy');
    }
  }
  return { archive: [...archive], why };
}

async function tidyInbox({ dryRun = false } = {}) {
  const user = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/[\s ]/g, '');
  if (!user || !pass) return { skipped: 'GMAIL_USER / GMAIL_APP_PASSWORD not set' };
  if (running) return { skipped: 'already running' };
  running = true;
  const out = { at: new Date().toISOString(), dryRun, inInbox: 0, archived: 0, why: {}, kept: [] };
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    const cases = store.load('cases', {});
    const addr = store.load('address', {});
    const addressOrders = Array.isArray(addr.orders) ? addr.orders : Object.values(addr.orders || {});
    await client.connect();
    const all = (await client.list()).find((b) => b.specialUse === '\\All');
    if (!all) throw new Error('no All Mail folder');
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ gmraw: 'in:inbox {subject:"HB-CS-" subject:"HB-ADDR-" subject:"HB-INV-" from:hello@mg.happybakerhq.com}' }, { uid: true });
      out.inInbox = uids.length;
      const msgs = [];
      if (uids.length) {
        for await (const m of client.fetch(uids, { envelope: true, internalDate: true }, { uid: true })) {
          const f = (m.envelope && m.envelope.from && m.envelope.from[0]) || {};
          msgs.push({ uid: m.uid, subject: m.envelope?.subject || '', fromName: f.name || '', fromAddr: f.address || '', date: new Date(m.internalDate || m.envelope?.date || Date.now()).getTime() });
        }
      }
      const d = decide(msgs, { cases, addressOrders });
      out.archived = d.archive.length;
      out.why = d.why;
      const keep = new Set(d.archive);
      out.kept = msgs.filter((m) => !keep.has(m.uid)).map((m) => m.subject.slice(0, 80));
      if (d.archive.length && !dryRun) await client.messageMove(d.archive, all.path, { uid: true });
    } finally { lock.release(); }
  } catch (e) {
    out.error = e.message;
  } finally {
    running = false;
    await client.logout().catch(() => {});
  }
  if (!dryRun) lastRun = out;
  return out;
}

module.exports = { tidyInbox, tidyStatus: () => lastRun, _decide: decide };

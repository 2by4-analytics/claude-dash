// Archives [HB-CS-n] emails in Alan's Gmail inbox once case n is closed in Dash.
// Dash sends these from hello@ via GHL and never touched alan@2by4llc.com, so closed
// cases piled up in the inbox (Alan, 11-26). Uses the same app password as the
// Control digest (IMAP). A new customer message on a closed case opens a NEW case
// number (index.js handleConversation only reopens awaiting_owner), so archiving a
// closed case's thread can't hide anything new. "Done" emails go out with the case
// already closed, so they leave the inbox on the next run (acts as the Done filter).
if (!globalThis.crypto) globalThis.crypto = require('crypto').webcrypto;
const { ImapFlow } = require('imapflow');
const store = require('./store');

let running = false;
let lastRun = null;

async function tidyInbox({ dryRun = false } = {}) {
  const user = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/[\s ]/g, '');
  if (!user || !pass) return { skipped: 'GMAIL_USER / GMAIL_APP_PASSWORD not set' };
  if (running) return { skipped: 'already running' };
  running = true;
  const out = { at: new Date().toISOString(), dryRun, inInbox: 0, archived: [], kept: [] };
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, auth: { user, pass }, logger: false });
  try {
    const cases = store.load('cases', {});
    await client.connect();
    const boxes = await client.list();
    const all = boxes.find((b) => b.specialUse === '\\All');
    if (!all) throw new Error('no All Mail folder');
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = await client.search({ gmraw: 'in:inbox subject:"HB-CS-"' }, { uid: true });
      out.inInbox = uids.length;
      const archive = [];
      if (uids.length) {
        for await (const m of client.fetch(uids, { envelope: true }, { uid: true })) {
          const subject = m.envelope?.subject || '';
          const id = (/HB-CS-(\d+)/i.exec(subject) || [])[1];
          const c = id && cases[id];
          if (c && c.status === 'done') { archive.push(m.uid); out.archived.push(`#${id}`); }
          else out.kept.push(`#${id || '?'} ${c ? c.status : 'unknown case'}`);
        }
      }
      if (archive.length && !dryRun) await client.messageMove(archive, all.path, { uid: true });
    } finally { lock.release(); }
    out.archived = [...new Set(out.archived)];
    out.kept = [...new Set(out.kept)];
  } catch (e) {
    out.error = e.message;
  } finally {
    running = false;
    await client.logout().catch(() => {});
  }
  if (!dryRun) lastRun = out;
  return out;
}

module.exports = { tidyInbox, tidyStatus: () => lastRun };

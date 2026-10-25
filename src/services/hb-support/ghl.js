// GHL Conversations for the HB sub-account: read inbound customer email, send replies
// (as Maggie) and agent emails to Alan. hello@happybakerhq.com forwards into this
// location, so every reply — customer's or Alan's — comes back here as an inbound email.
const axios = require('axios');

const BASE = 'https://services.leadconnectorhq.com';

function http(version = '2021-07-28') {
  const pit = process.env.HB_GHL_PIT;
  if (!pit || !process.env.HB_GHL_LOCATION_ID) throw new Error('HB_GHL_PIT / HB_GHL_LOCATION_ID missing');
  return axios.create({ baseURL: BASE, timeout: 20000, headers: { Authorization: `Bearer ${pit}`, Version: version, Accept: 'application/json' } });
}
const loc = () => process.env.HB_GHL_LOCATION_ID;
const link = (conversationId) => `https://app.gohighlevel.com/v2/location/${loc()}/conversations/conversations/${conversationId}`;

// Conversations with any activity since `sinceMs`, newest first.
async function recentConversations(sinceMs) {
  const out = [];
  for (let page = 0, after; page < 5; page++) {
    const r = await http().get('/conversations/search', { params: { locationId: loc(), limit: 50, sortBy: 'last_message_date', sort: 'desc', ...(after ? { startAfterDate: after } : {}) } });
    const rows = r.data.conversations || [];
    for (const c of rows) if (c.lastMessageDate >= sinceMs) out.push(c);
    if (rows.length < 50 || rows[rows.length - 1].lastMessageDate < sinceMs) break;
    after = rows[rows.length - 1].lastMessageDate;
  }
  return out;
}

const getConversation = async (id) => (await http().get(`/conversations/${id}`)).data.conversation || {};
const getMessages = async (id) => ((await http().get(`/conversations/${id}/messages`, { params: { limit: 30 } })).data.messages || {}).messages || [];

function htmlToText(html) {
  return String(html || '')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n')
    .replace(/<style[\s\S]*?<\/style>|<head[\s\S]*?<\/head>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Drop the quoted history under a reply ("On … wrote:", "> …", Outlook headers).
function stripQuoted(text) {
  const lines = String(text).split('\n');
  const cut = lines.findIndex((l) => /^\s*On .+wrote:\s*$/i.test(l) || /^\s*-{2,}\s*Original Message/i.test(l) || /^\s*From:\s.+/i.test(l) || /^\s*>/.test(l));
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

async function emailMessage(messageId) {
  const m = (await http().get(`/conversations/messages/email/${messageId}`)).data.emailMessage || {};
  return { from: m.from || '', to: m.to || [], subject: m.subject || '', at: m.dateAdded || null, direction: m.direction || '', text: stripQuoted(htmlToText(m.body)), html: m.body || '', attachments: m.attachments || [] };
}

// Same markup GHL's own composer sends, with an explicit normal weight: plain <p> HTML
// sent through the API rendered bold (Alan, 10-18).
const P = '<p class="custom-newline" style="margin: 0px; line-height: 1.5; font-weight: 400; padding-left: 0px !important;">{}</p>';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function render(text) {
  const paras = String(text).trim().split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const inner = paras.map((p) => P.replace('{}', p.split('\n').map(esc).join('<br>'))).join(P.replace('{}', '<br>'));
  return '<html><head><style>.ProseMirror > p.custom-newline {margin: 0px;}</style></head><body>'
    + '<div class="ProseMirror" style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; font-weight: 400; color: #222222;">'
    + inner + '</div></body></html>';
}

// `html` (optional) is sent as-is instead of rendering `text`.
async function sendEmail({ contactId, conversationId, to, fromName, subject, text, html, replyMessageId }) {
  const body = {
    type: 'Email', contactId, emailTo: to, subject, html: html || render(text),
    emailFrom: `${fromName} <hello@happybakerhq.com>`,
    ...(conversationId ? { conversationId } : {}), ...(replyMessageId ? { replyMessageId } : {}),
  };
  let r;
  try { r = await http('2021-04-15').post('/conversations/messages', body); }
  catch (e) {
    // GHL only sends to the contact's own addresses. A customer writing from an address
    // that isn't on their contact (Deziray 10-24: contact had a typo'd email) would fail
    // every run, so add the address they wrote from and retry once.
    if (!(e.response && e.response.data && e.response.data.canonicalCode === 'CONVERSATIONS_MSG_INVALID_EMAILTO' && contactId && to)) throw e;
    await addContactEmail(contactId, to);
    r = await http('2021-04-15').post('/conversations/messages', body);
  }
  return r.data.messageId || r.data.emailMessageId;
}

async function addContactEmail(contactId, email) {
  const c = (await http().get(`/contacts/${contactId}`)).data.contact || {};
  const extra = (c.additionalEmails || []).map((x) => (typeof x === 'string' ? x : x.email)).filter(Boolean);
  if ([c.email, ...extra].some((x) => String(x).toLowerCase() === email.toLowerCase())) return;
  await http().put(`/contacts/${contactId}`, { additionalEmails: [...extra, email].map((x) => ({ email: x })) });
  console.log('[hb-support] added', email.replace(/^(.).*@/, '$1***@'), 'to contact', contactId);
}

// Email DND stops every GHL email to the contact (workflows and manual sends), so set it
// only after the last reply to them has gone out.
async function stopEmails(contactId, message) {
  await http().put(`/contacts/${contactId}`, { dndSettings: { Email: { status: 'active', message } } });
}

async function contactIdFor(email, firstName = 'Alan', lastName = '') {
  const r = await http().get('/contacts/search/duplicate', { params: { locationId: loc(), email } });
  if (r.data.contact && r.data.contact.id) return r.data.contact.id;
  const up = await http().post('/contacts/upsert', { locationId: loc(), email, firstName, ...(lastName ? { lastName } : {}), source: 'HB support agent' });
  return up.data.contact.id;
}

module.exports = { recentConversations, getConversation, getMessages, emailMessage, sendEmail, stopEmails, contactIdFor, link, render, htmlToText };

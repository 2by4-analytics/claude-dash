// Happy Bakers: Checkout Champ (campaign 15) → GHL "The Happy Baker" sub-account.
//
// GHL is used only for marketing email. Two audiences:
//   hb partial  started the /application funnel (CoC PARTIAL / DECLINED) but has
//               no COMPLETE order. Gets "finish joining the testers" emails.
//   hb buyer    has at least one COMPLETE order. Gets new-tester-offer emails.
// When a partial buys, "hb partial" is removed so the reminder workflow stops.
//   canceled    has a refunded/cancelled order and no COMPLETE one. Buyer,
//               partial and product tags are removed so no workflow emails them.
// Buying again later flips them back to "hb buyer" and drops "canceled".
// Product tags (hb planner, hb stickers, …) ride along for segmenting.
//
// CoC allowlists caller IPs, so this has to run on Dash. It reads with the
// happybaker-site-api user (HB_COC_LOGIN_ID / HB_COC_PASSWORD) and writes with a
// location PIT (HB_GHL_PIT / HB_GHL_LOCATION_ID). Upserts and tag adds are
// idempotent, so overlapping windows are harmless. Test orders are skipped.

const axios = require('axios');

const COC = 'https://api.checkoutchamp.com/order/query/';
const GHL = 'https://services.leadconnectorhq.com';
const TEST_EMAIL = /claude-test|@2by4llc\.com|alan2by4|@baggerscorner\.com/i;

const TAG_PARTIAL = 'hb partial';
const TAG_BUYER = 'hb buyer';
const TAG_SOURCE = 'src: checkout champ';
const TAG_CANCELED = 'canceled';
const PRODUCT_TAGS = [
  [[251, 281, 291], 'hb planner'],
  [[245, 247, 249], 'hb stickers'],
  [[283, 285, 287, 295, 297], 'hb tester claim'],
  [[255], 'hb box subscriber'],
  [[257, 259, 261, 263, 265, 267, 269], 'hb tee'],
  [[279, 289], 'hb tumbler'],
  [[275], 'hb scale'],
];

const mdy = (d) => `${d.getMonth() + 1}/${d.getDate()}/${String(d.getFullYear()).slice(-2)}`;

async function cocOrders(days, dateRangeType) {
  const loginId = process.env.HB_COC_LOGIN_ID, password = process.env.HB_COC_PASSWORD;
  if (!loginId || !password) throw new Error('HB_COC_LOGIN_ID / HB_COC_PASSWORD missing');
  const end = new Date(Date.now() + 86400000), start = new Date(Date.now() - days * 86400000);
  const out = [];
  for (let page = 1; page < 50; page++) {
    const r = await axios.get(COC, { params: { loginId, password, campaignId: process.env.HB_COC_CAMPAIGN_ID || '15', startDate: mdy(start), endDate: mdy(end), dateRangeType, resultsPerPage: 200, page } });
    if (r.data.result !== 'SUCCESS') {
      if (/no .*found/i.test(JSON.stringify(r.data.message))) break;
      throw new Error('CoC order/query: ' + JSON.stringify(r.data.message).slice(0, 200));
    }
    const rows = r.data.message.data || [];
    out.push(...rows);
    if (out.length >= (r.data.message.totalResults || 0) || !rows.length) break;
  }
  return out;
}

function productIds(order) {
  const items = order.items && typeof order.items === 'object' ? Object.values(order.items) : [];
  return items.map((i) => Number(i && i.productId)).filter(Boolean);
}

// One entry per email: buyer wins over partial; newest name/phone wins.
function people(orders) {
  const map = new Map();
  for (const o of orders) {
    const email = String(o.emailAddress || '').trim().toLowerCase();
    if (!email || !email.includes('@') || TEST_EMAIL.test(email)) continue;
    const p = map.get(email) || { email, buyer: false, started: false, products: new Set(), at: '' };
    const st = String(o.orderStatus || '').toUpperCase();
    if (st === 'COMPLETE') { p.buyer = true; productIds(o).forEach((id) => p.products.add(id)); }
    else if (st === 'PARTIAL' || st === 'DECLINED') p.started = true;
    else if (/REFUND|CANCEL|VOID/.test(st)) p.refunded = true;
    const at = String(o.dateUpdated || o.dateCreated || '');
    if (at >= p.at) {
      p.at = at;
      p.firstName = o.firstName || p.firstName; p.lastName = o.lastName || p.lastName;
      p.phone = o.phoneNumber || p.phone;
      p.postalCode = o.postalCode || o.shipPostalCode || p.postalCode;
      p.state = o.state || o.shipState || p.state;
    }
    map.set(email, p);
  }
  // Refunded/cancelled beats partial: an old unfinished checkout must not put
  // them back on the finish-joining emails. A COMPLETE order beats both.
  return [...map.values()].filter((p) => p.buyer || p.refunded || p.started)
    .map((p) => ({ ...p, canceled: !p.buyer && !!p.refunded }));
}

function ghl() {
  const pit = process.env.HB_GHL_PIT, locationId = process.env.HB_GHL_LOCATION_ID;
  if (!pit || !locationId) throw new Error('HB_GHL_PIT / HB_GHL_LOCATION_ID missing');
  const http = axios.create({ baseURL: GHL, headers: { Authorization: `Bearer ${pit}`, Version: '2021-07-28', Accept: 'application/json' }, timeout: 20000 });
  return { http, locationId };
}

async function pushPerson({ http, locationId }, p) {
  const body = { locationId, email: p.email, source: 'Checkout Champ' };
  if (p.firstName) body.firstName = p.firstName;
  if (p.lastName) body.lastName = p.lastName;
  if (p.phone) body.phone = String(p.phone);
  if (p.postalCode) body.postalCode = String(p.postalCode);
  if (p.state) body.state = p.state;
  const up = await http.post('/contacts/upsert', body);
  const id = up.data && up.data.contact && up.data.contact.id;
  if (!id) throw new Error('upsert returned no contact id');
  if (p.canceled) {
    await http.post(`/contacts/${id}/tags`, { tags: [TAG_SOURCE, TAG_CANCELED] });
    await http.delete(`/contacts/${id}/tags`, { data: { tags: [TAG_BUYER, TAG_PARTIAL, ...PRODUCT_TAGS.map(([, t]) => t)] } });
    return { id, tags: [TAG_SOURCE, TAG_CANCELED] };
  }
  const tags = [TAG_SOURCE, p.buyer ? TAG_BUYER : TAG_PARTIAL];
  if (p.buyer) for (const [ids, tag] of PRODUCT_TAGS) if (ids.some((x) => p.products.has(x))) tags.push(tag);
  await http.post(`/contacts/${id}/tags`, { tags });
  if (p.buyer) await http.delete(`/contacts/${id}/tags`, { data: { tags: [TAG_PARTIAL, TAG_CANCELED] } });
  return { id, tags };
}

let running = false;
async function runHbGhlSync({ days = 3, dryRun = false } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const started = Date.now();
  try {
    // dateUpdated catches partials that convert days after they first started.
    let orders;
    try { orders = await cocOrders(days, 'dateUpdated'); }
    catch (e) { console.warn('[hb-ghl] dateUpdated query failed, using dateCreated:', e.message); orders = await cocOrders(days, 'dateCreated'); }
    const list = people(orders);
    const summary = { orders: orders.length, people: list.length, buyers: list.filter((p) => p.buyer).length, canceled: list.filter((p) => p.canceled).length, partials: list.filter((p) => !p.buyer && !p.canceled).length, pushed: 0, errors: [] };
    if (dryRun) return { ...summary, preview: list.map((p) => ({ email: p.email.replace(/^(.).*@/, '$1***@'), buyer: p.buyer, canceled: p.canceled, products: [...p.products] })) };
    const g = ghl();
    for (const p of list) {
      try { await pushPerson(g, p); summary.pushed++; }
      catch (e) { summary.errors.push(`${p.email.replace(/^(.).*@/, '$1***@')}: ${e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 160) : e.message}`); }
      await new Promise((r) => setTimeout(r, 150));
    }
    summary.ms = Date.now() - started;
    console.log('[hb-ghl] sync', JSON.stringify({ ...summary, errors: summary.errors.length }));
    if (summary.errors.length) console.error('[hb-ghl] errors', summary.errors.slice(0, 5).join(' | '));
    lastRun = { at: new Date().toISOString(), ...summary };
    return summary;
  } finally { running = false; }
}

let lastRun = null;
const hbGhlLastRun = () => lastRun;

module.exports = { runHbGhlSync, hbGhlLastRun, people };

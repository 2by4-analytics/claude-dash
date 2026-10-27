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
// Buyers also get one opportunity in the "Happy Baker Stickers" pipeline, in the
// FURTHEST stage they've bought (Sticker → Sticker Club → Baker Box → Tee). It
// only ever moves forward: each run sees a 3-day window, so someone who bought
// the Box last week and stickers today must not drop back to "Bought Sticker".
// Canceled contacts' opportunities are marked lost; buying again reopens them.
// Stages are looked up by name, so a missing stage just skips that move.
//
// CoC allowlists caller IPs, so this has to run on Dash. It reads with the
// happybaker-site-api user (HB_COC_LOGIN_ID / HB_COC_PASSWORD) and writes with a
// location PIT (HB_GHL_PIT / HB_GHL_LOCATION_ID). Upserts and tag adds are
// idempotent, so overlapping windows are harmless. Test orders are skipped.
//
// Each person's pushed state is fingerprinted on the volume and unchanged people
// are skipped: re-pushing ~4,700 people every run (~9k calls, ~30 min) spent the
// location's 200k/day GHL quota and 429'd the support agent for hours (10-23).

const axios = require('axios');
const store = require('./hb-support/store');

const COC = 'https://api.checkoutchamp.com/order/query/';
const GHL = 'https://services.leadconnectorhq.com';
const TEST_EMAIL = /claude-test|@2by4llc\.com|alan2by4|@baggerscorner\.com/i;

const TAG_PARTIAL = 'hb partial';
const TAG_BUYER = 'hb buyer';
const TAG_SOURCE = 'src: checkout champ';
const TAG_CANCELED = 'canceled';
const PRODUCT_TAGS = [
  [[251, 281, 291], 'hb planner'],
  [[245, 247, 249, 319], 'hb stickers'],
  [[247], 'hb monthly stickers'],
  [[283, 285, 287, 295, 297, 299], 'hb tester claim'],
  [[255], 'hb box subscriber'],
  [[257, 259, 261, 263, 265, 267, 269], 'hb tee'],
  // Rolling Pin design, one-time shop tee on happybakerhq.com (not the funnel's Monthly Tee,
  // so it stays out of 'hb tee' and the Bought Tee stage).
  [[321, 323, 325, 327, 329, 331, 333], 'hb rolling pin tee'],
  [[279, 289], 'hb tumbler'],
  [[275], 'hb scale'],
];

// Pipeline stages in funnel order; a buyer sits in the last one they qualify for.
const PIPELINE = 'Happy Baker Stickers';
const STAGES = [
  ['Bought Sticker', [245, 247, 249, 319]],
  ['Bought Sticker Club', [247]],
  ['Bought Baker Box', [255]],
  ['Bought Tee', [257, 259, 261, 263, 265, 267, 269]],
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
  // GHL 429s under backfill load (the location's quota is shared with the support agent etc.): back off and retry.
  http.interceptors.response.use(null, async (e) => {
    const c = e.config;
    if (!e.response || e.response.status !== 429 || (c.__tries = (c.__tries || 0) + 1) > 5) throw e;
    const wait = Number(e.response.headers['retry-after']) * 1000 || 2000 * c.__tries;
    await new Promise((r) => setTimeout(r, wait));
    return http(c);
  });
  return { http, locationId };
}

// Stage name → { id, rank } for the pipeline, read once per run. null if the
// pipeline is missing (opportunities are then skipped; tags still sync).
async function loadPipeline({ http, locationId }) {
  const r = await http.get('/opportunities/pipelines', { params: { locationId } });
  const p = (r.data.pipelines || []).find((x) => x.name === PIPELINE);
  if (!p) return null;
  const byName = new Map(p.stages.map((s) => [s.name, s.id]));
  const stages = STAGES.map(([name], rank) => ({ name, rank, id: byName.get(name) || null }));
  return { id: p.id, stages, rankOf: new Map(stages.filter((s) => s.id).map((s) => [s.id, s.rank])) };
}

function furthestStage(pipe, products) {
  let best = null;
  STAGES.forEach(([, ids], rank) => { if (ids.some((x) => products.has(x)) && pipe.stages[rank].id) best = pipe.stages[rank]; });
  return best;
}

async function syncOpportunity({ http, locationId }, pipe, contactId, p) {
  const found = await http.get('/opportunities/search', { params: { location_id: locationId, pipeline_id: pipe.id, contact_id: contactId, limit: 1 } });
  const opp = (found.data.opportunities || [])[0];
  if (p.canceled) {
    if (opp && opp.status !== 'lost') { await http.put(`/opportunities/${opp.id}`, { status: 'lost' }); return 'lost'; }
    return null;
  }
  const target = furthestStage(pipe, p.products);
  if (!target) return null;
  if (!opp) {
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email;
    await http.post('/opportunities/', { locationId, pipelineId: pipe.id, pipelineStageId: target.id, contactId, name, status: 'open' });
    return 'created';
  }
  const cur = pipe.rankOf.has(opp.pipelineStageId) ? pipe.rankOf.get(opp.pipelineStageId) : -1;
  if (target.rank > cur || opp.status !== 'open') {
    await http.put(`/opportunities/${opp.id}`, { pipelineStageId: target.rank > cur ? target.id : opp.pipelineStageId, status: 'open' });
    return 'moved';
  }
  return null;
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

// Everything pushPerson / syncOpportunity act on; a change in any of it re-pushes.
const fingerprint = (p) => JSON.stringify([p.firstName || '', p.lastName || '', String(p.phone || ''), String(p.postalCode || ''), p.state || '', !!p.buyer, !!p.canceled, [...p.products].sort()]);
const PUSHED = 'ghl-sync-pushed';
const PUSHED_TTL = 30 * 864e5;

let running = false;
async function runHbGhlSync({ days = 3, dryRun = false, buyersOnly = false, force = false } = {}) {
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
    const stageName = (p) => { let s = null; for (const [name, ids] of STAGES) if (p.buyer && ids.some((x) => p.products.has(x))) s = name; return s; };
    if (dryRun) {
      const stages = {};
      for (const p of list) { const s = p.canceled ? 'lost (canceled)' : stageName(p); if (s) stages[s] = (stages[s] || 0) + 1; }
      return { ...summary, stages, preview: list.map((p) => ({ email: p.email.replace(/^(.).*@/, '$1***@'), buyer: p.buyer, canceled: p.canceled, products: [...p.products], stage: stageName(p) })) };
    }
    const g = ghl();
    let pipe = null;
    try { pipe = await loadPipeline(g); if (!pipe) summary.errors.push(`pipeline "${PIPELINE}" not found, opportunities skipped`); }
    catch (e) { summary.errors.push(`pipeline lookup: ${e.message}`); }
    if (pipe) { const missing = pipe.stages.filter((s) => !s.id).map((s) => s.name); if (missing.length) summary.errors.push(`stages missing in "${PIPELINE}": ${missing.join(', ')}`); }
    summary.opportunities = { created: 0, moved: 0, lost: 0 };
    // buyersOnly skips partials (a backfill re-push of thousands of partials is what made it run >1h);
    // 2 workers; 429s are retried in ghl().
    const pushed = store.load(PUSHED, {});
    const queue = (buyersOnly ? list.filter((p) => p.buyer || p.canceled) : list)
      .filter((p) => force || (pushed[p.email] && pushed[p.email].fp) !== fingerprint(p));
    summary.unchanged = list.length - queue.length;
    let unsaved = 0;
    const worker = async () => {
      for (let p; (p = queue.shift());) {
        try {
          const { id } = await pushPerson(g, p); summary.pushed++;
          if (pipe && (p.buyer || p.canceled)) { const r = await syncOpportunity(g, pipe, id, p); if (r) summary.opportunities[r]++; }
          pushed[p.email] = { fp: fingerprint(p), at: Date.now() };
          if (++unsaved >= 250) { store.save(PUSHED, pushed); unsaved = 0; }
        }
        catch (e) { summary.errors.push(`${p.email.replace(/^(.).*@/, '$1***@')}: ${e.response ? e.response.status + ' ' + JSON.stringify(e.response.data).slice(0, 160) : e.message}`); }
        await new Promise((r) => setTimeout(r, 150));
      }
    };
    await Promise.all(Array.from({ length: 2 }, worker));
    for (const [email, v] of Object.entries(pushed)) if (Date.now() - v.at > PUSHED_TTL) delete pushed[email];
    store.save(PUSHED, pushed);
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

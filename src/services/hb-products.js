// Happy Bakers site (Lovable) → Checkout Champ product creation, relayed through
// Dash because CoC allowlists API callers by IP. The site only chooses name / SKU /
// price / shipping / category / fulfillment; everything else is fixed here so a
// site bug can't create a subscription, touch the funnel's products, or land on
// the wrong processor. Every product is read back from CoC and checked before it
// is reported `ready`. Products the site created are recorded on the Railway
// volume, and only those can be updated through this path.
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const nodemailer = require('nodemailer');

const COC = 'https://api.checkoutchamp.com';
const DIR = process.env.HB_PRODUCTS_DIR
  || (fs.existsSync('/data') ? '/data/hb-products' : path.join(__dirname, '../../data/hb-products'));
const FILE = path.join(DIR, 'created.json');

// Fixed config, matching the recent site-only products (butter tee 349–361, etc.).
const LOAD_BALANCER_ID = Number(process.env.HB_PRODUCT_LB_ID || 3); // "Happy Bakers"
const DESCRIPTOR = 'HAPPY BAKER';
const CATEGORIES = { products: 11, tees: 27 }; // "Happy Baker Products", "HB TShirts"
const FULFILLMENT = { shipsem: 11, pod: null }; // 11 = Shipsem (Eric); null = System Fulfillment (POD tees)
const MAX_PRICE = Number(process.env.HB_PRODUCT_MAX_PRICE || 200);
const MAX_SHIP = Number(process.env.HB_PRODUCT_MAX_SHIP || 25);

function creds() {
  const loginId = process.env.HB_COC_LOGIN_ID, password = process.env.HB_COC_PASSWORD;
  if (!loginId || !password) return null;
  return { loginId, password, campaignId: String(process.env.HB_COC_CAMPAIGN_ID || '15') };
}

async function cocPost(endpoint, c, params) {
  const body = new URLSearchParams({ loginId: c.loginId, password: c.password });
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    body.append(k, v === null ? '' : String(v));
  }
  const r = await axios.post(`${COC}/${endpoint}/`, body.toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 45000,
  });
  return r.data;
}
const ok = (d) => String(d?.result || '').replace(/,$/, '') === 'SUCCESS';
const errMsg = (d) => (typeof d?.message === 'string' ? d.message : JSON.stringify(d?.message || d)).slice(0, 300);

async function campaignProducts(c) {
  const d = await cocPost('campaign/query', c, { campaignId: c.campaignId });
  if (!ok(d)) throw new Error(`campaign/query: ${errMsg(d)}`);
  const camp = d.message?.data?.[c.campaignId] || Object.values(d.message?.data || {})[0];
  return camp?.products || [];
}
const findCp = (list, cpid) => list.find((p) => String(p.campaignProductId) === String(cpid));

// ---- store ----
function readStore() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { products: [] }; }
}
function writeStore(s) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(s, null, 1));
  fs.renameSync(FILE + '.tmp', FILE);
}

// ---- validation ----
const money = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
function cleanName(s) { return String(s || '').replace(/['’]/g, '').replace(/\s+/g, ' ').trim(); } // CoC strips apostrophes anyway
function validate(input, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || input.name !== undefined) {
    out.name = cleanName(input.name);
    if (out.name.length < 3 || out.name.length > 100) errors.push('name must be 3–100 characters');
  }
  if (!partial) {
    out.sku = String(input.sku || '').trim();
    if (!out.sku || out.sku.length > 50) errors.push('sku is required (max 50 characters)');
  }
  for (const [key, max] of [['price', MAX_PRICE], ['shipPrice', MAX_SHIP]]) {
    if (partial && input[key] === undefined) continue;
    const n = money(input[key]);
    if (!Number.isFinite(n) || n < 0 || n > max) errors.push(`${key} must be a number from 0 to ${max}`);
    else out[key] = n.toFixed(2);
  }
  if (!partial) {
    out.category = input.category || 'products';
    if (!(out.category in CATEGORIES)) errors.push(`category must be one of: ${Object.keys(CATEGORIES).join(', ')}`);
    out.fulfillment = input.fulfillment || 'shipsem';
    if (!(out.fulfillment in FULFILLMENT)) errors.push(`fulfillment must be one of: ${Object.keys(FULFILLMENT).join(', ')}`);
  }
  return { errors, value: out };
}

// What a site product must look like once it exists in CoC.
function check(p, want) {
  const issues = [];
  if (!p) return ['campaign product not found on read-back'];
  if (Number(p.loadBalancerId) !== LOAD_BALANCER_ID) issues.push(`loadBalancerId is ${p.loadBalancerId ?? 'empty'}, expected ${LOAD_BALANCER_ID}`);
  if (p.billingCycleType !== 'ONE_TIME') issues.push(`billingCycleType is ${p.billingCycleType}`);
  if (p.productType !== 'OFFER') issues.push(`productType is ${p.productType}`);
  if (Number(p.cycle1_isShippable) !== 1) issues.push('not shippable');
  if (want.price !== undefined && Number(p.cycle1_price) !== Number(want.price)) issues.push(`price is ${p.cycle1_price}, expected ${want.price}`);
  if (want.shipPrice !== undefined && Number(p.cycle1_shipPrice) !== Number(want.shipPrice)) issues.push(`shipPrice is ${p.cycle1_shipPrice}, expected ${want.shipPrice}`);
  if (want.categoryId !== undefined && Number(p.productCategoryId) !== want.categoryId) issues.push(`category is ${p.productCategoryName} (${p.productCategoryId}), expected ${want.categoryId}`);
  if (want.fulfillmentHouseId !== undefined && (p.fulfillmentHouseId ?? null) !== want.fulfillmentHouseId
    && Number(p.fulfillmentHouseId) !== want.fulfillmentHouseId) issues.push(`fulfillmentHouseId is ${p.fulfillmentHouseId}, expected ${want.fulfillmentHouseId}`);
  if (String(p.descriptor || '').toUpperCase() !== DESCRIPTOR) issues.push(`descriptor is ${p.descriptor}`);
  return issues;
}

function campaignProductParams(c, v, productId) {
  return {
    campaignId: c.campaignId, productId, productType: 'OFFER', billingCycleType: 'ONE_TIME',
    cycle1_price: v.price, cycle1_shipPrice: v.shipPrice, cycle1_isShippable: 1, cycle1_productId: productId,
    descriptor: DESCRIPTOR, displayName: v.name, storefront: 1, showToAffiliates: 1,
    loadBalancerId: LOAD_BALANCER_ID, // not in CoC's published docs; read-back verifies it took
  };
}

// ---- email ----
async function notify(subject, lines) {
  const user = process.env.GMAIL_USER;
  const pass = String(process.env.GMAIL_APP_PASSWORD || '').replace(/[\s ]/g, '');
  if (!user || !pass) return;
  try {
    const transport = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
    await transport.sendMail({
      from: `2by4 Dash <${user}>`, to: process.env.HB_PRODUCT_NOTIFY_TO || 'alan@2by4llc.com',
      subject, text: lines.join('\n'),
    });
  } catch (e) { console.error('[hb-products] email failed:', e.message); }
}
const todo = (cpid, name) => [
  '',
  'Still manual for a new product:',
  `- Ledger Offers row for ${cpid}`,
  `- Dash hb-ghl-sync tag + HB support prompt line for ${cpid} (${name})`,
];

// ---- create ----
async function createProduct(input) {
  const c = creds(); if (!c) return { status: 503, body: { ok: false, error: 'not_configured' } };
  const { errors, value: v } = validate(input);
  if (errors.length) return { status: 400, body: { ok: false, error: 'invalid', details: errors } };
  const categoryId = CATEGORIES[v.category], fulfillmentHouseId = FULFILLMENT[v.fulfillment];

  const existing = await campaignProducts(c);
  const store = readStore();
  const mine = store.products.find((p) => p.sku.toLowerCase() === v.sku.toLowerCase());
  if (mine) { // idempotent retry: same SKU already created by the site
    const p = findCp(existing, mine.campaignProductId);
    return { status: 200, body: { ok: true, existed: true, campaignProductId: mine.campaignProductId, productId: mine.productId, ready: !check(p, {}).length, issues: check(p, {}) } };
  }
  const clash = existing.find((p) => String(p.productSku || '').toLowerCase() === v.sku.toLowerCase());
  if (clash) return { status: 409, body: { ok: false, error: 'sku_in_use', campaignProductId: clash.campaignProductId, details: [`SKU already used by campaign product ${clash.campaignProductId} (${clash.productName})`] } };

  const productParams = { productName: v.name, productSku: v.sku, productCategoryId: categoryId };
  if (input.dryRun) {
    return { status: 200, body: { ok: true, dryRun: true, productCreate: productParams, fulfillmentHouseId, campaignProductCreate: campaignProductParams(c, v, '<new productId>') } };
  }

  const r1 = await cocPost('product/create', c, productParams);
  if (!ok(r1) || !r1.message?.productId) return { status: 502, body: { ok: false, error: 'product_create_failed', details: [errMsg(r1)] } };
  const productId = r1.message.productId;
  const warnings = [];

  if (fulfillmentHouseId !== null) { // create has no fulfillmentHouseId; set it with update
    const r = await cocPost('product/update', c, { productId, ...productParams, fulfillmentHouseId });
    if (!ok(r)) warnings.push(`product/update (fulfillment house) failed: ${errMsg(r)}`);
  }

  const r2 = await cocPost('campaign/product/create', c, campaignProductParams(c, v, productId));
  if (!ok(r2) || !r2.message?.campaignProductId) {
    await notify(`[HB product] FAILED: ${v.name}`, [`Base product ${productId} was created, but the campaign product failed:`, errMsg(r2)]);
    return { status: 502, body: { ok: false, error: 'campaign_product_create_failed', productId, details: [errMsg(r2)] } };
  }
  const cpid = r2.message.campaignProductId;
  const want = { price: v.price, shipPrice: v.shipPrice, categoryId, fulfillmentHouseId };

  let p = findCp(await campaignProducts(c), cpid);
  let issues = check(p, want);
  if (issues.some((i) => i.startsWith('loadBalancerId'))) { // retry via update if create ignored it
    const r = await cocPost('campaign/product/update', c, { ...campaignProductParams(c, v, productId), campaignProductId: cpid });
    if (!ok(r)) warnings.push(`campaign/product/update (load balancer) failed: ${errMsg(r)}`);
    p = findCp(await campaignProducts(c), cpid);
    issues = check(p, want);
  }
  const ready = issues.length === 0;

  store.products.push({ campaignProductId: cpid, productId, name: v.name, sku: v.sku, price: v.price, shipPrice: v.shipPrice,
    category: v.category, fulfillment: v.fulfillment, createdAt: new Date().toISOString(), ready, issues });
  writeStore(store);
  console.log('[hb-products] created', cpid, productId, v.sku, ready ? 'ready' : `NOT READY: ${issues.join('; ')}`);

  await notify(`[HB product] ${ready ? 'Created' : 'NEEDS FIX'}: ${cpid} ${v.name}`, [
    `Campaign product ${cpid} (base product ${productId}) in campaign ${c.campaignId}, created by the Lovable site.`,
    `Name: ${v.name}`, `SKU: ${v.sku}`, `Price: $${v.price} + $${v.shipPrice} S&H`,
    `Category: ${v.category} | Fulfillment: ${v.fulfillment} | Load balancer: ${p?.loadBalancerName || p?.loadBalancerId || 'NONE'}`,
    ...(ready ? [] : ['', 'NOT READY. Orders on this product may fail until fixed in CoC:', ...issues.map((i) => `- ${i}`)]),
    ...warnings.map((w) => `Warning: ${w}`),
    ...todo(cpid, v.name),
  ]);
  return { status: 200, body: { ok: true, ready, campaignProductId: cpid, productId, issues, warnings } };
}

// ---- update (site-created products only; name / price / shipping) ----
async function updateProduct(input) {
  const c = creds(); if (!c) return { status: 503, body: { ok: false, error: 'not_configured' } };
  const cpid = String(input.campaignProductId || '');
  const store = readStore();
  const rec = store.products.find((p) => String(p.campaignProductId) === cpid);
  if (!rec) return { status: 403, body: { ok: false, error: 'not_site_product', details: ['Only products created through this endpoint can be updated here.'] } };
  const { errors, value: patch } = validate(input, { partial: true });
  if (errors.length) return { status: 400, body: { ok: false, error: 'invalid', details: errors } };
  if (!Object.keys(patch).length) return { status: 400, body: { ok: false, error: 'nothing_to_update' } };

  const before = findCp(await campaignProducts(c), cpid);
  if (!before) return { status: 404, body: { ok: false, error: 'not_found_in_coc' } };
  const v = {
    name: patch.name ?? before.productName,
    price: patch.price ?? before.cycle1_price,
    shipPrice: patch.shipPrice ?? before.cycle1_shipPrice,
  };
  if (input.dryRun) return { status: 200, body: { ok: true, dryRun: true, campaignProductUpdate: { ...campaignProductParams(c, v, before.productId), campaignProductId: cpid } } };

  const r = await cocPost('campaign/product/update', c, { ...campaignProductParams(c, v, before.productId), campaignProductId: cpid });
  if (!ok(r)) return { status: 502, body: { ok: false, error: 'update_failed', details: [errMsg(r)] } };
  if (patch.name) {
    const r3 = await cocPost('product/update', c, { productId: before.productId, productName: v.name, productSku: before.productSku, productCategoryId: Number(before.productCategoryId) });
    if (!ok(r3)) console.error('[hb-products] base rename failed:', errMsg(r3));
  }

  const after = findCp(await campaignProducts(c), cpid);
  const issues = check(after, { price: v.price, shipPrice: v.shipPrice });
  const expected = new Set(['productName', 'baseProductName', 'cycle1_price', 'price', 'cycle1_shipPrice', 'shippingPrice']);
  const unexpected = Object.keys(before).filter((k) => !expected.has(k) && JSON.stringify(before[k]) !== JSON.stringify(after?.[k]))
    .map((k) => `${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after?.[k])}`);
  Object.assign(rec, { name: v.name, price: v.price, shipPrice: v.shipPrice, updatedAt: new Date().toISOString(), ready: !issues.length, issues });
  writeStore(store);
  const ready = !issues.length && !unexpected.length;
  await notify(`[HB product] ${ready ? 'Updated' : 'UPDATE NEEDS CHECK'}: ${cpid} ${v.name}`, [
    `Before: ${before.productName} $${before.cycle1_price} + $${before.cycle1_shipPrice}`,
    `After:  ${after?.productName} $${after?.cycle1_price} + $${after?.cycle1_shipPrice}`,
    ...issues.map((i) => `Issue: ${i}`), ...unexpected.map((u) => `Unexpected change: ${u}`),
  ]);
  return { status: 200, body: { ok: true, ready, campaignProductId: cpid, issues, unexpectedChanges: unexpected } };
}

// ---- list ----
async function listProducts() {
  const c = creds(); if (!c) return { status: 503, body: { ok: false, error: 'not_configured' } };
  const store = readStore();
  const live = store.products.length ? await campaignProducts(c) : [];
  return { status: 200, body: { ok: true, products: store.products.map((r) => {
    const p = findCp(live, r.campaignProductId);
    const issues = check(p, {});
    return { campaignProductId: r.campaignProductId, productId: r.productId, name: p?.productName ?? r.name, sku: r.sku,
      price: p?.cycle1_price ?? r.price, shipPrice: p?.cycle1_shipPrice ?? r.shipPrice, category: r.category,
      fulfillment: r.fulfillment, createdAt: r.createdAt, ready: !issues.length, issues };
  }) } };
}

module.exports = { createProduct, updateProduct, listProducts, _validate: validate, _check: check };

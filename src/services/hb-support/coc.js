// Checkout Champ reads + the few writes the support agent may make. Uses the
// happybaker-site-api user (IP-whitelisted to Dash). Writes: full refund + cancel of
// an order, partial refund, cancel a subscription (purchase), change a tee's size,
// customer note.
const axios = require('axios');

const BASE = 'https://api.checkoutchamp.com';
const FUNNEL_LAUNCH = '09/01/2026';
const SHIPPED = /^(SHIPPED|DELIVERED|RETURNED|RMA_PENDING)$/;
const LIVE_PURCHASE = /^(ACTIVE|TRIAL|PAUSED|RECYCLE_BILLING)$/;

const mdy = (d) => `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;

function creds() {
  const loginId = process.env.HB_COC_LOGIN_ID, password = process.env.HB_COC_PASSWORD;
  if (!loginId || !password) throw new Error('HB_COC_LOGIN_ID / HB_COC_PASSWORD missing');
  return { loginId, password };
}

async function call(endpoint, params) {
  const body = new URLSearchParams(creds());
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  const r = await axios.post(`${BASE}/${endpoint}/`, body.toString(), { headers: { 'content-type': 'application/x-www-form-urlencoded' }, timeout: 45000 });
  return r.data;
}

async function query(endpoint, params) {
  const j = await call(endpoint, { startDate: FUNNEL_LAUNCH, endDate: mdy(new Date(Date.now() + 86400000)), resultsPerPage: 100, ...params });
  if (j.result === 'SUCCESS') return (j.message && j.message.data) || [];
  if (/no .*found/i.test(JSON.stringify(j.message))) return [];
  throw new Error(`CoC ${endpoint}: ${JSON.stringify(j.message).slice(0, 200)}`);
}

async function write(endpoint, params) {
  const j = await call(endpoint, params);
  if (j.result !== 'SUCCESS') throw new Error(`CoC ${endpoint}: ${JSON.stringify(j.message).slice(0, 200)}`);
  return typeof j.message === 'string' ? j.message : 'ok';
}

const list = (x) => (x && typeof x === 'object' ? Object.values(x) : []);

// Everything about one customer the agent (and Alan) needs, compact enough for a prompt.
async function snapshot(email) {
  const orders = (await query('order/query', { emailAddress: email, campaignId: process.env.HB_COC_CAMPAIGN_ID || '15' }))
    .filter((o) => String(o.emailAddress || '').toLowerCase() === email.toLowerCase());
  const customerIds = [...new Set(orders.map((o) => o.customerId).filter(Boolean))];
  const purchases = [];
  for (const customerId of customerIds) purchases.push(...await query('purchase/query', { customerId }));
  return {
    email,
    customerIds,
    name: orders[0] ? `${orders[0].firstName || ''} ${orders[0].lastName || ''}`.trim() : null,
    orders: orders.map((o) => {
      const fulfillments = list(o.fulfillments).map((f) => ({
        id: f.fulfillmentId, status: f.status, dateShipped: f.dateShipped, tracking: f.trackingNumber,
        items: list(f.items).map((i) => ({ id: i.fulfillmentItemId, name: i.name, sku: i.sku, productId: Number(i.productId), purchaseId: i.purchaseId || null })),
      }));
      return {
        orderId: o.orderId, customerId: o.customerId, type: o.orderType, status: o.orderStatus, date: o.dateCreated,
        total: Number(o.totalAmount || 0), refundRemaining: Number(o.refundRemaining || 0),
        card: [o.cardType, o.cardLast4].filter(Boolean).join(' ending in '),
        items: list(o.items).map((i) => ({ productId: Number(i.productId), name: i.name, price: Number(i.price || 0), shipping: Number(i.shipping || 0), purchaseId: i.purchaseId || null, purchaseStatus: i.purchaseStatus || null, nextBillDate: i.nextBillDate || null })),
        fulfillments,
        shipped: fulfillments.some((f) => SHIPPED.test(String(f.status || '')) || f.tracking || f.dateShipped),
      };
    }),
    purchases: purchases.map((p) => ({
      purchaseId: p.purchaseId, orderId: p.orderId, productId: Number(p.productId), product: p.productName, status: p.status, price: Number(p.price || 0),
      nextBillDate: p.nextBillDate, cycle: p.billingCycleNumber, totalBilled: Number(p.totalBilled || 0), live: LIVE_PURCHASE.test(String(p.status || '')),
    })),
  };
}

const refundOrder = (orderId, reason) => write('order/cancel', { orderId, cancelReason: reason.slice(0, 100), fullRefund: 'true' });
const partialRefund = (orderId, amount, reason) => write('order/refund', { orderId, refundAmount: Number(amount).toFixed(2), refundReason: reason });
const cancelPurchase = (purchaseId, reason) => write('purchase/cancel', { purchaseId, cancelReason: reason.slice(0, 100), cancelFulfillment: 'true' });
const addNote = (customerId, message) => write('customer/addnote', { customerId, message: message.slice(0, 500) });

// Happy Baker Monthly Tee, one campaign product per size (same $18 → $26.95 + $5 cycles;
// 2XL $27.95, 3XL/4XL $28.95 from the 2nd bill). The SKU is what the fulfillment ships.
const TEE_SIZES = {
  S: { campaignProductId: 257, sku: 'HB- Tshirt- Baking Is My Happy Place (S)' },
  M: { campaignProductId: 259, sku: 'HB- Tshirt- Baking Is My Happy Place (M)' },
  L: { campaignProductId: 261, sku: 'HB- Tshirt- Baking Is My Happy Place (L)' },
  XL: { campaignProductId: 263, sku: 'HB- Tshirt- Baking Is My Happy Place (XL)' },
  '2XL': { campaignProductId: 265, sku: 'HB- Tshirt- Baking Is My Happy Place (2XL)' },
  '3XL': { campaignProductId: 267, sku: 'HB- Tshirt- Baking Is My Happy Place (3XL)' },
  '4XL': { campaignProductId: 269, sku: 'HB- Tshirt- Baking Is My Happy Place (4XL)' },
};
const TEE_PRODUCT_IDS = new Set(Object.values(TEE_SIZES).map((t) => t.campaignProductId));

// Switch a tee subscription to another size: future rebills bill + ship the new size, and
// the tee still waiting in an unshipped fulfillment gets the new SKU. Re-reads the purchase
// afterwards, so "done" means Checkout Champ actually shows the new product.
async function changeTeeSize(purchaseId, size, unshippedItems = []) {
  const t = TEE_SIZES[size];
  if (!t) throw new Error(`unknown tee size ${size}`);
  await write('purchase/update', { purchaseId, productId: t.campaignProductId });
  // fulfillment/update requires a fulfillmentStatus and only accepts PENDING/SHIPPED/…/FREEZE,
  // so a HOLD fulfillment can't keep its status: re-sending PENDING only where it already is.
  const held = [];
  for (const i of unshippedItems) {
    if (i.status === 'PENDING') await write('fulfillment/update', { fulfillmentId: i.fulfillmentId, fulfillmentStatus: 'PENDING', fulfillmentItem1_Id: i.id, fulfillmentItem1_sku: t.sku });
    else held.push(`${i.fulfillmentId} (${i.status})`);
  }
  const [p] = await query('purchase/query', { purchaseId });
  if (!p || Number(p.productId) !== t.campaignProductId) throw new Error(`purchase ${purchaseId} still shows product ${p && p.productId} after the update`);
  const fixed = unshippedItems.length - held.length;
  return `subscription now ${p.displayName || p.productName}${fixed ? `; ${fixed} unshipped tee set to ${t.sku}` : ''}${held.length ? `; tee in fulfillment ${held.join(', ')} left as-is (CoC can't edit it without releasing the hold), so check the shipping order's size` : ''}`;
}

module.exports = { snapshot, refundOrder, partialRefund, cancelPurchase, changeTeeSize, addNote, TEE_SIZES, TEE_PRODUCT_IDS, SHIPPED, LIVE_PURCHASE };

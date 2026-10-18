// Checkout Champ reads + the few writes the support agent may make. Uses the
// happybaker-site-api user (IP-whitelisted to Dash). Writes: full refund + cancel of
// an order, partial refund, cancel a subscription (purchase), customer note.
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
        items: list(f.items).map((i) => i.name),
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
      purchaseId: p.purchaseId, orderId: p.orderId, product: p.productName, status: p.status, price: Number(p.price || 0),
      nextBillDate: p.nextBillDate, cycle: p.billingCycleNumber, totalBilled: Number(p.totalBilled || 0), live: LIVE_PURCHASE.test(String(p.status || '')),
    })),
  };
}

const refundOrder = (orderId, reason) => write('order/cancel', { orderId, cancelReason: reason.slice(0, 100), fullRefund: 'true' });
const partialRefund = (orderId, amount, reason) => write('order/refund', { orderId, refundAmount: Number(amount).toFixed(2), refundReason: reason });
const cancelPurchase = (purchaseId, reason) => write('purchase/cancel', { purchaseId, cancelReason: reason.slice(0, 100), cancelFulfillment: 'true' });
const addNote = (customerId, message) => write('customer/addnote', { customerId, message: message.slice(0, 500) });

module.exports = { snapshot, refundOrder, partialRefund, cancelPurchase, addNote, SHIPPED, LIVE_PURCHASE };

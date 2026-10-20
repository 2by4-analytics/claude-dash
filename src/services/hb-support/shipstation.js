// ShipStation V1 for the Happy Bakers stores. The account is shared with BGC's stores,
// so every read is limited to HB_STORE_IDS and every write re-checks the order's store.
const axios = require('axios');

const BASE = 'https://ssapi.shipstation.com';
const HB_STORE_IDS = (process.env.HB_SHIPSTATION_STORE_IDS || '4905682,4905795,4910136').split(',').map(Number);

function http() {
  const key = process.env.SHIPSTATION_API_KEY, secret = process.env.SHIPSTATION_API_SECRET;
  if (!key || !secret) throw new Error('SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET missing');
  return axios.create({ baseURL: BASE, timeout: 30000, headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } });
}

async function awaitingShipment() {
  const out = [];
  for (const storeId of HB_STORE_IDS) {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const r = await http().get('/orders', { params: { orderStatus: 'awaiting_shipment', storeId, pageSize: 500, page } });
      out.push(...(r.data.orders || []));
      pages = r.data.pages || 1;
    }
  }
  return out;
}

const getOrder = async (orderId) => (await http().get(`/orders/${orderId}`)).data;
const isHb = (o) => HB_STORE_IDS.includes(Number(o.advancedOptions && o.advancedOptions.storeId));
const badAddress = (o) => /warning|fail/i.test(String(o.shipTo && o.shipTo.addressVerified || ''));

// V1 has no cancel endpoint: createorder upserts on orderKey, so post the whole order back
// with a new status (a partial body would blank the fields left out).
async function cancelOrder(orderId, note) {
  const o = await getOrder(orderId);
  if (!isHb(o)) throw new Error(`order ${o.orderNumber} is not in a Happy Bakers store`);
  const internalNotes = [o.internalNotes, note].filter(Boolean).join('\n');
  // Some imported orders carry billToParty without billToMyOtherAccount, and ShipStation
  // rejects them on the way back in (400 "'billToMyOtherAccount' is required", 10-20).
  const advancedOptions = { ...o.advancedOptions };
  if (advancedOptions.billToParty && !advancedOptions.billToMyOtherAccount) {
    for (const k of ['billToParty', 'billToAccount', 'billToPostalCode', 'billToCountryCode', 'billToMyOtherAccount']) delete advancedOptions[k];
  }
  const r = await http().post('/orders/createorder', { ...o, advancedOptions, orderStatus: 'cancelled', internalNotes });
  if (r.data.orderStatus !== 'cancelled') throw new Error(`ShipStation left ${o.orderNumber} as ${r.data.orderStatus}`);
  return r.data;
}

module.exports = { awaitingShipment, getOrder, cancelOrder, isHb, badAddress, HB_STORE_IDS };

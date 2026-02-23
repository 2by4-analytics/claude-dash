const axios = require('axios');

const COC_BASE = 'https://api.checkoutchamp.com';

function fmtDate(d) {
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`;
}

async function fetchAllPages(url, params) {
  let page = 1;
  let allRecords = [];
  let totalResults = null;

  while (true) {
    try {
      const r = await axios.get(url, { params: { ...params, page } });
      const data = r.data;
      if (data.result !== 'SUCCESS') break;

      const msg = data.message;
      if (totalResults === null) totalResults = msg.totalResults || 0;

      const records = msg.data || [];
      allRecords = allRecords.concat(records);

      if (allRecords.length >= totalResults || records.length === 0) break;
      page++;
    } catch (err) {
      console.error('fetchAllPages error:', err.message);
      break;
    }
  }

  return allRecords;
}

/**
 * Fetch COMPLETE orders (these are the "Sales" in COC dashboard)
 * Uses order/query with orderStatus=COMPLETE + orderType=NEW_SALE
 */
async function fetchCompleteOrders(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  const params = {
    loginId,
    password,
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    orderStatus: 'COMPLETE',
    orderType: 'NEW_SALE',
    resultsPerPage: 200,
    ...extraParams,
  };
  return fetchAllPages(`${COC_BASE}/order/query/`, params);
}

/**
 * Fetch PARTIAL orders
 */
async function fetchPartialOrders(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  const params = {
    loginId,
    password,
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    orderStatus: 'PARTIAL',
    orderType: 'NEW_SALE',
    resultsPerPage: 200,
    ...extraParams,
  };
  return fetchAllPages(`${COC_BASE}/order/query/`, params);
}

/**
 * Fetch declined transactions (billingCycle 1 NEW_SALE only)
 */
async function fetchDeclinedTransactions(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  const params = {
    loginId,
    password,
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    txnType: 'SALE',
    responseType: 'SOFT_DECLINE',
    resultsPerPage: 200,
    ...extraParams,
  };

  const allRecords = await fetchAllPages(`${COC_BASE}/transactions/query/`, params);

  // Filter to cycle-1 only, deduplicate by orderId
  const cycle1 = allRecords.filter(row => parseInt(row.billingCycleNumber) === 1);
  const orderMap = new Map();
  for (const row of cycle1) {
    const key = row.orderId || row.actualOrderId;
    if (!orderMap.has(key)) orderMap.set(key, row);
  }
  return Array.from(orderMap.values());
}

/**
 * Build metrics from complete orders + declines + partials
 * Revenue comes from order.totalAmount on COMPLETE orders
 */
function buildMetrics(completeOrders, declinesCount, partials) {
  const sales = completeOrders.length;
  let salesTotal = 0;
  let upsells = 0;
  let upsellTotal = 0;
  let shipping = 0;
  const refundAmt = 0;

  for (const order of completeOrders) {
    // COC "Sales Total" = product amount + shipping + sales tax
    const orderAmt = parseFloat(order.totalAmount || 0);
    const orderShipping = parseFloat(order.baseShipping || 0);
    const orderTax = parseFloat(order.salesTax || 0);
    salesTotal += orderAmt + orderShipping + orderTax;

    // Check items for upsells
    const items = order.items || {};
    for (const item of Object.values(items)) {
      shipping += parseFloat(item.shipping || 0);
      if (item.productType === 'UPSALE') {
        upsells++;
        upsellTotal += parseFloat(item.price || 0);
      }
    }
  }

  const declines = declinesCount;
  const totalAttempts = partials + sales + declines;
  const convRate = totalAttempts > 0 ? (sales / totalAttempts * 100) : 0;
  const declineRate = (sales + declines) > 0 ? (declines / (sales + declines) * 100) : 0;
  const salesRate = totalAttempts > 0 ? (sales / totalAttempts * 100) : 0;
  const netRevenue = salesTotal + upsellTotal - refundAmt;
  const avgTicket = sales > 0 ? (salesTotal / sales) : 0;

  return {
    partials,
    convRate,
    declines,
    declineRate,
    sales,
    salesRate,
    salesTotal,
    upsells,
    upsellTotal,
    refundAmt,
    shipping,
    netRevenue,
    avgTicket,
  };
}

async function getCocCampaignTotals(loginId, password, campaignId, dateStart, dateStop) {
  try {
    const [complete, declines, partials] = await Promise.all([
      fetchCompleteOrders(loginId, password, campaignId, dateStart, dateStop),
      fetchDeclinedTransactions(loginId, password, campaignId, dateStart, dateStop),
      fetchPartialOrders(loginId, password, campaignId, dateStart, dateStop),
    ]);
    return buildMetrics(complete, declines.length, partials.length);
  } catch (err) {
    console.error('getCocCampaignTotals error:', err.message);
    return null;
  }
}

async function getCocHierarchy(loginId, password, campaignId, dateStart, dateStop, fbCampaignNames) {
  const results = {};

  for (const campaignName of fbCampaignNames) {
    try {
      const utmParams = { UTMCampaign: campaignName };

      const [complete, declines, partials] = await Promise.all([
        fetchCompleteOrders(loginId, password, campaignId, dateStart, dateStop, utmParams),
        fetchDeclinedTransactions(loginId, password, campaignId, dateStart, dateStop, utmParams),
        fetchPartialOrders(loginId, password, campaignId, dateStart, dateStop, utmParams),
      ]);

      // Group by UTMMedium (adset), then UTMContent (ad)
      const adsetMap = {};

      const groupIntoAdsets = (orders, type) => {
        for (const row of orders) {
          const adsetName = (row.UTMMedium || '').trim();
          if (!adsetMap[adsetName]) adsetMap[adsetName] = { complete: [], declines: [], partials: [] };
          adsetMap[adsetName][type].push(row);
        }
      };

      groupIntoAdsets(complete, 'complete');
      groupIntoAdsets(declines, 'declines');
      groupIntoAdsets(partials, 'partials');

      const adsets = {};
      for (const [adsetName, adsetData] of Object.entries(adsetMap)) {
        const adMap = {};

        const groupIntoAds = (orders, type) => {
          for (const row of orders) {
            const adName = (row.UTMContent || '').trim();
            if (!adMap[adName]) adMap[adName] = { complete: [], declines: [], partials: [] };
            adMap[adName][type].push(row);
          }
        };

        groupIntoAds(adsetData.complete, 'complete');
        groupIntoAds(adsetData.declines, 'declines');
        groupIntoAds(adsetData.partials, 'partials');

        const ads = {};
        for (const [adName, adData] of Object.entries(adMap)) {
          ads[adName] = buildMetrics(adData.complete, adData.declines.length, adData.partials.length);
        }

        adsets[adsetName] = {
          cocData: buildMetrics(adsetData.complete, adsetData.declines.length, adsetData.partials.length),
          ads,
        };
      }

      results[campaignName] = {
        cocData: buildMetrics(complete, declines.length, partials.length),
        adsets,
      };
    } catch (err) {
      console.error(`getCocHierarchy error for "${campaignName}":`, err.message);
      results[campaignName] = { cocData: null, adsets: {}, error: err.message };
    }
  }

  return results;
}

module.exports = { getCocHierarchy, getCocCampaignTotals };

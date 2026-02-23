const axios = require('axios');

const COC_BASE = 'https://api.checkoutchamp.com';

function fmtDate(d) {
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`;
}

/**
 * Fetch ALL pages from an endpoint
 */
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
 * Fetch all transactions - filter client-side for NEW_SALE + billingCycle 1
 * The API ignores orderType filter so we must filter after fetching
 */
async function fetchNewSaleTransactions(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  const params = {
    loginId,
    password,
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    txnType: 'SALE',
    responseType: 'SUCCESS',
    resultsPerPage: 200,
    ...extraParams,
  };

  const allRecords = await fetchAllPages(`${COC_BASE}/transactions/query/`, params);

  // Filter client-side: only NEW_SALE, billingCycleNumber === 1
  return allRecords.filter(row =>
    row.orderType === 'NEW_SALE' &&
    parseInt(row.billingCycleNumber) === 1
  );
}

/**
 * Fetch declined transactions (NEW_SALE only, billingCycle 1)
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

  return allRecords.filter(row =>
    row.orderType === 'NEW_SALE' &&
    parseInt(row.billingCycleNumber) === 1
  );
}

/**
 * Fetch partials count using order/query with orderStatus=PARTIAL + orderType=NEW_SALE
 */
async function fetchPartialsCount(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  try {
    const r = await axios.get(`${COC_BASE}/order/query/`, {
      params: {
        loginId,
        password,
        campaignId,
        startDate: fmtDate(dateStart),
        endDate: fmtDate(dateStop),
        orderStatus: 'PARTIAL',
        orderType: 'NEW_SALE',
        resultsPerPage: 1,
        ...extraParams,
      }
    });
    if (r.data?.result === 'SUCCESS') {
      return r.data.message?.totalResults || 0;
    }
    return 0;
  } catch (err) {
    return 0;
  }
}

/**
 * Build metrics from sales records + declines count + partials count
 */
function buildMetrics(salesRecords, declinesCount, partials) {
  let sales = salesRecords.length;
  let salesTotal = 0;
  let upsells = 0;
  let upsellTotal = 0;
  let refundAmt = 0;
  let shipping = 0;

  for (const row of salesRecords) {
    const amt = parseFloat(row.totalAmount || 0);
    salesTotal += amt;

    // Check items for upsells
    for (const item of row.items || []) {
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

/**
 * Get overall COC totals for a campaign (no UTM filter)
 */
async function getCocCampaignTotals(loginId, password, campaignId, dateStart, dateStop) {
  try {
    const [sales, declines, partials] = await Promise.all([
      fetchNewSaleTransactions(loginId, password, campaignId, dateStart, dateStop),
      fetchDeclinedTransactions(loginId, password, campaignId, dateStart, dateStop),
      fetchPartialsCount(loginId, password, campaignId, dateStart, dateStop),
    ]);
    return buildMetrics(sales, declines.length, partials);
  } catch (err) {
    console.error('getCocCampaignTotals error:', err.message);
    return null;
  }
}

/**
 * Get COC hierarchy per FB campaign (utm_campaign), building adset/ad breakdown
 */
async function getCocHierarchy(loginId, password, campaignId, dateStart, dateStop, fbCampaignNames) {
  const results = {};

  for (const campaignName of fbCampaignNames) {
    try {
      const utmParams = { UTMCampaign: campaignName };

      const [sales, declines, partials] = await Promise.all([
        fetchNewSaleTransactions(loginId, password, campaignId, dateStart, dateStop, utmParams),
        fetchDeclinedTransactions(loginId, password, campaignId, dateStart, dateStop, utmParams),
        fetchPartialsCount(loginId, password, campaignId, dateStart, dateStop, utmParams),
      ]);

      // Group by UTMMedium (adset), then UTMContent (ad)
      const adsetMap = {};
      for (const row of [...sales, ...declines]) {
        const adsetName = (row.UTMMedium || '').trim();
        if (!adsetMap[adsetName]) adsetMap[adsetName] = { sales: [], declines: [] };
        if (row.responseType === 'SUCCESS') {
          adsetMap[adsetName].sales.push(row);
        } else {
          adsetMap[adsetName].declines.push(row);
        }
      }

      const adsets = {};
      for (const [adsetName, adsetData] of Object.entries(adsetMap)) {
        const adMap = {};
        for (const row of [...adsetData.sales, ...adsetData.declines]) {
          const adName = (row.UTMContent || '').trim();
          if (!adMap[adName]) adMap[adName] = { sales: [], declines: [] };
          if (row.responseType === 'SUCCESS') {
            adMap[adName].sales.push(row);
          } else {
            adMap[adName].declines.push(row);
          }
        }

        const ads = {};
        for (const [adName, adData] of Object.entries(adMap)) {
          ads[adName] = buildMetrics(adData.sales, adData.declines.length, 0);
        }

        adsets[adsetName] = {
          cocData: buildMetrics(adsetData.sales, adsetData.declines.length, 0),
          ads,
        };
      }

      results[campaignName] = {
        cocData: buildMetrics(sales, declines.length, partials),
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

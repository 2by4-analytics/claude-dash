const axios = require('axios');

const COC_BASE = 'https://api.checkoutchamp.com';

function fmtDate(d) {
  // COC expects M/D/YY
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`;
}

/**
 * Fetch ALL pages from transactions/query
 */
async function fetchAllTransactions(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  const baseParams = {
    loginId,
    password,
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    resultsPerPage: 200,
    orderType: "NEW_SALE",
    billingCycleNumber: 1,
    ...extraParams,
  };

  let page = 1;
  let allRecords = [];
  let totalResults = null;

  while (true) {
    try {
      const r = await axios.get(`${COC_BASE}/transactions/query/`, {
        params: { ...baseParams, page }
      });

      const data = r.data;
      if (data.result !== 'SUCCESS') break;

      const msg = data.message;
      if (totalResults === null) totalResults = msg.totalResults || 0;

      const records = msg.data || [];
      allRecords = allRecords.concat(records);

      // Stop if we have all records
      if (allRecords.length >= totalResults || records.length === 0) break;
      page++;
    } catch (err) {
      console.error('fetchAllTransactions page error:', err.message);
      break;
    }
  }

  return allRecords;
}

/**
 * Aggregate transaction records into metrics
 */
function aggregateTransactions(records) {
  let sales = 0, declines = 0, salesTotal = 0;
  let upsells = 0, upsellTotal = 0, refundAmt = 0;
  let shipping = 0;

  for (const row of records) {
    const type = (row.txnType || '').toUpperCase();
    const status = (row.responseType || '').toUpperCase();
    const amt = parseFloat(row.totalAmount || 0);

    if (type === 'SALE' && status === 'SUCCESS') {
      sales++;
      salesTotal += amt;
      // Sum shipping from items
      for (const item of row.items || []) {
        shipping += parseFloat(item.shipping || 0);
      }
    } else if (type === 'SALE' && status !== 'SUCCESS') {
      declines++;
    } else if ((type === 'UPSALE' || type === 'UPSELL') && status === 'SUCCESS') {
      upsells++;
      upsellTotal += amt;
    } else if (type === 'REFUND') {
      refundAmt += Math.abs(amt);
    }
  }

  return { sales, declines, salesTotal, upsells, upsellTotal, refundAmt, shipping };
}

/**
 * Build full metrics object from transactions + partial count
 */
function buildMetrics(txnMetrics, partials) {
  const { sales, declines, salesTotal, upsells, upsellTotal, refundAmt, shipping } = txnMetrics;
  const total = (partials || 0) + sales + declines;
  const convRate = total > 0 ? (sales / total * 100) : 0;
  const declineRate = (sales + declines) > 0 ? (declines / (sales + declines) * 100) : 0;
  const salesRate = total > 0 ? (sales / total * 100) : 0;
  const netRevenue = salesTotal + upsellTotal - refundAmt;
  const avgTicket = sales > 0 ? (salesTotal / sales) : 0;

  return {
    partials: partials || 0,
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
 * Fetch partials count for a campaign + optional UTM filters
 * COC uses /order/query/ with orderType=NEW_SALE for partials (abandoned checkouts)
 */
async function fetchPartials(loginId, password, campaignId, dateStart, dateStop, extraParams = {}) {
  try {
    const r = await axios.get(`${COC_BASE}/order/query/`, {
      params: {
        loginId,
        password,
        campaignId,
        startDate: fmtDate(dateStart),
        endDate: fmtDate(dateStop),
        orderStatus: 'PARTIAL',
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
 * Get overall COC totals for an entire campaign (no UTM filter)
 */
async function getCocCampaignTotals(loginId, password, campaignId, dateStart, dateStop) {
  try {
    const [records, partials] = await Promise.all([
      fetchAllTransactions(loginId, password, campaignId, dateStart, dateStop),
      fetchPartials(loginId, password, campaignId, dateStart, dateStop),
    ]);
    const txnMetrics = aggregateTransactions(records);
    return buildMetrics(txnMetrics, partials);
  } catch (err) {
    console.error('getCocCampaignTotals error:', err.message);
    return null;
  }
}

/**
 * Get COC data per FB campaign name (utm_campaign), building hierarchy
 * UTM field names in COC: UTMCampaign, UTMMedium, UTMContent
 */
async function getCocHierarchy(loginId, password, campaignId, dateStart, dateStop, fbCampaignNames) {
  const results = {};

  for (const campaignName of fbCampaignNames) {
    try {
      const utmParams = { UTMCampaign: campaignName };

      const [records, partials] = await Promise.all([
        fetchAllTransactions(loginId, password, campaignId, dateStart, dateStop, utmParams),
        fetchPartials(loginId, password, campaignId, dateStart, dateStop, utmParams),
      ]);

      // Group by UTMMedium (adset level)
      const adsetMap = {};
      for (const row of records) {
        const adsetName = (row.UTMMedium || '').trim();
        if (!adsetMap[adsetName]) adsetMap[adsetName] = [];
        adsetMap[adsetName].push(row);
      }

      // Build adset hierarchy
      const adsets = {};
      for (const [adsetName, adsetRecords] of Object.entries(adsetMap)) {
        // Group by UTMContent (ad level)
        const adMap = {};
        for (const row of adsetRecords) {
          const adName = (row.UTMContent || '').trim();
          if (!adMap[adName]) adMap[adName] = [];
          adMap[adName].push(row);
        }

        const ads = {};
        for (const [adName, adRecords] of Object.entries(adMap)) {
          ads[adName] = buildMetrics(aggregateTransactions(adRecords), 0);
        }

        adsets[adsetName] = {
          cocData: buildMetrics(aggregateTransactions(adsetRecords), 0),
          ads,
        };
      }

      results[campaignName] = {
        cocData: buildMetrics(aggregateTransactions(records), partials),
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

const axios = require('axios');

const COC_BASE = 'https://api.checkoutchamp.com';

/**
 * COC uses GET requests with loginId & password as query params.
 * Base URL: https://api.checkoutchamp.com
 * Example: https://api.checkoutchamp.com/transactions/query/?loginId=X&password=Y&...
 */

function baseParams(loginId, password) {
  return { loginId, password };
}

function fmtDate(d) {
  // COC expects M/D/YY format
  const [y, m, day] = d.split('-');
  return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`;
}

/**
 * Fetch order summary stats for a campaign using transactions/query
 * Returns aggregated: partials, sales, declines, revenue etc.
 */
async function getCocStats(loginId, password, campaignId, dateStart, dateStop, utmFilters = {}) {
  const params = {
    ...baseParams(loginId, password),
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    ...(utmFilters.utm_campaign ? { utmCampaign: utmFilters.utm_campaign } : {}),
    ...(utmFilters.utm_medium   ? { utmMedium:   utmFilters.utm_medium }   : {}),
    ...(utmFilters.utm_content  ? { utmContent:  utmFilters.utm_content }  : {}),
  };

  try {
    const r = await axios.get(`${COC_BASE}/transactions/query/`, { params });
    return r.data;
  } catch (err) {
    const msg = err.response?.data || err.message;
    throw new Error(`COC transactions/query error: ${JSON.stringify(msg)}`);
  }
}

/**
 * Fetch leads/partials for a campaign
 */
async function getCocLeads(loginId, password, campaignId, dateStart, dateStop, utmFilters = {}) {
  const params = {
    ...baseParams(loginId, password),
    campaignId,
    startDate: fmtDate(dateStart),
    endDate: fmtDate(dateStop),
    ...(utmFilters.utm_campaign ? { utmCampaign: utmFilters.utm_campaign } : {}),
    ...(utmFilters.utm_medium   ? { utmMedium:   utmFilters.utm_medium }   : {}),
    ...(utmFilters.utm_content  ? { utmContent:  utmFilters.utm_content }  : {}),
  };

  try {
    const r = await axios.get(`${COC_BASE}/leads/query/`, { params });
    return r.data;
  } catch (err) {
    return null; // non-fatal
  }
}

/**
 * Build COC metrics from raw transactions/query response
 */
function buildMetrics(txnData, leadData) {
  if (!txnData || txnData.result !== 'SUCCESS') return null;

  const records = txnData.message?.data || txnData.data || [];

  let sales = 0, declines = 0, salesTotal = 0, upsells = 0, upsellTotal = 0, refundAmt = 0;

  for (const row of records) {
    const type = (row.txnType || '').toUpperCase();
    const status = (row.responseType || row.response_type || '').toUpperCase();
    const amt = parseFloat(row.totalAmount || row.total_amount || row.amount || 0);

    if (type === 'SALE' && status === 'SUCCESS') {
      sales++;
      salesTotal += amt;
    } else if (type === 'SALE' && status !== 'SUCCESS') {
      declines++;
    } else if (type === 'UPSALE' && status === 'SUCCESS') {
      upsells++;
      upsellTotal += amt;
    } else if (type === 'REFUND') {
      refundAmt += amt;
    }
  }

  const partials = leadData?.message?.data?.length || leadData?.data?.length || 0;
  const total = partials + sales;
  const convRate = total > 0 ? (sales / total * 100) : 0;
  const declineRate = (sales + declines) > 0 ? (declines / (sales + declines) * 100) : 0;
  const salesRate = total > 0 ? (sales / total * 100) : 0;
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
    netRevenue,
    avgTicket,
  };
}

/**
 * Get overall COC totals for an entire campaign (no UTM filter)
 */
async function getCocCampaignTotals(loginId, password, campaignId, dateStart, dateStop) {
  try {
    const [txn, leads] = await Promise.all([
      getCocStats(loginId, password, campaignId, dateStart, dateStop),
      getCocLeads(loginId, password, campaignId, dateStart, dateStop),
    ]);
    return buildMetrics(txn, leads);
  } catch (err) {
    console.error('getCocCampaignTotals error:', err.message);
    return null;
  }
}

/**
 * Get COC data for each FB campaign name (as utm_campaign), then adsets and ads
 */
async function getCocHierarchy(loginId, password, campaignId, dateStart, dateStop, fbCampaignNames) {
  const results = {};

  for (const campaignName of fbCampaignNames) {
    try {
      const [txn, leads] = await Promise.all([
        getCocStats(loginId, password, campaignId, dateStart, dateStop, { utm_campaign: campaignName }),
        getCocLeads(loginId, password, campaignId, dateStart, dateStop, { utm_campaign: campaignName }),
      ]);

      results[campaignName] = {
        cocData: buildMetrics(txn, leads),
        adsets: {}
        // Note: adset/ad level breakdown requires separate calls per adset name
        // Those names come from FB data - we'll do a second pass in the merger if needed
      };
    } catch (err) {
      console.error(`getCocHierarchy error for "${campaignName}":`, err.message);
      results[campaignName] = { cocData: null, adsets: {}, error: err.message };
    }
  }

  return results;
}

/**
 * Raw debug - returns full API response for inspection
 */
async function getCocRaw(loginId, password, endpoint, extraParams = {}) {
  const params = { ...baseParams(loginId, password), ...extraParams };
  try {
    const r = await axios.get(`${COC_BASE}${endpoint}`, { params });
    return { status: r.status, data: r.data };
  } catch (err) {
    return { status: err.response?.status, error: err.response?.data || err.message };
  }
}

module.exports = { getCocHierarchy, getCocCampaignTotals, getCocRaw };

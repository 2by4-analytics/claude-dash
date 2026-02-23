const axios = require('axios');

const COC_BASE_URL = 'https://app.checkoutchamp.com/api/reports';

/**
 * Build auth header from loginId + password
 */
function getAuthHeader(loginId, password) {
  const encoded = Buffer.from(`${loginId}:${password}`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

/**
 * Fetch COC Order Summary report filtered by campaign ID and UTM params
 * 
 * @param {string} loginId
 * @param {string} password
 * @param {number} campaignId - COC internal campaign ID
 * @param {string} dateStart - YYYY-MM-DD
 * @param {string} dateStop - YYYY-MM-DD
 * @param {object} utmFilters - { utm_campaign, utm_medium, utm_content } (any can be null for totals)
 */
async function getCocOrderSummary(loginId, password, campaignId, dateStart, dateStop, utmFilters = {}) {
  const headers = getAuthHeader(loginId, password);

  const body = {
    campaignId,
    startDate: dateStart,
    endDate: dateStop,
    reportType: 'campaign', // default grouping
    ...(utmFilters.utm_campaign && { utmCampaign: utmFilters.utm_campaign }),
    ...(utmFilters.utm_medium && { utmMedium: utmFilters.utm_medium }),
    ...(utmFilters.utm_content && { utmContent: utmFilters.utm_content }),
  };

  try {
    const response = await axios.post(
      `${COC_BASE_URL}/order-summary`,
      body,
      { headers: { ...headers, 'Content-Type': 'application/json' } }
    );
    return response.data;
  } catch (err) {
    const msg = err.response?.data?.message || err.message;
    throw new Error(`COC API error for campaign ${campaignId}: ${msg}`);
  }
}

/**
 * Fetch COC data for all UTM levels to build the hierarchy
 * Returns totals + per-campaign + per-adset + per-ad breakdowns
 */
async function getCocHierarchy(loginId, password, campaignId, dateStart, dateStop, fbCampaignNames) {
  const results = {};

  for (const campaignName of fbCampaignNames) {
    try {
      // Campaign level (utm_campaign only)
      const campaignData = await getCocOrderSummary(loginId, password, campaignId, dateStart, dateStop, {
        utm_campaign: campaignName
      });

      results[campaignName] = {
        cocData: extractSummaryTotals(campaignData),
        adsets: {}
      };

      // Get unique adset names from response if available, otherwise we'll match from FB side
      const adsetBreakdown = campaignData?.data?.breakdown || [];
      for (const adsetRow of adsetBreakdown) {
        const adsetName = adsetRow.utmMedium || adsetRow.utm_medium;
        if (!adsetName) continue;

        results[campaignName].adsets[adsetName] = {
          cocData: extractRowMetrics(adsetRow),
          ads: {}
        };

        // Ad level breakdown within this adset
        const adBreakdown = adsetRow.ads || [];
        for (const adRow of adBreakdown) {
          const adName = adRow.utmContent || adRow.utm_content;
          if (adName) {
            results[campaignName].adsets[adsetName].ads[adName] = extractRowMetrics(adRow);
          }
        }
      }
    } catch (err) {
      console.error(`COC fetch failed for campaign "${campaignName}":`, err.message);
      results[campaignName] = { cocData: null, adsets: {}, error: err.message };
    }
  }

  return results;
}

/**
 * Fetch overall COC summary for a COC campaign (no UTM filter)
 */
async function getCocCampaignTotals(loginId, password, campaignId, dateStart, dateStop) {
  try {
    const data = await getCocOrderSummary(loginId, password, campaignId, dateStart, dateStop, {});
    return extractSummaryTotals(data);
  } catch (err) {
    console.error(`COC totals failed for campaign ${campaignId}:`, err.message);
    return null;
  }
}

function extractSummaryTotals(data) {
  if (!data) return null;
  // Handle both direct response and nested data structures
  const d = data.data || data;
  return {
    partials: d.partials || d.total_partials || 0,
    convRate: d.conversion_rate || d.conv_rate || 0,
    declines: d.declines || d.total_declines || 0,
    declineRate: d.decline_rate || 0,
    sales: d.sales || d.total_sales || 0,
    salesRate: d.sales_rate || 0,
    salesTotal: parseFloat(d.sales_total || d.total_revenue || 0),
    upsells: d.upsells || d.total_upsells || 0,
    upsellAttempts: d.upsell_attempts || 0,
    upsellApproval: d.upsell_approval_rate || 0,
    upsellTotal: parseFloat(d.upsell_total || d.total_upsell_revenue || 0),
    refundAmt: parseFloat(d.refund_amount || d.total_refunds || 0),
    shipping: parseFloat(d.shipping || 0),
    netRevenue: parseFloat(d.net_revenue || d.net_rev || 0),
    avgTicket: parseFloat(d.avg_ticket || d.average_ticket || 0),
  };
}

function extractRowMetrics(row) {
  return {
    partials: row.partials || 0,
    convRate: row.conversion_rate || row.conv_rate || 0,
    declines: row.declines || 0,
    declineRate: row.decline_rate || 0,
    sales: row.sales || 0,
    salesRate: row.sales_rate || 0,
    salesTotal: parseFloat(row.sales_total || row.revenue || 0),
    upsells: row.upsells || 0,
    upsellTotal: parseFloat(row.upsell_total || 0),
    refundAmt: parseFloat(row.refund_amount || 0),
    netRevenue: parseFloat(row.net_revenue || 0),
    avgTicket: parseFloat(row.avg_ticket || 0),
  };
}

module.exports = { getCocHierarchy, getCocCampaignTotals, getCocOrderSummary };

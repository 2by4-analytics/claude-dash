const axios = require('axios');

const FB_API_VERSION = process.env.FB_API_VERSION || 'v18.0';
const BASE_URL = `https://graph.facebook.com/${FB_API_VERSION}`;

/**
 * Fetch FB Insights for a given ad account, date range, and breakdown level.
 * Returns data broken down by campaign > adset > ad using utm_campaign, utm_medium, utm_content
 */
async function getFbInsights(accessToken, adAccountId, dateStart, dateStop) {
  const fields = [
    'campaign_name',
    'adset_name',
    'ad_name',
    'spend',
    'impressions',
    'clicks',
    'actions',
    'cost_per_action_type'
  ].join(',');

  const params = {
    access_token: accessToken,
    fields,
    level: 'ad',
    time_range: JSON.stringify({ since: dateStart, until: dateStop }),
    limit: 500,
    filtering: JSON.stringify([{ field: 'spend', operator: 'GREATER_THAN', value: '0' }])
  };

  let allData = [];
  let url = `${BASE_URL}/${adAccountId}/insights`;

  try {
    while (url) {
      const response = await axios.get(url, { params: url === `${BASE_URL}/${adAccountId}/insights` ? params : {} });
      const { data, paging } = response.data;

      if (data) allData = allData.concat(data);

      // Handle pagination
      url = paging && paging.next ? paging.next : null;
    }
  } catch (err) {
    const msg = err.response?.data?.error?.message || err.message;
    throw new Error(`FB API error for ${adAccountId}: ${msg}`);
  }

  return allData;
}

/**
 * Fetch campaign-level UTM breakdown from FB URL tags
 * We use campaign_name as utm_campaign, adset_name as utm_medium, ad_name as utm_content
 * (matching how you've set up tracking)
 */
async function getFbHierarchy(accessToken, adAccountId, dateStart, dateStop) {
  const rawData = await getFbInsights(accessToken, adAccountId, dateStart, dateStop);

  // Build hierarchy: campaign -> adset -> ad
  const campaigns = {};

  for (const row of rawData) {
    const campaignKey = row.campaign_name || 'Unknown Campaign';
    const adsetKey = row.adset_name || 'Unknown Adset';
    const adKey = row.ad_name || 'Unknown Ad';
    const spend = parseFloat(row.spend || 0);

    if (!campaigns[campaignKey]) {
      campaigns[campaignKey] = { name: campaignKey, spend: 0, adsets: {} };
    }
    campaigns[campaignKey].spend += spend;

    const camp = campaigns[campaignKey];
    if (!camp.adsets[adsetKey]) {
      camp.adsets[adsetKey] = { name: adsetKey, spend: 0, ads: {} };
    }
    camp.adsets[adsetKey].spend += spend;

    const adset = camp.adsets[adsetKey];
    if (!adset.ads[adKey]) {
      adset.ads[adKey] = { name: adKey, spend: 0 };
    }
    adset.ads[adKey].spend += spend;
  }

  // Convert to arrays
  return Object.values(campaigns).map(c => ({
    ...c,
    adsets: Object.values(c.adsets).map(a => ({
      ...a,
      ads: Object.values(a.ads)
    }))
  }));
}

module.exports = { getFbHierarchy };

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
 * Fetch current effective_status for all campaigns, adsets, and ads in an account.
 * Returns lookup maps by name at each level.
 */
async function getEntityStatuses(accessToken, adAccountId) {
  async function fetchAll(endpoint) {
    const all = [];
    let url = `${BASE_URL}/${adAccountId}/${endpoint}`;
    const params = { access_token: accessToken, fields: 'name,effective_status', limit: 500 };
    try {
      while (url) {
        const res = await axios.get(url, { params: url.includes('?') ? {} : params });
        if (res.data.data) all.push(...res.data.data);
        url = res.data.paging?.next || null;
      }
    } catch (err) {
      // Non-fatal — status dots just won't show if this fails
      console.warn(`[fb] getEntityStatuses ${endpoint} failed:`, err.message);
    }
    return all;
  }

  const [campaigns, adsets, ads] = await Promise.all([
    fetchAll('campaigns'),
    fetchAll('adsets'),
    fetchAll('ads'),
  ]);

  return {
    campaigns: Object.fromEntries(campaigns.map(c => [c.name, c.effective_status])),
    adsets: Object.fromEntries(adsets.map(a => [a.name, a.effective_status])),
    ads: Object.fromEntries(ads.map(a => [a.name, a.effective_status])),
  };
}

/**
 * Fetch campaign-level UTM breakdown from FB URL tags.
 * We use campaign_name as utm_campaign, adset_name as utm_medium, ad_name as utm_content
 * (matching how you've set up tracking).
 *
 * @param {string} accessToken   - FB Marketing API access token
 * @param {string} adAccountId   - e.g. "act_123456789"
 * @param {string} dateStart     - YYYY-MM-DD, interpreted in the ad account's Meta timezone
 * @param {string} dateStop      - YYYY-MM-DD, interpreted in the ad account's Meta timezone
 * @param {string} [timezone]    - IANA timezone string from client config (e.g. 'America/Chicago').
 *                                 Callers must ensure dateStart/dateStop already reflect this timezone.
 *                                 Meta interprets date strings in the ad account's configured timezone,
 *                                 so no conversion is performed here.
 */
async function getFbHierarchy(accessToken, adAccountId, dateStart, dateStop, timezone) {
  const [rawData, statusMap] = await Promise.all([
    getFbInsights(accessToken, adAccountId, dateStart, dateStop),
    getEntityStatuses(accessToken, adAccountId),
  ]);

  // Build hierarchy: campaign -> adset -> ad
  const campaigns = {};

  for (const row of rawData) {
    const campaignKey = row.campaign_name || 'Unknown Campaign';
    const adsetKey = row.adset_name || 'Unknown Adset';
    const adKey = row.ad_name || 'Unknown Ad';
    const spend = parseFloat(row.spend || 0);

    if (!campaigns[campaignKey]) {
      campaigns[campaignKey] = { name: campaignKey, spend: 0, effective_status: statusMap.campaigns[campaignKey] || null, adsets: {} };
    }
    campaigns[campaignKey].spend += spend;

    const camp = campaigns[campaignKey];
    if (!camp.adsets[adsetKey]) {
      camp.adsets[adsetKey] = { name: adsetKey, spend: 0, effective_status: statusMap.adsets[adsetKey] || null, ads: {} };
    }
    camp.adsets[adsetKey].spend += spend;

    const adset = camp.adsets[adsetKey];
    if (!adset.ads[adKey]) {
      adset.ads[adKey] = { name: adKey, spend: 0, effective_status: statusMap.ads[adKey] || null };
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

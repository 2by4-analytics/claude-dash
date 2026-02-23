const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getClients, getClientById } = require('../services/config');
const { getFbHierarchy } = require('../services/fb');
const { getCocHierarchy, getCocCampaignTotals } = require('../services/coc');
const { mergeHierarchy } = require('../services/merger');

// GET /api/clients - list all clients (no secrets)
router.get('/clients', (req, res) => {
  const clients = getClients().map(c => ({
    id: c.id,
    name: c.name,
    adAccounts: c.adAccounts.map(a => ({
      fbAdAccountId: a.fbAdAccountId,
      cocCampaignId: a.cocCampaignId,
      cocCampaignName: a.cocCampaignName
    }))
  }));
  res.json({ clients });
});

// GET /api/dashboard/:clientId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
router.get('/dashboard/:clientId', async (req, res) => {
  const { clientId } = req.params;
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate are required (YYYY-MM-DD)' });
  }

  const client = getClientById(clientId);
  if (!client) {
    return res.status(404).json({ error: `Client "${clientId}" not found` });
  }

  const results = [];
  const errors = [];

  // Process each ad account in parallel
  await Promise.all(client.adAccounts.map(async (adAccount) => {
    try {
      // Fetch FB and COC data in parallel
      const [fbData, cocTotals] = await Promise.all([
        getFbHierarchy(client.fbAccessToken, adAccount.fbAdAccountId, startDate, endDate),
        getCocCampaignTotals(client.cocLoginId, client.cocPassword, adAccount.cocCampaignId, startDate, endDate)
      ]);

      // Get the FB campaign names to use as UTM filters for COC
      const fbCampaignNames = fbData.map(c => c.name);

      // Now fetch COC hierarchy using FB campaign names as utm_campaign values
      const cocHierarchy = await getCocHierarchy(
        client.cocLoginId,
        client.cocPassword,
        adAccount.cocCampaignId,
        startDate,
        endDate,
        fbCampaignNames
      );

      // Merge FB + COC data
      const merged = mergeHierarchy(fbData, cocHierarchy, adAccount);
      // Attach the overall COC totals for this campaign
      merged.cocTotals = cocTotals;

      results.push(merged);
    } catch (err) {
      console.error(`Error processing ad account ${adAccount.fbAdAccountId}:`, err.message);
      errors.push({
        fbAdAccountId: adAccount.fbAdAccountId,
        cocCampaignName: adAccount.cocCampaignName,
        error: err.message
      });
    }
  }));

  // Sort by COC campaign name
  results.sort((a, b) => a.cocCampaignName.localeCompare(b.cocCampaignName));

  res.json({
    clientId,
    clientName: client.name,
    startDate,
    endDate,
    adAccounts: results,
    errors: errors.length > 0 ? errors : undefined
  });
});

// ============================================================
// DEBUG ENDPOINTS - dumps raw API responses so you can see field names
// Usage: /api/debug/coc/:clientId?campaignId=1&startDate=2024-02-20&endDate=2024-02-20
// Usage: /api/debug/fb/:clientId?adAccountId=act_XXX&startDate=2024-02-20&endDate=2024-02-20
// ============================================================

router.get('/debug/coc/:clientId', async (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { campaignId, startDate, endDate } = req.query;
  if (!campaignId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Required: campaignId, startDate, endDate (YYYY-MM-DD)' });
  }

  const encoded = Buffer.from(`${client.cocLoginId}:${client.cocPassword}`).toString('base64');

  // Try multiple likely endpoint patterns and return all results
  const endpoints = [
    { name: 'order-summary (POST)', method: 'post', url: 'https://app.checkoutchamp.com/api/reports/order-summary', body: { campaignId: parseInt(campaignId), startDate, endDate } },
    { name: 'order-summary (GET)', method: 'get', url: `https://app.checkoutchamp.com/api/reports/order-summary?campaignId=${campaignId}&startDate=${startDate}&endDate=${endDate}` },
    { name: 'transactions/query', method: 'post', url: 'https://app.checkoutchamp.com/api/transactions/query', body: { campaignId: parseInt(campaignId), startDate, endDate } },
    { name: 'order/query', method: 'post', url: 'https://app.checkoutchamp.com/api/order/query', body: { campaignId: parseInt(campaignId), startDate, endDate } },
  ];

  const results = {};
  for (const ep of endpoints) {
    try {
      const config = {
        headers: { Authorization: `Basic ${encoded}`, 'Content-Type': 'application/json' }
      };
      const response = ep.method === 'post'
        ? await axios.post(ep.url, ep.body, config)
        : await axios.get(ep.url, config);
      results[ep.name] = { status: response.status, data: response.data };
    } catch (err) {
      results[ep.name] = {
        status: err.response?.status || 'network_error',
        error: err.response?.data || err.message
      };
    }
  }

  res.json({ clientId: req.params.clientId, campaignId, dateRange: `${startDate} → ${endDate}`, results });
});

router.get('/debug/fb/:clientId', async (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { adAccountId, startDate, endDate } = req.query;
  if (!adAccountId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Required: adAccountId, startDate, endDate (YYYY-MM-DD)' });
  }

  const FB_API_VERSION = process.env.FB_API_VERSION || 'v18.0';
  try {
    const response = await axios.get(`https://graph.facebook.com/${FB_API_VERSION}/${adAccountId}/insights`, {
      params: {
        access_token: client.fbAccessToken,
        fields: 'campaign_name,adset_name,ad_name,spend',
        level: 'ad',
        time_range: JSON.stringify({ since: startDate, until: endDate }),
        limit: 5
      }
    });
    res.json({ raw: response.data });
  } catch (err) {
    res.json({ error: err.response?.data || err.message });
  }
});

module.exports = router;

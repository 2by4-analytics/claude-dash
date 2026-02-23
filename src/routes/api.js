const express = require('express');
const router = express.Router();
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

module.exports = router;

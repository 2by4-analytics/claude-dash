const express = require('express');
const router = express.Router();
const axios = require('axios');
const { getClients, getClientById } = require('../services/config');
const { getFbHierarchy } = require('../services/fb');
const { getCocHierarchy, getCocCampaignTotals } = require('../services/coc');
const { mergeHierarchy } = require('../services/merger');

// GET /api/clients
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
  if (!client) return res.status(404).json({ error: `Client "${clientId}" not found` });

  const results = [];
  const errors = [];

  await Promise.all(client.adAccounts.map(async (adAccount) => {
    try {
      const [fbData, cocTotals] = await Promise.all([
        getFbHierarchy(client.fbAccessToken, adAccount.fbAdAccountId, startDate, endDate),
        getCocCampaignTotals(client.cocLoginId, client.cocPassword, adAccount.cocCampaignId, startDate, endDate)
      ]);

      const fbCampaignNames = fbData.map(c => c.name);
      const cocHierarchy = await getCocHierarchy(
        client.cocLoginId, client.cocPassword,
        adAccount.cocCampaignId, startDate, endDate,
        fbCampaignNames
      );

      const merged = mergeHierarchy(fbData, cocHierarchy, adAccount);
      merged.cocTotals = cocTotals;
      results.push(merged);
    } catch (err) {
      console.error(`Error for ${adAccount.fbAdAccountId}:`, err.message);
      errors.push({ fbAdAccountId: adAccount.fbAdAccountId, cocCampaignName: adAccount.cocCampaignName, error: err.message });
    }
  }));

  results.sort((a, b) => a.cocCampaignName.localeCompare(b.cocCampaignName));
  res.json({ clientId, clientName: client.name, startDate, endDate, adAccounts: results, errors: errors.length > 0 ? errors : undefined });
});

// ============================================================
// DEBUG - hit these in browser to see raw COC responses
// /api/debug/coc/client1?campaignId=1&startDate=2024-02-20&endDate=2024-02-20
// /api/debug/coc-leads/client1?campaignId=1&startDate=2024-02-20&endDate=2024-02-20
// ============================================================
router.get('/debug/coc/:clientId', async (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { campaignId, startDate, endDate } = req.query;
  if (!campaignId || !startDate || !endDate) {
    return res.status(400).json({ error: 'Required: campaignId, startDate (YYYY-MM-DD), endDate (YYYY-MM-DD)' });
  }

  // COC date format: M/D/YY
  function fmtDate(d) {
    const [y, m, day] = d.split('-');
    return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`;
  }

  const baseParams = { loginId: client.cocLoginId, password: client.cocPassword, campaignId, startDate: fmtDate(startDate), endDate: fmtDate(endDate) };

  const endpoints = [
    { name: 'transactions/query (SALE+SUCCESS)', params: { ...baseParams, txnType: 'SALE', responseType: 'SUCCESS' } },
    { name: 'transactions/query (all)', params: baseParams },
    { name: 'leads/query', params: baseParams },
    { name: 'order/query', params: baseParams },
  ];

  const results = {};
  for (const ep of endpoints) {
    try {
      const r = await axios.get(`https://api.checkoutchamp.com/${ep.name.split(' ')[0]}`, { params: ep.params });
      results[ep.name] = { status: r.status, data: r.data };
    } catch (err) {
      results[ep.name] = { status: err.response?.status || 'error', error: err.response?.data || err.message };
    }
  }

  res.json({ campaignId, dateRange: `${startDate} → ${endDate}`, results });
});

module.exports = router;

// Revenue debug endpoint
router.get('/debug/revenue/:clientId', async (req, res) => {
  try {
    const client = getClientById(req.params.clientId);
    const { campaignId, startDate, endDate } = req.query;
    const axios = require('axios');
    
    function fmtDate(d) {
      const [y, m, day] = d.split('-');
      return `${parseInt(m)}/${parseInt(day)}/${y.slice(2)}`;
    }
    
    const account = client.adAccounts.find(a => String(a.cocCampaignId) === String(campaignId));
    
    // Fetch all COMPLETE orders
    const r = await axios.get('https://api.checkoutchamp.com/order/query/', {
      params: {
        loginId: client.cocLoginId,
        password: client.cocPassword,
        campaignId,
        startDate: fmtDate(startDate),
        endDate: fmtDate(endDate),
        orderStatus: 'COMPLETE',
        orderType: 'NEW_SALE',
        resultsPerPage: 200,
      }
    });

    const orders = r.data.message?.data || [];
    const totalRevenue = orders.reduce((sum, o) => sum + parseFloat(o.totalAmount || 0), 0);
    const nullAmounts = orders.filter(o => !o.totalAmount || o.totalAmount === null).length;
    const orderSummary = orders.map(o => ({
      orderId: o.orderId,
      totalAmount: o.totalAmount,
      baseShipping: o.baseShipping,
      salesTax: o.salesTax,
      surcharge: o.surcharge,
      shipUpcharge: o.shipUpcharge,
      combined: (parseFloat(o.totalAmount||0) + parseFloat(o.baseShipping||0) + parseFloat(o.salesTax||0) + parseFloat(o.surcharge||0) + parseFloat(o.shipUpcharge||0)).toFixed(2),
    })).filter(o => parseFloat(o.baseShipping||0) > 0 || parseFloat(o.surcharge||0) > 0 || parseFloat(o.shipUpcharge||0) > 0);
    
    const totalWithAll = orders.reduce((sum, o) => 
      sum + parseFloat(o.totalAmount||0) + parseFloat(o.baseShipping||0) + parseFloat(o.salesTax||0) + parseFloat(o.surcharge||0) + parseFloat(o.shipUpcharge||0), 0);
    
    const totalShipping = orders.reduce((sum, o) => sum + parseFloat(o.baseShipping||0), 0);
    const totalSurcharge = orders.reduce((sum, o) => sum + parseFloat(o.surcharge||0), 0);
    const totalShipUpcharge = orders.reduce((sum, o) => sum + parseFloat(o.shipUpcharge||0), 0);
    
    res.json({ 
      totalOrders: orders.length,
      totalRevenue: totalRevenue.toFixed(2),
      totalRevenueWithAll: totalWithAll.toFixed(2),
      breakdown: {
        totalAmount: totalRevenue.toFixed(2),
        totalShipping: totalShipping.toFixed(2),
        totalSurcharge: totalSurcharge.toFixed(2),
        totalShipUpcharge: totalShipUpcharge.toFixed(2),
      },
      nonZeroOrders: orderSummary 
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

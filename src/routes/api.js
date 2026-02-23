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
      cocCampaignName: a.cocCampaignName,
      cppTarget: a.cppTarget || null
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

// GET /api/insights/:clientId?date=YYYY-MM-DD
// Returns CPP trend analysis: yesterday vs 7-day rolling avg
// Flags adsets/ads with CPP rising >15% and spend >$25
router.get('/insights/:clientId', async (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date (YYYY-MM-DD) required' });

  const d = new Date(date + 'T12:00:00Z');
  const yesterday = date;
  const sevenDaysAgo = new Date(d);
  sevenDaysAgo.setDate(d.getDate() - 6);
  const sevenDayStart = sevenDaysAgo.toISOString().split('T')[0];

  try {
    const accountResults = await Promise.all(client.adAccounts.map(async (adAccount) => {
      const [fbYest, fbWeek] = await Promise.all([
        getFbHierarchy(client.fbAccessToken, adAccount.fbAdAccountId, yesterday, yesterday),
        getFbHierarchy(client.fbAccessToken, adAccount.fbAdAccountId, sevenDayStart, yesterday),
      ]);

      const fbCampaignNames = fbWeek.map(c => c.name);
      const [cocYest, cocWeek] = await Promise.all([
        getCocHierarchy(client.cocLoginId, client.cocPassword, adAccount.cocCampaignId, yesterday, yesterday, fbCampaignNames),
        getCocHierarchy(client.cocLoginId, client.cocPassword, adAccount.cocCampaignId, sevenDayStart, yesterday, fbCampaignNames)
      ]);

      const mergedYest = mergeHierarchy(fbYest, cocYest, adAccount);
      const mergedWeek = mergeHierarchy(fbWeek, cocWeek, adAccount);

      // Account-level 7D avg CPP as baseline
      const accountWeekSpend = mergedWeek.fbSpend;
      const accountWeekSales = mergedWeek.campaigns.reduce((sum, c) => sum + (c.cocData?.sales || 0), 0);
      const accountAvgCpp = accountWeekSales > 0 ? accountWeekSpend / accountWeekSales : 0;

      const flagged = [];

      for (const campaign of mergedYest.campaigns) {
        const weekCampaign = mergedWeek.campaigns.find(c => c.name === campaign.name);

        for (const adset of campaign.adsets || []) {
          const weekAdset = weekCampaign?.adsets?.find(a => a.name === adset.name);
          const yestCpp = adset.cpp || 0;
          const weekCpp = weekAdset?.cpp || 0;
          const yestSpend = adset.fbSpend || 0;

          if (yestSpend >= 25 && yestCpp > 0) {
            const vsWeek = weekCpp > 0 ? ((yestCpp - weekCpp) / weekCpp) : null;
            const vsAccount = accountAvgCpp > 0 ? ((yestCpp - accountAvgCpp) / accountAvgCpp) : null;
            const isRising = vsWeek !== null && vsWeek > 0.15;
            const isAboveAvg = vsAccount !== null && vsAccount > 0.15;

            if (isRising || isAboveAvg) {
              flagged.push({
                level: 'adset', campaign: campaign.name, name: adset.name,
                yesterdaySpend: yestSpend, yesterdayCpp: yestCpp, weekCpp, accountAvgCpp,
                vsWeekPct: vsWeek !== null ? Math.round(vsWeek * 100) : null,
                vsAccountPct: vsAccount !== null ? Math.round(vsAccount * 100) : null,
                isRising, isAboveAvg, sales: adset.cocData?.sales || 0,
              });
            }

            for (const ad of adset.ads || []) {
              const weekAd = weekAdset?.ads?.find(a => a.name === ad.name);
              const adYestCpp = ad.cpp || 0;
              const adWeekCpp = weekAd?.cpp || 0;
              const adYestSpend = ad.fbSpend || 0;

              if (adYestSpend >= 25 && adYestCpp > 0) {
                const adVsWeek = adWeekCpp > 0 ? ((adYestCpp - adWeekCpp) / adWeekCpp) : null;
                const adVsAccount = accountAvgCpp > 0 ? ((adYestCpp - accountAvgCpp) / accountAvgCpp) : null;
                const adIsRising = adVsWeek !== null && adVsWeek > 0.15;
                const adIsAboveAvg = adVsAccount !== null && adVsAccount > 0.15;

                if (adIsRising || adIsAboveAvg) {
                  flagged.push({
                    level: 'ad', campaign: campaign.name, adset: adset.name, name: ad.name,
                    yesterdaySpend: adYestSpend, yesterdayCpp: adYestCpp, weekCpp: adWeekCpp, accountAvgCpp,
                    vsWeekPct: adVsWeek !== null ? Math.round(adVsWeek * 100) : null,
                    vsAccountPct: adVsAccount !== null ? Math.round(adVsAccount * 100) : null,
                    isRising: adIsRising, isAboveAvg: adIsAboveAvg, sales: ad.cocData?.sales || 0,
                  });
                }
              }
            }
          }
        }
      }

      flagged.sort((a, b) => (b.vsWeekPct || 0) - (a.vsWeekPct || 0));

      return {
        cocCampaignName: adAccount.cocCampaignName,
        fbAdAccountId: adAccount.fbAdAccountId,
        period: { yesterday, sevenDayStart },
        accountAvgCpp: Math.round(accountAvgCpp * 100) / 100,
        accountWeekSpend: Math.round(accountWeekSpend * 100) / 100,
        accountWeekSales,
        flagged,
      };
    }));

    res.json({ clientId: client.id, clientName: client.name, date, accounts: accountResults });
  } catch (err) {
    console.error('Insights error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/prior/:clientId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
// Returns dashboard data for the equivalent prior period
// Yesterday → day before | 7D → prior 7D | MTD → same days last month
router.get('/prior/:clientId', async (req, res) => {
  const client = getClientById(req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return res.status(400).json({ error: 'startDate and endDate required' });

  // Compute prior period
  const s = new Date(startDate + 'T12:00:00Z');
  const e = new Date(endDate + 'T12:00:00Z');
  const spanDays = Math.round((e - s) / 864e5) + 1;

  const priorEnd = new Date(s); priorEnd.setDate(s.getDate() - 1);
  const priorStart = new Date(priorEnd); priorStart.setDate(priorEnd.getDate() - (spanDays - 1));

  const ps = priorStart.toISOString().split('T')[0];
  const pe = priorEnd.toISOString().split('T')[0];

  try {
    const results = [];
    await Promise.all(client.adAccounts.map(async (adAccount) => {
      try {
        const [fbData, cocTotals] = await Promise.all([
          getFbHierarchy(client.fbAccessToken, adAccount.fbAdAccountId, ps, pe),
          getCocCampaignTotals(client.cocLoginId, client.cocPassword, adAccount.cocCampaignId, ps, pe)
        ]);
        const fbCampaignNames = fbData.map(c => c.name);
        const cocHierarchy = await getCocHierarchy(
          client.cocLoginId, client.cocPassword,
          adAccount.cocCampaignId, ps, pe, fbCampaignNames
        );
        const merged = mergeHierarchy(fbData, cocHierarchy, adAccount);
        merged.cocTotals = cocTotals;
        results.push(merged);
      } catch (err) {
        console.error('Prior period error:', err.message);
      }
    }));
    results.sort((a, b) => a.cocCampaignName.localeCompare(b.cocCampaignName));
    res.json({ clientId: client.id, startDate: ps, endDate: pe, adAccounts: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;

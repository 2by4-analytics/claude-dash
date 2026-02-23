/**
 * Merges FB hierarchy data with COC order summary data
 * The join key is: fb.campaign_name === coc.utm_campaign (and adset/ad names similarly)
 */

function computeMetrics(fbSpend, cocData) {
  const spend = fbSpend || 0;
  const salesTotal = cocData?.salesTotal || 0;
  const sales = cocData?.sales || 0;
  const partials = cocData?.partials || 0;

  const roas = spend > 0 ? (salesTotal / spend) : 0;
  const cpp = sales > 0 ? (spend / sales) : 0;
  const aov = sales > 0 ? (salesTotal / sales) : 0;
  const totalClicks = (partials + sales) || 0;
  const convRate = totalClicks > 0 ? ((sales / totalClicks) * 100) : (cocData?.convRate || 0);

  return { roas, cpp, aov, convRate };
}

function mergeHierarchy(fbAdAccountData, cocHierarchyData, adAccountConfig) {
  const { fbAdAccountId, cocCampaignId, cocCampaignName } = adAccountConfig;

  const merged = {
    fbAdAccountId,
    cocCampaignName,
    cocCampaignId,
    fbSpend: 0,
    cocData: null,
    campaigns: []
  };

  // Sum total FB spend across all campaigns in this ad account
  merged.fbSpend = fbAdAccountData.reduce((sum, c) => sum + c.spend, 0);

  // Build merged campaigns
  for (const fbCampaign of fbAdAccountData) {
    const cocCampaignData = cocHierarchyData?.[fbCampaign.name] || null;
    const cocData = cocCampaignData?.cocData || null;
    const metrics = computeMetrics(fbCampaign.spend, cocData);

    const mergedCampaign = {
      name: fbCampaign.name,
      fbSpend: fbCampaign.spend,
      cocData,
      ...metrics,
      adsets: []
    };

    // Merge adsets
    for (const fbAdset of fbCampaign.adsets || []) {
      const cocAdsetData = cocCampaignData?.adsets?.[fbAdset.name]?.cocData || null;
      const adsetMetrics = computeMetrics(fbAdset.spend, cocAdsetData);

      const mergedAdset = {
        name: fbAdset.name,
        fbSpend: fbAdset.spend,
        cocData: cocAdsetData,
        ...adsetMetrics,
        ads: []
      };

      // Merge ads
      for (const fbAd of fbAdset.ads || []) {
        const cocAdData = cocCampaignData?.adsets?.[fbAdset.name]?.ads?.[fbAd.name] || null;
        const adMetrics = computeMetrics(fbAd.spend, cocAdData);

        mergedAdset.ads.push({
          name: fbAd.name,
          fbSpend: fbAd.spend,
          cocData: cocAdData,
          ...adMetrics
        });
      }

      mergedCampaign.adsets.push(mergedAdset);
    }

    merged.campaigns.push(mergedCampaign);
  }

  // Sort campaigns by FB spend desc
  merged.campaigns.sort((a, b) => b.fbSpend - a.fbSpend);

  return merged;
}

module.exports = { mergeHierarchy };

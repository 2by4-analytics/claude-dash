# FB + Checkout Champ Dashboard

A unified media buying dashboard that merges Facebook Ads spend data with Checkout Champ order data in a collapsible hierarchy: **Ad Account → FB Campaign (= UTM Campaign) → Adset (= UTM Medium) → Ad (= UTM Content)**.

---

## How the Data Join Works

| Level | FB Source | COC Filter |
|-------|-----------|------------|
| Ad Account | `act_XXXXXXXXX` | Mapped to COC Campaign ID in config |
| Campaign | `campaign_name` | `utm_campaign` filter |
| Adset | `adset_name` | `utm_medium` filter |
| Ad | `ad_name` | `utm_content` filter |

**Important:** Your FB campaign/adset/ad names must match the UTM values you're sending to COC exactly. If they differ, the COC data won't match up (FB spend will show, COC columns will be blank).

---

## Setup

### 1. Clone and install

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Edit `.env` with your credentials. The `CLIENTS` variable is a JSON array:

```
CLIENTS=[{"id":"client1","name":"My Client","cocLoginId":"XXX","cocPassword":"XXX","fbAccessToken":"XXX","adAccounts":[{"fbAdAccountId":"act_3250948078451590","cocCampaignId":1,"cocCampaignName":"Plant"},{"fbAdAccountId":"act_SECOND","cocCampaignId":2,"cocCampaignName":"Faith"}]}]
```

**Note:** In Railway, paste the entire JSON as a single line for the `CLIENTS` variable.

### 3. Run locally

```bash
npm run dev
```

Visit `http://localhost:3000`

---

## Deploy to Railway

1. Push this repo to GitHub
2. Create a new Railway project → **Deploy from GitHub repo**
3. In Railway project settings → **Variables**, add:
   - `CLIENTS` — your JSON config (see .env.example for format)
   - `FB_API_VERSION` — e.g. `v18.0`
4. Railway auto-detects Node.js and runs `npm start`

---

## Adding a New Client

Add a new object to the `CLIENTS` JSON array. Each client needs:

```json
{
  "id": "unique-slug",           // used in URLs
  "name": "Display Name",
  "cocLoginId": "...",
  "cocPassword": "...",
  "fbAccessToken": "...",        // long-lived token (60-day, set up auto-refresh)
  "adAccounts": [
    {
      "fbAdAccountId": "act_XXXXXXXXX",
      "cocCampaignId": 1,          // COC internal campaign ID
      "cocCampaignName": "Plant"   // display name
    }
  ]
}
```

---

## FB Access Token

Use a **System User token** (via Facebook Business Manager) for long-lived access. User tokens expire in 60 days. System User tokens don't expire.

Required permissions: `ads_read`, `ads_management`

---

## COC API Notes

The dashboard uses:
- `POST /api/reports/order-summary` with `utm_campaign`, `utm_medium`, `utm_content` filters
- Data is fetched per FB campaign name (used as `utm_campaign`)

If the COC API response format differs from what's expected, edit `src/services/coc.js` → the `extractSummaryTotals()` and `extractRowMetrics()` functions to match the actual field names returned.

---

## Columns

| Column | Source | Notes |
|--------|--------|-------|
| Spend | FB | From Insights API |
| Partials | COC | Leads/checkouts started |
| Conv% | COC | Conversion rate |
| Declines | COC | Declined transactions |
| Dec% | COC | Decline rate |
| Sales | COC | Completed orders |
| Sales% | COC | Sales rate |
| Revenue | COC | Gross sales total |
| Net Rev | COC | After refunds |
| Avg Ticket | COC | AOV from COC |
| ROAS | Derived | Revenue / FB Spend |
| CPP | Derived | FB Spend / Sales |
| AOV | Derived | Revenue / Sales |

# MEDIA/DASH — FB Ads + Checkout Champ Analytics Dashboard

A real-time analytics dashboard that merges Facebook Ads spend data with Checkout Champ order data, displayed in a collapsible hierarchy: **Account → Campaign → Adset → Ad**.

**Live URL:** `https://claude-dash-production.up.railway.app`
**Repo:** `https://github.com/2by4-analytics/claude-dash`
**Hosting:** Railway (auto-deploys on push to main)

---

## What It Does

- Pulls FB Ads spend/impressions/clicks via the Facebook Marketing API
- Pulls order data from Checkout Champ via their REST API
- Joins them using UTM parameters as the linking key
- Displays unified metrics: Spend, Sales, Revenue, ROAS, CPP, AOV, Conv%, Partials, Declines
- Supports multiple clients, multiple ad accounts per client
- Date presets: Today, Yesterday, 7D, 14D, 30D, MTD + custom range

---

## Stack

- **Backend:** Node.js + Express (`src/server.js`, `src/routes/api.js`)
- **Frontend:** Vanilla JS, single HTML file (`public/index.html`)
- **Deployment:** Railway, `railway.toml` in root

---

## Project Structure

```
fb-coc-dashboard/
├── public/
│   └── index.html          # Full frontend (dark theme, collapsible tree table)
├── src/
│   ├── server.js           # Express server setup
│   ├── routes/
│   │   └── api.js          # API endpoints + debug routes
│   └── services/
│       ├── config.js       # Loads client config from CLIENTS env var
│       ├── fb.js           # Facebook Marketing API integration
│       ├── coc.js          # Checkout Champ API integration
│       └── merger.js       # Joins FB + COC data, computes derived metrics
├── package.json
└── railway.toml
```

---

## Environment Variables (Railway)

```
CLIENTS=[{"id":"client1","name":"Eric","cocLoginId":"XXX","cocPassword":"XXX","fbAccessToken":"XXX","adAccounts":[{"fbAdAccountId":"act_3250948078451590","cocCampaignId":1,"cocCampaignName":"Plant"},{"fbAdAccountId":"act_1088236576461732","cocCampaignId":2,"cocCampaignName":"Faith"}]}]
FB_API_VERSION=v18.0
PORT=3000
```

To add a new client, add another object to the `CLIENTS` JSON array. Each client can have multiple ad accounts.

---

## Data Join Logic (Critical)

FB and COC are joined using UTM parameters:

| FB Level | COC Field | Example |
|----------|-----------|---------|
| Ad Account | `cocCampaignId` (configured per account) | `act_3250948078451590` → campaignId 1 |
| FB `campaign_name` | `UTMCampaign` | `"NOV \| PUR"` |
| FB `adset_name` | `UTMMedium` | `"NOV \| A30+"` |
| FB `ad_name` | `UTMContent` | `"PLANNER"` |

**Important:** UTM values must match exactly (case-sensitive, including spaces/pipes). COC field names are capitalized (`UTMCampaign`, not `utm_campaign`).

---

## Checkout Champ API — Key Details

**Base URL:** `https://api.checkoutchamp.com` (NOT `app.checkoutchamp.com`)

**Auth:** GET requests with `loginId` and `password` as URL query params (no headers)

**Date format:** `M/D/YY` (e.g. `2/22/26`, not `2026-02-22`)

### Sales Count — How It Works

COC's "Sales" metric = **COMPLETE orders**, not transaction count.

```
GET /order/query/?orderStatus=COMPLETE&orderType=NEW_SALE&campaignId=X
```

One order = one sale. This matches COC's own "By Campaign" dashboard exactly.

**Do NOT use transaction counting** — a single order can generate multiple transactions (e.g. main offer + $1 trial bump as separate charges), which causes double-counting.

### Revenue Calculation

```javascript
revenue = order.totalAmount + order.baseShipping
```

- `totalAmount` = product charges (already includes order bumps/upsells in same transaction)
- `baseShipping` = shipping charged separately on some orders
- This gives ~99.2% accuracy vs COC dashboard (remaining ~0.8% gap is unidentified, likely internal COC adjustments not exposed in API)

### Partials Count

```
GET /order/query/?orderStatus=PARTIAL&orderType=NEW_SALE&campaignId=X
```

Partials = visitors who started checkout but didn't complete payment.

### Declines Count

```
GET /transactions/query/?txnType=SALE&responseType=SOFT_DECLINE
```

Filter client-side: `billingCycleNumber === 1` only, deduplicate by `orderId`.

**Note:** The API ignores `orderType=NEW_SALE` filter on the transactions endpoint — it returns all transaction types regardless. Must filter client-side.

### Pagination

COC returns 25 results/page by default. Always set `resultsPerPage=200` and loop through all pages using the `page` param. Check `totalResults` from first response to know when to stop.

### UTM Filtering

Pass UTM params to narrow results:
```
?UTMCampaign=NOV+%7C+PUR&UTMMedium=NOV+%7C+A30%2B&UTMContent=PLANNER
```

---

## Facebook API — Key Details

- Uses FB Marketing API Insights endpoint
- Fetches campaign → adset → ad hierarchy with spend, impressions, clicks
- Access token stored per-client in `CLIENTS` env var
- API version in `FB_API_VERSION` env var (currently `v18.0`)

---

## Metrics Definitions

| Metric | Formula |
|--------|---------|
| **ROAS** | Revenue / FB Spend |
| **CPP** | FB Spend / Sales |
| **AOV** | Revenue / Sales |
| **Conv%** | Sales / (Partials + Sales + Declines) × 100 |
| **Dec%** | Declines / (Sales + Declines) × 100 |
| **Sales%** | Sales / (Partials + Sales + Declines) × 100 |
| **Net Rev** | Revenue + Upsell Total - Refunds |

---

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /api/clients` | List configured clients |
| `GET /api/dashboard/:clientId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | Full dashboard data |
| `GET /api/debug/coc/:clientId?campaignId=X&startDate=...&endDate=...` | Raw COC API responses for debugging |
| `GET /api/debug/revenue/:clientId?campaignId=X&startDate=...&endDate=...` | Revenue breakdown per order for debugging |

---

## Known Issues / Gotchas

1. **Revenue ~0.8% below COC dashboard** — acceptable for optimization purposes; root cause unknown, likely internal COC adjustments
2. **Timezone mismatch** — COC uses Eastern time, FB uses ad account timezone; day-boundary numbers may differ slightly on "Today"
3. **UTM matching is exact** — trailing spaces in UTM values will cause mismatches (seen in production: `"NOV | A30 "` with trailing space vs `"NOV | A30+"`)
4. **FB API rate limits** — if running many clients/date ranges, may hit rate limits; add retry logic if needed

---

## Adding a New Client

1. Edit the `CLIENTS` env var in Railway to add a new client object:
```json
{
  "id": "client2",
  "name": "ClientName",
  "cocLoginId": "their-coc-login",
  "cocPassword": "their-coc-password",
  "fbAccessToken": "their-fb-token",
  "adAccounts": [
    {
      "fbAdAccountId": "act_XXXXXXXXXX",
      "cocCampaignId": 3,
      "cocCampaignName": "CampaignLabel"
    }
  ]
}
```
2. Redeploy (or Railway auto-deploys on env var change)
3. Client appears in the dropdown immediately

---

## Development History

Built February 2026. Key debugging discoveries:

- COC API base URL is `api.checkoutchamp.com` (not `app.`)
- COC auth is GET params, not POST/Basic auth
- `orderType=NEW_SALE` filter ignored by transactions endpoint — must filter client-side
- Recurring subscription charges have `billingCycleNumber > 1` — must exclude
- Sales count must use `order/query COMPLETE` not transaction counting (avoids double-counting multi-transaction orders)
- Revenue = `totalAmount + baseShipping` (not just totalAmount)

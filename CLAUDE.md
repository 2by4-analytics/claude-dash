# 2by4 Dash (Media Dashboard) — CLAUDE.md

Data layer for the 2by4 Agency OS. See the master OS context at the top-level `CLAUDE.md` for full client roster, metrics definitions, and infrastructure overview.

---

## What Dash Is

Dash is the data layer of the 2by4 Agency OS. It:
- Pulls Meta Ads data via the Facebook Marketing API
- Pulls order data from Checkout Champ (CoC) via their REST API
- Joins them using UTM parameters as the linking key
- Serves unified metrics via a JSON API that Brain consumes
- Renders a visual dashboard at `dash.2by4llc.com` for human review

Dash is the **source of truth** for all performance data. If Brain and Dash disagree, the bug is always in Brain's data path.

---

## File Structure

```
claude-dash/
├── package.json
├── railway.toml
├── public/
│   ├── index.html             # Main dashboard UI (dark theme, collapsible hierarchy)
│   ├── admin.html             # Client admin portal
│   ├── dash.html              # (legacy or alternate view)
│   └── cpp-daily.html         # CPP daily view
├── src/
│   ├── server.js              # Express server setup
│   ├── routes/
│   │   ├── api.js             # All API endpoints + debug routes
│   │   └── admin.js           # Admin portal routes
│   └── services/
│       ├── config.js          # Loads client config from CLIENTS env var
│       ├── fb.js              # Facebook Marketing API integration
│       ├── coc.js             # Checkout Champ API integration
│       └── merger.js          # Joins FB + CoC data, computes derived metrics
└── fb-coc-dashboard/          # Legacy version — do not edit, kept for reference only
```

---

## Environment Variables

```
CLIENTS=[{"id":"client1","name":"Eric",...}]   # Full client config JSON array
FB_API_VERSION=v18.0
DASH_PASSWORD=                                  # Auth header value for API calls
PORT=3000
```

To add a new client: add object to `CLIENTS` JSON array in Railway env vars → redeploy.

---

## API Endpoints

| Endpoint | Description |
|---|---|
| `GET /api/clients` | List all configured clients |
| `GET /api/dashboard/:clientId?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` | Full merged FB + CoC metrics |
| `GET /api/debug/coc/:clientId?campaignId=X&startDate=...&endDate=...` | Raw CoC API response |
| `GET /api/debug/revenue/:clientId?campaignId=X&startDate=...&endDate=...` | Revenue breakdown per order |

Auth: all requests require `x-dash-password` header matching `DASH_PASSWORD` env var.

---

## Data Join Logic

FB and CoC are joined using UTM parameters as the linking key:

| FB Level | CoC Field | Example |
|---|---|---|
| Ad Account | `cocCampaignId` (configured per account) | `act_3250948078451590` → campaignId 1 |
| FB `campaign_name` | `UTMCampaign` | `"NOV \| PUR"` |
| FB `adset_name` | `UTMMedium` | `"NOV \| A30+"` |
| FB `ad_name` | `UTMContent` | `"PLANNER"` |

**UTM matching is exact and case-sensitive.** Including spaces and pipes. Trailing spaces cause silent mismatches (seen in production).

---

## Metrics Definitions

| Metric | Formula |
|---|---|
| ROAS | Revenue / Spend |
| CPP | Spend / Sales |
| AOV | Revenue / Sales |
| Conv% | Sales / (Partials + Sales + Declines) × 100 |
| Dec% | Declines / (Sales + Declines) × 100 |
| Net Rev | Revenue + Upsell Total - Refunds |

**Sales count = CoC `COMPLETE` orders only.** Not transaction count. One order can generate multiple transactions (e.g. main offer + order bump as separate charges) — using transaction count causes double-counting.

**Revenue = `totalAmount + baseShipping`.** Not just `totalAmount`. Gives ~99.2% accuracy vs CoC dashboard (remaining ~0.8% gap is unidentified internal CoC adjustments).

---

## Checkout Champ API — Critical Details

- **Base URL:** `https://api.checkoutchamp.com` (NOT `app.checkoutchamp.com`)
- **Auth:** GET params — `?loginId=X&password=Y` (not headers, not POST)
- **Date format:** `M/D/YY` (e.g. `2/22/26`, not `2026-02-22`)
- **Pagination:** Always set `resultsPerPage=200`, loop using `page` param, check `totalResults` on first response
- **Sales:** `GET /order/query/?orderStatus=COMPLETE&orderType=NEW_SALE&campaignId=X`
- **Partials:** `GET /order/query/?orderStatus=PARTIAL&orderType=NEW_SALE&campaignId=X`
- **Declines:** `GET /transactions/query/?txnType=SALE&responseType=SOFT_DECLINE` → filter client-side: `billingCycleNumber === 1` only, deduplicate by `orderId`. Note: `orderType=NEW_SALE` filter is ignored by the transactions endpoint — must filter client-side.

---

## Facebook Marketing API — Critical Details

- Access token stored per-client in `CLIENTS` env var
- API version in `FB_API_VERSION` (currently `v18.0`)
- Date preset: `last_7d` (not `last_7_days`)
- Insights endpoint: `/insights` (not `/ads/insights`)
- Hierarchy: Account → Campaign → Adset → Ad

---

## Known Issues / Gotchas

1. **Revenue ~0.8% below CoC dashboard** — acceptable; root cause unknown, likely internal CoC adjustments not exposed in API
2. **Timezone mismatch** — CoC uses Eastern time, FB uses ad account timezone; day-boundary numbers may differ slightly on "Today"
3. **UTM trailing spaces** — seen in production: `"NOV | A30 "` (trailing space) vs `"NOV | A30+"` causing silent mismatch
4. **FB API rate limits** — with many clients/date ranges, may hit limits; add retry logic if needed

---

## Deploy

Railway — auto-deploys on push to `main`.

```bash
git add -A && git commit -m "your message" && git push
```

Terminal alias: `dash` = `cd ~/claude-dash && claude`

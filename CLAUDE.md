# 2by4 Dash — CLAUDE.md

The hub of the 2by4 Agency OS. Two roles in one repo:

1. **Launchpad** — the public root of `dash.2by4llc.com`. Branded landing page with today's calendar + tasks, sticker CPP, sheds CPL, and links to the other tools.
2. **Media Dashboard** — the original FB Ads + Checkout Champ unified dashboard, now served at `/dash` (was the root before the launchpad).

The Media Dashboard half is the **source of truth** for all sticker performance data. If Brain and Dash disagree, the bug is always in Brain's data path.

---

## File Structure

```
claude-dash/
├── package.json
├── railway.toml
├── public/
│   ├── index.html             # Launchpad (light, branded — matches 2by4llc.com)
│   ├── dash.html              # Media Dashboard (dark theme, collapsible hierarchy)
│   ├── cpp-daily.html         # CPP Daily — one card per sticker client
│   └── admin.html             # Client admin portal
├── src/
│   ├── server.js              # Express + auth middleware + cron
│   ├── routes/
│   │   ├── api.js             # All /api/* endpoints
│   │   └── admin.js           # /api/admin/* (its own x-admin-password header)
│   └── services/
│       ├── config.js          # Loads CLIENTS env var
│       ├── fb.js              # Facebook Marketing API
│       ├── coc.js             # Checkout Champ API
│       ├── merger.js          # Joins FB + CoC by UTM
│       └── google.js          # Calendar + Drive (Launchpad TODAY block)
└── fb-coc-dashboard/          # Legacy version — do not edit, kept for reference only
```

---

## Environment Variables

```
# Auth
DASH_PASSWORD=                     # x-dash-password (and ?pw=) for /api/*
ADMIN_PASSWORD=                    # admin portal (separate)

# Clients (full config blob)
CLIENTS=[...]                      # see schema below
FB_API_VERSION=v18.0
PORT=3000

# Sheds proxy (Launchpad sheds row)
SHEDS_BASE_URL=https://sheds.2by4llc.com
SHEDS_DASH_PASSWORD=               # NOT the same as DASH_PASSWORD — sheds has its own

# Google (Launchpad TODAY block)
GOOGLE_SERVICE_ACCOUNT_JSON=       # whole SA JSON, as a string
GOOGLE_CALENDAR_ID=                # full ID, e.g. c_<random>@group.calendar.google.com
                                   # see "Calendar gotcha" below
STICKER_CLIENTS_FOLDER_ID=         # Drive parent folder of sticker client subfolders
SHED_CLIENTS_FOLDER_ID=            # Drive parent folder of shed client subfolders
```

To add a sticker/shed client: add object to `CLIENTS` JSON array → redeploy.

---

## API Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/auth/verify` | Login screen — returns 200 on correct `x-dash-password` |
| `GET /api/clients` | Configured client list |
| `GET /api/dashboard/:clientId?startDate&endDate` | Full merged FB + CoC metrics for the Media Dashboard |
| `GET /api/prior/:clientId?startDate&endDate` | Same shape, equivalent prior period |
| `GET /api/insights/:clientId?date=YYYY-MM-DD` | Adset/ad-level CPP-trend flagging (yesterday vs 7d) |
| `GET /api/cpp-daily` | Yesterday's CPP per sticker client (cached, pre-warmed 5am CT cron) |
| `GET /api/cpp-7day` | 7-day rolling CPP per sticker client (same cache) |
| `GET /api/sheds/cpl-yesterday` | Proxies sheds.2by4llc.com `/api/rollup` → CPL row per shed client (5min cache) |
| `GET /api/today/meetings` | Google Calendar events for today CT |
| `GET /api/today/tasks` | Open `- [ ]` items parsed from each client folder's CLAUDE.md |
| `GET /api/today/debug` | Diagnostic snapshot — calendar accessibility, folders, parsed task sections |
| `GET /api/debug/coc/:clientId?campaignId&startDate&endDate` | Raw CoC responses |
| `GET /api/debug/orders/:clientId?campaignId&startDate&endDate` | Order status/type breakdown |
| `GET /api/debug/revenue/:clientId?campaignId&startDate&endDate` | Per-order revenue breakdown |

Auth: every `/api/*` route is gated by `dashAuth` (header `x-dash-password` or `?pw=` query param).

---

## Launchpad (`public/index.html`)

The `/` page. Sections, top to bottom:

- **Hero**: brand-mark + "Launchpad", today's date right-aligned.
- **TODAY**: meetings + tasks. See "Google integration" below.
- **Sticker · yesterday CPP**: one mini-card per sticker client. Reuses `/api/cpp-daily` + `/api/cpp-7day`. Green/red border vs `cppTarget`.
- **Sheds · yesterday CPL**: one mini-card per shed client. Pulls from the proxy.
- **Tools**: Media Dashboard (`/dash`), Sheds Meta Ads, Brain, Admin. All open in new tabs.
- **Clients**: Phase 3 placeholder.

Design system mirrors `2by4llc.com`: Manrope body, Instrument Serif for hero/values, navy `#0f172a` ink, amber `#f59e0b` accent, light gradient background. Brand mark inlined as SVG (also serves as the favicon).

---

## Google integration (`src/services/google.js`)

Powers the TODAY block. Service-account auth via `GOOGLE_SERVICE_ACCOUNT_JSON`.

**Meetings.** Calendar events list for today (CT), 60s in-memory cache. Each event tagged with the longest case-insensitive client folder name found in the title.

**Tasks.** For each subfolder under `STICKER_CLIENTS_FOLDER_ID` and `SHED_CLIENTS_FOLDER_ID`, fetches `CLAUDE.md` (case-insensitive name match) and parses the first heading matching `## Tasks`, `## Open Items`, `## Todo`, `## To Do`, or `## Action Items`. Returns only `- [ ]` items. 10min cache; any Drive read error invalidates the whole list rather than serving partial.

**Task line syntax:**
```
- [ ] Description text
- [ ] !! Urgent task — due 03-05 #design   ← !! prefix = urgent, DD-MM due, #tags
- [x] Completed (skipped)
```
Year on `due DD-MM` is inferred: month < current → next year, month > current+6 → last year, else this year.

### Calendar gotcha — "Not Found" with `accessibleCalendars: []`

Workspace secondary calendars (e.g. Alan's "Work" calendar) have their own random ID — `c_<random>@group.calendar.google.com` — **not** the user's email. The SA only sees calendars explicitly shared with it. To find the real ID: Google Calendar → Settings for my calendars → click the calendar → "Integrate calendar" → "Calendar ID". Set that as `GOOGLE_CALENDAR_ID`. Don't use `'primary'` (the SA has no primary of its own) and don't use the user's email unless you've shared the user's primary calendar.

If meetings 404, hit `/api/today/debug?pw=…` — `calendar.accessibleCalendars` lists every calendar the SA can see.

---

## Sheds proxy (`/api/sheds/cpl-yesterday`)

Sheds lives in a separate repo (`2by4-analytics/2by4-sheds`) with its own Railway service + its own `DASH_PASSWORD` (different value from this service's). The launchpad calls **this** proxy, which:

1. Fetches `${SHEDS_BASE_URL}/api/rollup?startDate=YESTERDAY_CT&endDate=YESTERDAY_CT` with header `x-dash-password: SHEDS_DASH_PASSWORD`.
2. Maps the response: `cpl → costPerResult`, `leads → results`, `resultType: 'leads'`.
3. 5min in-memory cache keyed on yesterday's CT date.

The upstream contract is in `github.com/2by4-analytics/2by4-sheds/server.js` — `/api/rollup` returns all clients in one call, so no per-client loop is needed.

---

## Data Join Logic (Media Dashboard)

FB and CoC join by UTMs:

| FB Level | CoC Field | Example |
|---|---|---|
| Ad Account | `cocCampaignId` (configured per account) | `act_3250948078451590` → campaignId 1 |
| FB `campaign_name` | `UTMCampaign` | `"NOV \| PUR"` |
| FB `adset_name` | `UTMMedium` | `"NOV \| A30+"` |
| FB `ad_name` | `UTMContent` | `"PLANNER"` |

**UTM matching is exact and case-sensitive.** Trailing spaces cause silent mismatches (seen in production).

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

**Sales count = CoC `COMPLETE` orders only.** Not transaction count — one order can produce multiple transactions (main offer + bump as separate charges); using transaction count double-counts.

**Revenue = `totalAmount + baseShipping`.** Gives ~99.2% accuracy vs CoC dashboard (remaining ~0.8% gap is internal CoC adjustments not exposed in API).

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

## Cron jobs

- **5am CT daily** (`server.js`): `runCppSnapshot()` pre-warms `cacheDaily` and `cacheWeek` so the launchpad opens fast.

---

## Known Issues / Gotchas

1. **Revenue ~0.8% below CoC dashboard** — acceptable; root cause unknown
2. **Timezone mismatch** — CoC uses Eastern, FB uses ad account TZ; "today" boundaries can differ slightly
3. **UTM trailing spaces** — silent mismatch, seen in production
4. **FB API rate limits** — many clients/date ranges may trip them; add retry if needed
5. **Sheds `DASH_PASSWORD` ≠ this service's `DASH_PASSWORD`** — must explicitly set `SHEDS_DASH_PASSWORD` here to the value from the sheds Railway service
6. **Service-account calendar access** — see "Calendar gotcha" above
7. **`primary` calendar ID** — only works with domain-wide delegation; otherwise 404s for service accounts

---

## Deploy

Railway — auto-deploys on push to `main`.

```bash
git add -A && git commit -m "your message" && git push
```

Terminal alias: `dash` = `cd ~/claude-dash && claude`

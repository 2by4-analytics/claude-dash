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
│   ├── control.html           # Control panel (/control): live status of every job/service + needs-you inbox
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
│       ├── google.js          # Calendar + Drive (Launchpad TODAY block + writes)
│       ├── hb-ghl-sync.js     # Happy Bakers CoC → GHL tags (15-min cron)
│       ├── hb-support/        # Happy Bakers customer-service agent (5-min cron)
│       ├── hb-inventory/      # Happy Bakers inventory agent (daily 7:30 CT forecast email)
│       ├── control/           # Control panel: registry, probes, run log, mini heartbeat, 7:15 email
│       └── markdown.js        # Pure helpers: toggle/append checkbox lines in CLAUDE.md
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

# Brain (Launchpad meeting-notes upload → recap)
BRAIN_BASE_URL=https://brain.2by4llc.com   # defaults to this if unset
                                   # Brain's /api/agents/meeting-recap is gated by x-dash-password
                                   # matching this service's DASH_PASSWORD.

# Google (Launchpad TODAY block + writes)
GOOGLE_SERVICE_ACCOUNT_JSON=       # whole SA JSON, as a string
GOOGLE_CALENDAR_ID=                # full ID, e.g. c_<random>@group.calendar.google.com
                                   # see "Calendar gotcha" below
STICKER_CLIENTS_FOLDER_ID=         # Drive parent folder of sticker client subfolders
SHED_CLIENTS_FOLDER_ID=            # Drive parent folder of shed client subfolders
                                   # Both folders must grant the SA **Editor** access — toggling
                                   # checkboxes, adding tasks, and saving meeting recaps all
                                   # write to Drive. Sharing the parent `2by4` folder as Editor
                                   # cascades to both.

# Bagger's Corner lead capture (POST /api/coc/lead) — OPTIONAL overrides
BC_COC_LOGIN_ID=                   # defaults to 'brianreports-api' (reuses that
                                   # API user's password from CLIENTS — already
                                   # IP-whitelisted in CoC; no new password needed)
BC_COC_CAMPAIGN_ID=                # defaults to '2' (the BC funnel's CoC campaign)
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
| `GET /api/today/folders` | All configured client folders (name + type) — feeds the Clients section so zero-task clients still appear |
| `POST /api/today/tasks/toggle` | Body `{ client, raw }` — flip `- [ ]` ↔ `- [x]` on the matching line in CLAUDE.md |
| `POST /api/today/tasks/add` | Body `{ client, text }` — append `- [ ] text` under the first task heading (creates `## Open Items` if absent) |
| `POST /api/today/upload` | Body `{ client, filename, fileBase64?, fileText?, fileMimeType?, todayDate? }` — proxies to Brain's meeting-recap agent, returns draft `{ recapMarkdown, openItems[], suggestedFilename }` for user review |
| `POST /api/today/upload/commit` | Body `{ client, filename, recapMarkdown, openItems[] }` — writes the recap to `<client>/meetings/<filename>.md` and appends approved items to CLAUDE.md |
| `GET /api/today/debug` | Diagnostic snapshot — calendar accessibility, folders, parsed task sections |
| `POST /api/coc/lead` | Body `{ firstName, lastName, emailAddress, phoneNumber, answers?, ipAddress? }` — Bagger's Corner opt-in → CoC partial lead (Import Click → Import Lead). Lander proxies here so CoC is only hit from Dash's whitelisted IP. Reuses `brianreports-api` creds from CLIENTS + campaign 2. Returns `{ ok, sessionId }` |
| `POST /api/hb/ghl-sync?days=3&dry=1` | Happy Bakers: CoC campaign 15 partials + buyers → GHL "The Happy Baker" contacts with tags `hb partial` / `hb buyer` + product tags (incl. `hb monthly stickers` = product 247, `hb rolling pin tee` = the one-time shop tee 321–333, kept out of `hb tee` / Bought Tee), and one opportunity per buyer in the "Happy Baker Stickers" pipeline at the FURTHEST stage bought (Bought Sticker → Sticker Club → Baker Box → Tee; forward-only, canceled → lost). Backfill: `?days=120&buyersOnly=1` (skips partials, ~15 min; any push to main redeploys and kills an in-flight backfill, so re-POST; it is idempotent). `dry=1` previews. Cron runs it every 15 min; people whose pushed state is unchanged (fingerprint in `/data/hb-support/ghl-sync-pushed.json`, 30-day TTL) are skipped so it stays inside the 200k/day GHL quota the support agent shares. `force=1` re-pushes everyone. Env `HB_GHL_PIT`, `HB_GHL_LOCATION_ID` (+ the `HB_COC_*` creds) |
| `GET /api/hb/ghl-sync/status` | Last HB→GHL run summary (counts, errors) |
| `GET /api/hb/support/status` | HB support agent: mode, last run, latest 50 cases, learned lessons |
| `POST /api/hb/support/run` | Run the support agent now (same as the 5-min cron) |
| `POST /api/hb/support/try?conversationId=` | Dry run on one GHL conversation's newest customer email: decision + the email Alan would get. Sends/changes nothing |
| `POST /api/hb/support/close?ids=53,54` | Close cases with NO emails (cleanup of agent-error cases; closing by email sends Alan a "Done" each). 409 if the agent is mid-run |
| `POST /api/hb/support/act` | Body `{ caseId, actions: [{ type: 'change_tee_size', purchase_id, size }] }` — run owner-approved actions on a case through the same checks + CoC calls, with NO customer reply and NO owner email (staff fixes from Claude Code). 400 if the agent is mid-run |
| `POST /api/hb/support/mode?mode=approve\|auto\|off` | Switch the agent's mode (Alan can also email `agent: auto` etc.) |
| `GET /api/hb/support/address` | Bad-address flow: mode, batches, every flagged ShipStation order + its status |
| `GET /api/hb/support/address/preview` | Read-only: HB ShipStation orders flagged right now + whether they're past the grace period |
| `GET /api/hb/inventory/status` | HB inventory agent: last run, recent reports, log of Alan's replies + what they changed |
| `GET /api/hb/inventory/forecast` | Fresh forecast JSON (nothing sent). The HB dashboard's Inventory tab pulls it on every refresh |
| `POST /api/hb/inventory/run?send=0\|1&force=1` | Run the forecast now. `send=0` (default) returns the forecast + email text and sends nothing; `send=1` emails Alan (`force=1` even if today's already went) |
| `POST /api/hb/inventory/temu?write=0&notify=0` | Temu → 3PL sheet + log new Temu orders to the Ledger now (hourly cron + the 7:30 run do it too). `write=0` = read mail + build rows only; `notify=0` = no email to Alan |
| `GET /api/control/status?fresh=1` | Control panel: every registry row with ok/warn/bad/off/unknown + reason, needs-you inbox, recent control actions. 60s cache unless `fresh=1` |
| `POST /api/control/heartbeat` | Mac mini launchd snapshot (from `~/2by4-control/heartbeat.mjs`, every 5 min). Reply carries queued restart commands; the next heartbeat reports results |
| `POST /api/control/action` | Body `{ target, action, value }`. Only the `controls` on that registry entry: `rerun` (hb-support, hb-ghl-sync, temu-sync, cpp-snapshot; never hb-inventory, it emails), `mode` (HB support auto/approve/off), `kill` (Autopilot kill switch, value true/false), `restart` (mini worker / CoC Chrome, queued). Logged to `/data/control/audit.json` |
| `GET /api/control/digest` / `POST /api/control/digest?to=` | Preview / send the Control morning email now |
| `GET /api/debug/coc/:clientId?campaignId&startDate&endDate` | Raw CoC responses |
| `GET /api/debug/orders/:clientId?campaignId&startDate&endDate` | Order status/type breakdown |
| `GET /api/debug/revenue/:clientId?campaignId&startDate&endDate` | Per-order revenue breakdown |
| `GET /api/debug/coc-campaign/:clientId?campaignId[&loginId]` | Raw CoC `campaign/query` — products, prices, billing cycles, shipping. `clientId` `-` + `loginId=` queries with any configured CoC API user |

Auth: every `/api/*` route is gated by `dashAuth` (header `x-dash-password` or `?pw=` query param).

---

## Launchpad (`public/index.html`)

The `/` page. Sections, top to bottom:

- **Hero**: brand-mark + "Launchpad", today's date right-aligned.
- **TODAY**: meetings + tasks. Tasks panel shows only clients with open work; checkboxes are clickable, the inline "Add task…" input commits to CLAUDE.md, and the "Upload notes" button (or drag-drop onto a client row) triggers the meeting-recap flow.
- **Sticker · yesterday CPP**: one mini-card per sticker client. Reuses `/api/cpp-daily` + `/api/cpp-7day`. Green/red border vs `cppTarget`.
- **Sheds · yesterday CPL**: one mini-card per shed client. Pulls from the proxy.
- **Tools**: Media Dashboard (`/dash`), Sheds Meta Ads, Brain, Admin. All open in new tabs.
- **Clients**: full per-client browser. Lists every configured client (sticker + shed) regardless of open-task count, with the same affordances as the Tasks panel — useful for adding a task or dropping notes on a client that has zero open items.

Design system mirrors `2by4llc.com`: Manrope body, Instrument Serif for hero/values, navy `#0f172a` ink, amber `#f59e0b` accent, light gradient background. Brand mark inlined as SVG (also serves as the favicon).

### Task writes (toggle / add / upload)

Both panels mutate the same source — `<client>/CLAUDE.md` in Drive — and bust the 10-min tasks cache after every write so the panels stay consistent. Mutations cross-refresh between Tasks panel and Clients section.

**Toggle.** Click a checkbox → `POST /api/today/tasks/toggle` with the original `raw` line text. Server flips `[ ]` ↔ `[x]` and saves. Open-task list animate-removes the row on success.

**Add.** Type into "Add task…" + Enter → `POST /api/today/tasks/add`. Server appends a `- [ ]` line directly after the last existing item under the first task heading (`## Open Items` / `## Tasks` / `## Todo` / `## To Do` / `## Action Items`). If no such heading exists, a fresh `## Open Items` section is appended at EOF.

**Upload.** Drop a file (or click Upload notes → file picker; `.md`, `.txt`, `.pdf` accepted) → `POST /api/today/upload` reads the file, sends it to Brain's `/api/agents/meeting-recap` (gated by shared `DASH_PASSWORD`), and returns `{ recapMarkdown, openItems[], suggestedFilename }`. The Launchpad shows a review modal — Alan can edit the filename, edit the recap markdown, and check/uncheck/edit each suggested action item. On commit → `POST /api/today/upload/commit` writes the recap to `<client>/meetings/<filename>.md` (creating the `meetings/` subfolder if needed) and appends checked items to `## Open Items`.

**Constraints.** Toggle/add only work on **plain markdown** CLAUDE.md files — Google Docs are rejected with a clear error to avoid clobbering Doc formatting on export-then-import. Body limit is 25 MB on `/api/*` (PDFs as base64 inflate ~33 %).

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
- **Lead import flow (`POST /api/coc/lead`):** Import Click `GET /landers/clicks/import/` → `message.sessionId`, then Import Lead `GET /leads/import/` with that `sessionId`. Click import **requires `pageType`** — valid values: `presellPage`, `catalogPage`, `leadPage`, `checkoutPage`, `downsell/upsellPage*`, `thankyouPage` — we send `leadPage`. The API user needs **Import Lead + Import Click** endpoint access (the read-only reporting user does NOT by default).

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
- **Every 5 min** (`server.js`): `runHbSupport()` — Happy Bakers customer-service agent (`src/services/hb-support/`). New inbound emails in the HB GHL location → CoC lookup → Claude decides (rules in `prompt.js` + lessons Alan teaches) → refund/cancel via CoC API and reply as Maggie Bennett, or email Alan a proposal tagged `[HB-CS-n]` and act on his emailed reply. Untagged owner emails: `agent: auto|approve|off`, `rule: …` (adds a lesson), `rule 9: …` (replaces lesson 9), `rule 9: delete`. State/cases/lessons are JSON on the Railway volume `/data/hb-support`. Automated senders (`noreply`/`no-reply`/`donotreply`/`notifications@`, `testflight*@`, `@email.apple.com`; `AUTOMATED_SENDERS` in `index.js`) are dropped before Claude and never become a case; mailer-daemon bounces are NOT on the list so a failed reply still reaches Alan. **Tee sizes (10-25):** action `change_tee_size` → CoC `purchase/update productId=<size's campaign product>` (future rebills) + `fulfillment/update` SKU on any unshipped tee, then re-reads the purchase to confirm. **Reply/action guard:** every first-person "I've updated/changed/refunded/canceled…" sentence must be backed by an executed action of the matching type, or the reply is HELD and Alan is emailed (proposal emails carry a WARNING line too). Cause: HB-CS-68 told Tammy Gurwell her tee was changed to Medium after Alan's "yes" when the agent had no size action. **By-hand steps (10-28):** when Alan's answer needs something the agent has no action for (linking an order to another email, an address change…), the answer tool sets `waiting_on_owner`: the case stays `awaiting_owner` with `heldReply`, Alan gets "Waiting on you" with the reply, and his "done"/"yes" sends that reply unchanged (no LLM, no claim check) and closes it. Same for a reply held by the claim guard. Before this, HB-CS-116 ("Link it then reply") was marked done with nothing done and no reply. `supportStatus`/`setMode` no longer reload state from disk mid-run (a status call during a run reverted case 68 to awaiting_owner). Needs `ANTHROPIC_API_KEY`; optional `HB_SUPPORT_MODE` (approve|auto|off, state overrides), `HB_SUPPORT_AUTO_REFUND_MAX` (75), `HB_SUPPORT_MODEL`, `HB_SUPPORT_ALAN_EMAIL`. The `happybaker-site-api` CoC user has Refund Order, Cancel Order, Cancel Purchase, Refund Transaction, Query Fulfillment, Customer Note/History enabled for it.
- **Bad addresses (same 5-min run, `hb-support/address.js`)**: HB ShipStation orders (stores 4905682/4905795/4910136 only; the account is shared with BGC) in Awaiting Shipment with `addressVerified` warning/failed, still flagged `HB_ADDRESS_GRACE_HOURS` (24) after import (Eric fixes obvious typos in that window). Approve mode (default): Alan gets a numbered `[HB-ADDR-n]` batch and replies `yes` / `skip 2 5` / `only 1 3` / `no`. Each chosen order is re-read, then cancelled in ShipStation (V1 has no cancel endpoint, so the full order goes back through `createorder` with `orderStatus: cancelled` + an internal note), and Maggie emails the customer asking for the full address. The customer's reply is parsed by Claude: an address (or "looks good") → Alan gets `[HB-ADDR-FIX]` with the label-ready address (Eric makes a new label) + a CoC live-subscription warning, and the customer gets a thank-you; anything else falls through to the normal support agent. No reply after `HB_ADDRESS_REMIND_HOURS` (24) → Maggie sends one reminder; after `HB_ADDRESS_STALE_DAYS` (5) → Alan gets one `[HB-ADDR-STALE]` list of who never answered (orders stay cancelled; late replies are still parsed). `address: auto|approve|off` by email switches the mode. Env `SHIPSTATION_API_KEY` / `SHIPSTATION_API_SECRET` (V1), optional `HB_SHIPSTATION_STORE_IDS`, `HB_ADDRESS_MODE`. State in `/data/hb-support/address.json`. CoC addresses are NOT updated automatically. ShipStation V1 ignores `createorder` updates to a CANCELLED order (200, nothing changes), so a fixed order ships as a NEW order with the same order number and `orderKey` + `-R`; the scan marks a flagged order whose order number it already handled as `fixed` and closes the old record (10-27, Carol Stingel).
- **7:30am CT daily** (`server.js`): `runInventory()` — Happy Bakers inventory agent (`src/services/hb-inventory/`). The Box ships one item per CALENDAR month (Ledger tab `Box Calendar`: month, sku, notes); a charge before the first month ships the first month's item, and nobody gets the same month twice (Oct 30 charge = Nov, Nov 29 charge = Dec). `forecast.js` (pure) projects every live Box sub's rebills + new signups (trailing 7-day pace, first rebill day 14, then every 30) + one-off sales of calendar items (Offers rows whose ships_first has the SKU), weighted by the measured first-rebill success rate (100% assumed until 20 first rebills are due). Stock = Inventory tab qty (in transit included) − boxes billed − one-offs. Orders are sized to cover until `inv_lead_days` + `inv_review_days` from today (+`inv_buffer_pct`), capped at the item's last month, so leftovers stay small and it asks for top-ups. Emails Alan `[HB-INV-n]`; his replies (or forwarded mail with "Temu" in the subject) go through the support agent's owner loop to `hb-inventory.handleOwner` → Claude → Ledger writes: Inventory row + Items blended unit_cost, Box Calendar month, or an `inv_*` Settings value. Temu draws line items + totals as images, so a forwarded order's Temu images (file.temu.com `cmsg-ud`/pfs-u, commimg header; not the `cmsgr-ud` recommendations) are downloaded and sent to Claude with the full forwarded body; a PO already in an Inventory row's notes for that SKU is skipped, so re-forwards don't double-count. Forwarding from alan@2by4llc.com to hello@ still works (the owner check is by sender) but is no longer needed for Temu: see the Temu line below. It never buys anything. Ledger access via `GOOGLE_SERVICE_ACCOUNT_JSON` (dash-reader is an Editor; sheet id overridable with `HB_LEDGER_SHEET_ID`). State in `/data/hb-support/inventory.json`. Local dry run: `HB_INV_RELAY=1 railway run node -e "require('./src/services/hb-inventory')._gather().then(g=>console.log(require('./src/services/hb-inventory')._report(g).text))"` (CoC via the relay, since CoC allowlists Dash's IP).
- **Temu → 3PL sheet + Ledger (hourly at :15 except 7:15, and the 7:30 send run; `hb-inventory/temu.js` + `runTemuSync` in `index.js`)**: Temu order mail goes to **alan2by4@gmail.com**, read over IMAP (`TEMU_GMAIL_USER` / `TEMU_GMAIL_APP_PASSWORD`, an app password) from All Mail AND `[Gmail]/Trash` (Alan trashes them after forwarding; Gmail empties Trash after 30 days, so every parsed message is cached in `/data/hb-support/temu.json`). Order #, tracking # and status (shipped / with carrier / out for delivery / delivered) are plain text keyed by tracking number; contents are only in images, so Claude reads each order's line items once (confirmation, else the first shipped email) and each split package's "Package N ×qty" badge once. The "Temu Shipments → 3PL" sheet (`HB_TEMU_SHEET_ID`, Drive brian/JV - baking/Temu Orders, dash-reader is an Editor) is cleared and rewritten in place (link stays stable): one row per item per package, `In Ledger` = PO found in an Inventory row's notes. Notes typed in the sheet are kept (keyed by order + tracking); a note containing "sample"/"test" stops the not-in-Ledger warning. Any order not in the Ledger (and not noted sample/test) is LOGGED automatically: Claude maps the already-read line items to SKUs using the last 8 Temu Ledger rows as examples, rows must add up to the Order total (else it's not logged and Alan is asked once), then the shared `logPurchase` writes the row + blended unit_cost. Alan does NOT forward Temu mail any more (10-23: 'just read it all from alan2by4'); a forward still works and is deduped by PO. A log emails Alan `[HB-INV-n] Logged from Temu` with the refreshed forecast; the 7:30 [HB-INV] email has a Temu section (logged from Gmail, deliveries, on the way, read problems), and a sync failure shows there instead of failing silently. imapflow needs `globalThis.crypto` (polyfilled in temu.js; Railway's Node lacks it).
- **7:15am CT daily** (`server.js`): Control morning email (see Control panel below).
- **Every 15 min** (`server.js`): `runHbGhlSync({days:3})` — Happy Bakers CoC → GHL tags + pipeline opportunities (skipped unless `HB_GHL_PIT` is set). Stages are matched by NAME in the "Happy Baker Stickers" pipeline; renaming a stage in GHL makes the sync skip it (logged in the run errors). Uses CoC `dateRangeType=dateUpdated` so partials that convert later flip to buyer; test emails skipped.

---

## Control panel (`/control`, `src/services/control/`)

One page answering "is everything running, and what's waiting on me?" Linked from the Launchpad Tools row.

- **`registry.js`**: one entry per moving part (Dash crons, Railway services, Mac mini launchd jobs, Vercel relays). Add a job = add an entry. Mini `com.2by4.*` jobs not in the registry still appear as "(unregistered)".
- **`probes.js`**: one probe per `type`. Status is ok / warn / bad / off (disabled on purpose) / unknown (couldn't check, never shown green). Autopilot is read with the same `pilot_auth` cookie its own login sets (HMAC of the shared `DASH_PASSWORD`); the ops dashboard with `ops_auth` (HMAC of `OPS_PASSWORD`), GET only because `POST /api/triage` sends its email. The relay `/api/health` endpoints email on failure, so they're only read via `?dry=1` + `STATUS_SECRET`.
- **`runlog.js`**: every cron in `server.js` goes through `track(id, fn)`, which writes `/data/control/runs.json`, so last-run survives redeploys (the services' in-memory `lastRun` doesn't). Jobs that catch their own errors must return them (`errors[]`, `logFailed[]`, or `{ error }`) or they read green.
- **Mac mini**: `~/2by4-control/heartbeat.mjs` (launchd `com.2by4.control-heartbeat`, every 5 min, env `~/.config/2by4/control.env`) POSTs launchd state + host checks. Restarts are queued here and executed by the mini, which has its own allow-list (worker + CoC Chrome only; never monthly-report). If Dash doesn't answer for 30 min the heartbeat emails Alan itself (dead-man), and again on recovery.
- **7:15 CT email**: red/amber + needs-you, sent with Gmail SMTP (`GMAIL_USER` / `GMAIL_APP_PASSWORD`, same credential as the relays' alerts; NBSPs stripped), not GHL, since the HB GHL token is one of the things it checks.
- Env: `GMAIL_USER`, `GMAIL_APP_PASSWORD`, `OPS_PASSWORD`, optional `STATUS_SECRET` + `BURNETT_RELAY_URL` / `BURNETT_DASHBOARD_URL` / `SUNFLOWER_RELAY_URL` / `USPB_RELAY_URL`, `CONTROL_EMAIL_TO`, `AUTOPILOT_URL`.

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

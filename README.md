# 2by4 Dash

The hub of the 2by4 Agency OS at **dash.2by4llc.com**.

Two roles in one repo:

1. **Launchpad** (`/`) — branded landing page: today's calendar + tasks, sticker CPP, sheds CPL, full per-client browser, and links to every other tool. The task panels are read-write — checkboxes toggle, "Add task…" appends, and dropping a meeting-notes file routes through Brain to draft a recap + action items the user reviews and commits.
2. **Media Dashboard** (`/dash`) — FB Ads + Checkout Champ unified analytics: Account → Campaign → Adset → Ad.

For development context, env vars, API surface, and gotchas see [`CLAUDE.md`](./CLAUDE.md).

---

## Stack

- **Backend:** Node.js + Express (`src/server.js`, `src/routes/api.js`)
- **Frontend:** Vanilla JS, single HTML per page (`public/index.html`, `public/dash.html`, `public/cpp-daily.html`)
- **Integrations:** Facebook Marketing API, Checkout Champ API, Google Calendar + Drive, sheds.2by4llc.com proxy
- **Hosting:** Railway, auto-deploys on push to `main`

---

## Local dev

```bash
npm install
cp .env.example .env       # fill in CLIENTS + DASH_PASSWORD at minimum
npm start                  # http://localhost:3000
```

The launchpad's TODAY block requires Google service-account credentials; without them, the meetings/tasks blocks render an error. Everything else works without Google. The SA needs **Editor** (not Reader) on the client folders — task writes and meeting-recap saves all hit Drive.

---

## Project structure

```
claude-dash/
├── public/
│   ├── index.html          # Launchpad
│   ├── dash.html           # Media Dashboard
│   ├── cpp-daily.html      # CPP Daily view
│   └── admin.html          # Client admin portal
├── src/
│   ├── server.js
│   ├── routes/{api,admin}.js
│   └── services/{config,fb,coc,merger,google,markdown}.js
└── package.json
```

---

## Deploy

Railway, push to `main`:

```bash
git add -A && git commit -m "msg" && git push
```

Env vars are managed in Railway's UI. See [`CLAUDE.md`](./CLAUDE.md#environment-variables) for the full list.

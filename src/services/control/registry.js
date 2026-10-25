// Every moving part the Control panel (/control) watches. One entry each; adding a job
// = adding an entry here. `type` picks the probe in probes.js. Mac mini launchd jobs not
// listed here still show up (as "unregistered") when the heartbeat reports them.
const H = 60, D = 24 * H;
const AUTOPILOT_URL = process.env.AUTOPILOT_URL || 'https://2by4-autopilot-production.up.railway.app';

module.exports = [
  // ── Dash crons (src/server.js) ── maxAgeMin ≈ 2–3 missed runs before it goes red.
  { id: 'hb-support', group: 'Dash jobs', type: 'dash-job', name: 'HB support agent', schedule: 'every 5 min', maxAgeMin: 20,
    needsEnv: ['HB_GHL_PIT', 'ANTHROPIC_API_KEY'], controls: ['rerun', 'mode'], link: '/api/hb/support/status' },
  { id: 'hb-ghl-sync', group: 'Dash jobs', type: 'dash-job', name: 'HB CoC → GHL sync', schedule: 'every 15 min', maxAgeMin: 50,
    needsEnv: ['HB_GHL_PIT'], controls: ['rerun'], link: '/api/hb/ghl-sync/status' },
  { id: 'temu-sync', group: 'Dash jobs', type: 'dash-job', name: 'Temu inbox → 3PL sheet + Ledger', schedule: 'hourly at :15 (not 7:15)', maxAgeMin: 2.5 * H,
    needsEnv: ['TEMU_GMAIL_USER', 'ANTHROPIC_API_KEY'], controls: ['rerun'] },
  // No rerun: a re-run sends Alan the [HB-INV] email again.
  { id: 'hb-inventory', group: 'Dash jobs', type: 'dash-job', name: 'HB inventory report', schedule: 'daily 7:30 CT', maxAgeMin: 26 * H,
    needsEnv: ['HB_GHL_PIT'], link: '/api/hb/inventory/status' },
  { id: 'cpp-snapshot', group: 'Dash jobs', type: 'dash-job', name: 'Sticker CPP snapshot', schedule: 'daily 5:00 CT', maxAgeMin: 26 * H, controls: ['rerun'] },
  { id: 'control-digest', group: 'Dash jobs', type: 'dash-job', name: 'Control morning email', schedule: 'daily 7:15 CT', maxAgeMin: 26 * H,
    needsEnv: ['GMAIL_USER', 'GMAIL_APP_PASSWORD'] },

  // ── Railway services ──
  { id: 'dash', group: 'Railway', type: 'self', name: 'Dash', schedule: 'always on', link: 'https://dash.2by4llc.com' },
  { id: 'autopilot', group: 'Railway', type: 'autopilot', name: 'Autopilot engine', schedule: 'ticks every 15 min', url: AUTOPILOT_URL, link: AUTOPILOT_URL, controls: ['kill'] },
  { id: 'brain', group: 'Railway', type: 'brain', name: 'Brain (7am briefing)', schedule: 'daily 7:00 CT',
    url: process.env.BRAIN_BASE_URL || 'https://brain.2by4llc.com', link: 'https://brain.2by4llc.com' },
  { id: 'sheds', group: 'Railway', type: 'http', name: 'Sheds dashboard', schedule: 'always on',
    url: `${process.env.SHEDS_BASE_URL || 'https://sheds.2by4llc.com'}/health`, link: 'https://sheds.2by4llc.com' },

  // ── Mac mini (via the com.2by4.control-heartbeat push every 5 min) ──
  { id: 'mini', group: 'Mac mini', type: 'mini-host', name: 'Mac mini', schedule: 'heartbeat every 5 min', maxAgeMin: 15 },
  { id: 'control-heartbeat', group: 'Mac mini', type: 'launchd', label: 'com.2by4.control-heartbeat', name: 'Control heartbeat (this panel\'s feed)', schedule: 'every 5 min', maxAgeMin: 15 },
  { id: 'autopilot-worker', group: 'Mac mini', type: 'launchd', label: 'com.2by4.autopilot-worker', name: 'Autopilot worker (Claude + ChatGPT image jobs)', schedule: 'always on', keepAlive: true, controls: ['restart'] },
  { id: 'coc-chrome', group: 'Mac mini', type: 'launchd', label: 'com.2by4.coc-chrome', name: 'CoC Chrome (:9333)', schedule: 'always on', keepAlive: true, controls: ['restart'] },
  { id: 'sss-openai-feed', group: 'Mac mini', type: 'launchd', label: 'com.2by4.sss-openai-feed', name: 'SSS OpenAI product feed', schedule: 'daily 6:15', maxAgeMin: 26 * H },
  { id: 'sss-openai-feed-check', group: 'Mac mini', type: 'launchd', label: 'com.2by4.sss-openai-feed-check', name: 'SSS feed freshness check', schedule: 'daily 9:00', maxAgeMin: 26 * H },
  { id: 'monthly-report', group: 'Mac mini', type: 'launchd', label: 'com.2by4.monthly-report', name: 'Sheds monthly report', schedule: '1st of month 9:00', maxAgeMin: 32 * D },
  { id: 'autopilot-deploy-retry', group: 'Mac mini', type: 'launchd', label: 'com.2by4.autopilot-deploy-retry', name: 'Autopilot deploy retry', schedule: 'loads itself only while Railway deploys are paused', idleWhenUnloaded: true },

  // ── Vercel (dry health checks: see the ?dry=1 change in each relay) ──
  { id: 'burnett-relay', group: 'Vercel', type: 'vercel-health', name: 'Burnett lead relay', schedule: 'health 9:00 CT', env: 'BURNETT_RELAY_URL' },
  { id: 'burnett-dashboard', group: 'Vercel', type: 'vercel-health', name: 'Burnett dashboard', schedule: 'refresh 6:00 CT', env: 'BURNETT_DASHBOARD_URL' },
  { id: 'sunflower-relay', group: 'Vercel', type: 'vercel-health', name: 'Sunflower lead relay', schedule: 'health 9:00 CT', env: 'SUNFLOWER_RELAY_URL' },
  { id: 'uspb-relay', group: 'Vercel', type: 'vercel-health', name: 'USPB lead relay', schedule: 'health 9:00 CT', env: 'USPB_RELAY_URL' },
  { id: 'shedpro-relay', group: 'Vercel', type: 'none', name: 'ShedPro relay', schedule: 'sweeps 5:40 + 6:15 CT', reason: 'no health endpoint yet' },
  { id: 'ops-dashboard', group: 'Vercel', type: 'ops', name: 'Ops dashboard (lead flow doctor)', schedule: 'refresh 7:00 CT',
    url: process.env.OPS_DASHBOARD_URL || 'https://2by4-ops-dashboard.vercel.app', link: 'https://2by4-ops-dashboard.vercel.app' },
];

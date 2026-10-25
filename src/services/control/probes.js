// One probe per registry `type`. Each returns { status, reason, lastAt?, detail? }:
// ok | warn | bad | off (disabled on purpose) | unknown (couldn't check: never shown green).
const crypto = require('crypto');
const axios = require('axios');
const store = require('./store');
const { runs } = require('./runlog');

const MIN = 60 * 1000;
const ago = (iso) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / MIN);
  if (m < 1) return 'just now';
  if (m < 90) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
};
const ageMin = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / MIN : Infinity);
const errText = (e) => (e.response ? `HTTP ${e.response.status}` : e.code || e.message);
const ctDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const ctHour = () => Number(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }));

// Same cookie Autopilot's own login sets (src/http/auth.js there); both services share DASH_PASSWORD.
const pilotCookie = () => `pilot_auth=${crypto.createHmac('sha256', process.env.DASH_PASSWORD || '').update('2by4-autopilot-v1').digest('hex')}`;
const opsCookie = () => `ops_auth=${crypto.createHmac('sha256', process.env.OPS_PASSWORD || '').update('ops-dash-v1').digest('hex')}`;

// ── Dash crons ──
function dashJob(item) {
  const missing = (item.needsEnv || []).filter((k) => !process.env[k]);
  if (missing.length) return { status: 'off', reason: `disabled: ${missing.join(', ')} not set` };
  const r = runs()[item.id];
  if (!r) return { status: 'unknown', reason: 'no run recorded since the control panel went live' };
  const base = { lastAt: r.at, detail: { ms: r.ms, lastOkAt: r.lastOkAt } };
  if (!r.ok) return { ...base, status: 'bad', reason: `failed ${ago(r.at)}: ${r.firstError || 'error'}` };
  if (ageMin(r.at) > item.maxAgeMin) return { ...base, status: 'bad', reason: `no run since ${ago(r.at)} (expected ${item.schedule})` };
  if (r.errors) return { ...base, status: 'warn', reason: `ran ${ago(r.at)} with ${r.errors} error${r.errors > 1 ? 's' : ''}: ${r.firstError || ''}` };
  return { ...base, status: 'ok', reason: `ran ${ago(r.at)}` };
}

function hbSupportExtra(out) {
  try {
    const s = require('../hb-support').supportStatus();
    const waiting = s.cases.filter((c) => c.status === 'awaiting_owner').length;
    out.detail = { ...(out.detail || {}), mode: s.mode, waiting };
    out.reason += ` · mode ${s.mode}${waiting ? ` · ${waiting} case${waiting > 1 ? 's' : ''} waiting on you` : ''}`;
    if (s.mode === 'off' && out.status === 'ok') out.status = 'warn';
  } catch (e) { out.reason += ` · status unreadable: ${e.message}`; }
  return out;
}

// ── Railway ──
function self() {
  const up = Math.round(process.uptime() / 60);
  const sha = (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7);
  return { status: 'ok', reason: `answering · up ${up < 90 ? `${up}m` : `${Math.round(up / 60)}h`}${sha ? ` · ${sha}` : ''}` };
}

async function http(item) {
  try {
    const { data } = await axios.get(item.url, { timeout: 10000 });
    return data && data.ok === false ? { status: 'bad', reason: `unhealthy: ${JSON.stringify(data).slice(0, 120)}` } : { status: 'ok', reason: 'healthy' };
  } catch (e) { return { status: 'bad', reason: `down: ${errText(e)}` }; }
}

async function autopilot(item) {
  try { await axios.get(`${item.url}/health`, { timeout: 10000 }); }
  catch (e) { return { status: 'bad', reason: `down or DB unreachable: ${errText(e)}` }; }
  let ov;
  try { ov = (await axios.get(`${item.url}/api/overview`, { timeout: 15000, headers: { Cookie: pilotCookie() } })).data; }
  catch (e) { return { status: 'unknown', reason: `healthy, but overview unreadable: ${errText(e)}` }; }
  const live = ov.accounts.filter((a) => a.enabled !== false);
  // Each account ticks on its own tick_minutes; 3 missed ticks (min 45m) = stalled.
  const stale = live.filter((a) => ageMin(a.last_run_finished) > Math.max(45, 3 * (a.tick_minutes || 15)));
  const failed = live.filter((a) => a.last_run_status && a.last_run_status !== 'ok');
  const newest = live.map((a) => a.last_run_finished).filter(Boolean).sort().pop();
  const modes = live.reduce((m, a) => ((m[a.mode] = (m[a.mode] || 0) + 1), m), {});
  const out = {
    lastAt: newest,
    detail: { kill_switch: ov.kill_switch, modes, accounts: live.map((a) => ({ id: a.id, name: a.name, mode: a.mode, status: a.last_run_status, at: a.last_run_finished, alerts: a.open_alerts })) },
    status: 'ok',
    reason: `${live.length} accounts (${Object.entries(modes).map(([k, v]) => `${v} ${k}`).join(', ')}) · last tick ${ago(newest)}`,
  };
  if (failed.length) { out.status = 'warn'; out.reason = `${failed.map((a) => a.name).join(', ')}: last run ${failed[0].last_run_status}${failed[0].last_run_error ? ` (${String(failed[0].last_run_error).slice(0, 100)})` : ''} · ${out.reason}`; }
  if (stale.length) { out.status = 'bad'; out.reason = `stalled: ${stale.map((a) => a.name).join(', ')} · ${out.reason}`; }
  if (ov.kill_switch) { out.status = 'warn'; out.reason = `KILL SWITCH ON: nothing executes · ${out.reason}`; }
  return out;
}

async function brain(item) {
  let b;
  try { b = (await axios.get(`${item.url}/api/briefing/latest`, { timeout: 15000 })).data; }
  catch (e) { return { status: 'bad', reason: `down: ${errText(e)}` }; }
  if (!b || b.empty) return { status: 'warn', reason: 'up, but no briefing stored yet' };
  const due = ctHour() >= 8; // 7:00 run plus slack
  if (due && b.date !== ctDate()) return { status: 'bad', lastAt: b.generatedAt, reason: `no briefing today (latest ${b.date}, ${ago(b.generatedAt)})` };
  if (ageMin(b.generatedAt) > 26 * 60) return { status: 'bad', lastAt: b.generatedAt, reason: `latest briefing ${ago(b.generatedAt)}` };
  return { status: 'ok', lastAt: b.generatedAt, reason: `briefing ${b.date} · ${(b.clients || []).length} clients · ${ago(b.generatedAt)}` };
}

// ── Mac mini ──
const heartbeat = () => store.load('mini', null);

function miniHost(item) {
  const hb = heartbeat();
  if (!hb) return { status: 'unknown', reason: 'no heartbeat received yet' };
  const out = { lastAt: hb.receivedAt, detail: { uptimeSec: hb.uptimeSec, diskFreeGb: hb.diskFreeGb, checks: hb.checks } };
  if (ageMin(hb.receivedAt) > item.maxAgeMin) return { ...out, status: 'bad', reason: `no heartbeat since ${ago(hb.receivedAt)}: mini asleep, offline or the heartbeat job stopped` };
  const problems = Object.entries(hb.checks || {}).filter(([, v]) => v === false).map(([k]) => k);
  if (hb.diskFreeGb != null && hb.diskFreeGb < 15) problems.push(`only ${hb.diskFreeGb} GB free`);
  const days = hb.uptimeSec ? Math.floor(hb.uptimeSec / 86400) : null;
  const base = `heartbeat ${ago(hb.receivedAt)} · up ${days != null ? `${days}d` : '?'} · ${hb.diskFreeGb ?? '?'} GB free`;
  return problems.length ? { ...out, status: 'warn', reason: `${problems.join(', ')} · ${base}` } : { ...out, status: 'ok', reason: base };
}

function launchd(item, hb = heartbeat()) {
  if (!hb || ageMin(hb.receivedAt) > 15) return { status: 'unknown', reason: 'mini heartbeat is stale' };
  const j = (hb.jobs || []).find((x) => x.label === item.label);
  if (!j) return { status: 'bad', reason: 'plist missing from ~/Library/LaunchAgents' };
  const out = { lastAt: j.freshAt, detail: j };
  if (!j.loaded) return item.idleWhenUnloaded ? { ...out, status: 'off', reason: 'idle (not loaded)' } : { ...out, status: 'bad', reason: 'not loaded in launchd' };
  if (item.keepAlive || j.keepAlive) {
    if (!j.pid) return { ...out, status: 'bad', reason: `not running (last exit ${j.lastExit})` };
    if (j.health === false) return { ...out, status: 'bad', reason: `running but failing its check: ${j.healthNote || ''}` };
    if (ageMin(j.procStartedAt) < 10) return { ...out, status: 'warn', reason: `restarted ${ago(j.procStartedAt)} (pid ${j.pid})` };
    return { ...out, status: 'ok', reason: `running since ${ago(j.procStartedAt)}${j.healthNote ? ` · ${j.healthNote}` : ''}` };
  }
  if (j.lastExit && j.lastExit !== 0) return { ...out, status: 'bad', reason: `last run exited ${j.lastExit}${j.lastErrLine ? `: ${j.lastErrLine}` : ''}` };
  if (j.problems && j.problems.length) return { ...out, status: 'warn', reason: `ran ${ago(j.freshAt)}, reported: ${j.problems.join('; ').slice(0, 160)}` };
  if (!j.freshAt) return { ...out, status: 'unknown', reason: 'no run on the mini yet' };
  if (item.maxAgeMin && ageMin(j.freshAt) > item.maxAgeMin) return { ...out, status: 'bad', reason: `no run since ${ago(j.freshAt)} (expected ${item.schedule})` };
  return { ...out, status: 'ok', reason: `ran ${ago(j.freshAt)}` };
}

// ── Vercel ──
async function vercelHealth(item) {
  const base = process.env[item.env];
  if (!base || !process.env.STATUS_SECRET) return { status: 'unknown', reason: 'dry health check not wired yet' };
  try {
    const { data } = await axios.get(`${base}/api/health?dry=1`, { timeout: 15000, headers: { Authorization: `Bearer ${process.env.STATUS_SECRET}` }, validateStatus: () => true });
    if (data && data.ok) return { status: data.paused ? 'off' : 'ok', lastAt: data.lastLead || data.generatedAt, reason: data.paused ? 'paused' : `healthy · last ${data.lastLead ? 'lead' : 'refresh'} ${ago(data.lastLead || data.generatedAt)}` };
    return { status: 'bad', lastAt: data && (data.lastLead || data.generatedAt), reason: (data && (data.problems || []).join('; ')) || 'unhealthy' };
  } catch (e) { return { status: 'unknown', reason: `couldn't check: ${errText(e)}` }; }
}

// GET only: POST /api/triage SENDS the triage email.
async function ops(item) {
  if (!process.env.OPS_PASSWORD) return { status: 'unknown', reason: 'OPS_PASSWORD not set on Dash' };
  try {
    const { data } = await axios.get(`${item.url}/api/triage?format=json`, { timeout: 20000, headers: { Cookie: opsCookie() } });
    const out = { lastAt: data.generatedAt, detail: { actionable: data.actionable } };
    if (ageMin(data.generatedAt) > 26 * 60) return { ...out, status: 'bad', reason: `snapshot ${ago(data.generatedAt)}: the 7am refresh didn't run` };
    return { ...out, status: 'ok', reason: `snapshot ${ago(data.generatedAt)} · ${data.actionable} leads to act on` };
  } catch (e) { return { status: 'unknown', reason: `couldn't check: ${errText(e)}` }; }
}

async function probe(item) {
  switch (item.type) {
    case 'dash-job': { const o = dashJob(item); return item.id === 'hb-support' && o.status !== 'off' ? hbSupportExtra(o) : o; }
    case 'self': return self();
    case 'http': return http(item);
    case 'autopilot': return autopilot(item);
    case 'brain': return brain(item);
    case 'mini-host': return miniHost(item);
    case 'launchd': return launchd(item);
    case 'vercel-health': return vercelHealth(item);
    case 'ops': return ops(item);
    case 'none': return { status: 'unknown', reason: item.reason || 'no check' };
    default: return { status: 'unknown', reason: `no probe for type ${item.type}` };
  }
}

module.exports = { probe, launchd, heartbeat, pilotCookie, ago, ageMin };

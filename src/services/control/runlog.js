// Last result of every Dash cron, kept on the volume so a redeploy doesn't wipe it
// (the services' own in-memory lastRun resets to null on every deploy).
const store = require('./store');

// HB jobs catch per-item errors and return them in summary.errors instead of throwing.
function summarize(result) {
  if (!result || typeof result !== 'object') return {};
  // Temu keeps orders it couldn't log in logFailed until Alan answers.
  const errors = [...(Array.isArray(result.errors) ? result.errors : []), ...(Array.isArray(result.logFailed) ? result.logFailed : [])];
  const out = { errors: errors.length, firstError: errors[0] ? String(errors[0]).slice(0, 300) : undefined };
  if (result.skipped) out.skipped = String(result.skipped);
  if (result.error) out.failed = String(result.error).slice(0, 300); // caught inside the job (runCppSnapshot)
  return out;
}

function record(id, entry) {
  const runs = store.load('runs', {});
  const prev = runs[id] || {};
  runs[id] = { ...entry, lastOkAt: entry.ok ? entry.at : prev.lastOkAt, lastFailAt: entry.ok ? prev.lastFailAt : entry.at };
  store.save('runs', runs);
}

// Wraps a job: runs it, records { at, ok, ms, errors, firstError }, and rethrows so the
// caller's own .catch logging still happens.
async function track(id, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    const s = summarize(result);
    // "already running" means the previous run is still going, not that this one ran.
    if (s.skipped) return result;
    const { failed, ...rest } = s;
    record(id, { at: new Date(started).toISOString(), ok: !failed, ms: Date.now() - started, ...rest, ...(failed ? { firstError: failed, errors: rest.errors + 1 } : {}) });
    return result;
  } catch (e) {
    record(id, { at: new Date(started).toISOString(), ok: false, ms: Date.now() - started, errors: 1, firstError: String(e.message || e).slice(0, 300) });
    throw e;
  }
}

const runs = () => store.load('runs', {});

module.exports = { track, runs };

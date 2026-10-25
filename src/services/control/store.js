// Control panel state on the Railway volume (/data/control): run log, mini heartbeat,
// queued mini commands, control audit. Same whole-file + atomic-rename pattern as
// services/hb-support/store.js (one Dash replica, small files).
const fs = require('fs');
const path = require('path');

const DIR = process.env.CONTROL_DIR
  || (fs.existsSync('/data') ? '/data/control' : path.join(__dirname, '../../../data/control'));

function file(name) { return path.join(DIR, `${name}.json`); }

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error(`[control] ${name}.json unreadable:`, e.message); return fallback; }
}

function save(name, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file(name));
}

module.exports = { load, save, DIR };

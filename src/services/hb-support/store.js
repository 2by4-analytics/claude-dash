// JSON files on the Railway volume (/data). Small and single-writer (one Dash
// replica, one run at a time), so whole-file writes with an atomic rename are enough.
const fs = require('fs');
const path = require('path');

const DIR = process.env.HB_SUPPORT_DIR
  || (fs.existsSync('/data') ? '/data/hb-support' : path.join(__dirname, '../../../data/hb-support'));

function file(name) { return path.join(DIR, `${name}.json`); }

function load(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') console.error(`[hb-support] ${name}.json unreadable:`, e.message); return fallback; }
}

function save(name, value) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${file(name)}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
  fs.renameSync(tmp, file(name));
}

module.exports = { load, save, DIR };

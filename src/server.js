require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const cron = require('node-cron');
const apiRoutes = require('./routes/api');
const { runCppSnapshot } = require('./routes/api');
const adminRoutes = require('./routes/admin');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
// 25MB ceiling so meeting-notes uploads (PDFs base64-encoded) fit comfortably.
app.use(express.json({ limit: '25mb' }));

// ─── Dashboard auth verification endpoint ──────────────────────────────────
// Used by the login screen to validate the password
app.post('/api/auth/verify', (req, res) => {
  const pw = req.headers['x-dash-password'];
  const expected = process.env.DASH_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!expected) return res.json({ ok: true }); // no password configured = open access
  if (pw === expected) return res.json({ ok: true });
  return res.status(401).json({ error: 'Unauthorized' });
});

// ─── Dashboard API auth middleware ─────────────────────────────────────────
// Protects /api/clients and /api/dashboard/* (NOT /api/admin — has its own auth)
function dashAuth(req, res, next) {
  const expected = process.env.DASH_PASSWORD || process.env.ADMIN_PASSWORD;
  if (!expected) return next(); // no password configured = open access
  const pw = req.headers['x-dash-password'] || req.query.pw;
  if (pw === expected) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Admin routes MUST come first (has its own auth via x-admin-password header)
app.use('/api/admin', adminRoutes);

// All other API routes require dashboard password
app.use('/api', dashAuth, apiRoutes);

// Admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/admin.html'));
});

// Static files AFTER API routes
app.use(express.static(path.join(__dirname, '../public')));

// /dash serves the media dashboard
app.get('/dash', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/dash.html'));
});

// Unknown routes → home
app.get('*', (req, res) => {
  res.redirect('/');
});

// 5am CT daily — pre-warm CPP snapshot so it's ready when Alan opens the menu
cron.schedule('0 5 * * *', () => {
  console.log('[Cron] Running 5am CPP snapshot...');
  runCppSnapshot();
}, { timezone: 'America/Chicago' });

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});

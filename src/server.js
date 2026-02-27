require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

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
  const pw = req.headers['x-dash-password'];
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

// Static files and frontend catch-all AFTER API routes
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Dashboard running on port ${PORT}`);
});

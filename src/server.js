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
// API routes MUST come before static file serving
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
// Admin page - must be before the catch-all
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

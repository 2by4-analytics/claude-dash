/**
 * Admin routes for client management
 * Reads/writes CLIENTS env var via Railway API
 *
 * Required env vars:
 *   RAILWAY_TOKEN       - Railway API token (Account Settings → Tokens)
 *   RAILWAY_PROJECT_ID  - Found in Railway project Settings
 *   RAILWAY_SERVICE_ID  - Found in Railway service Settings
 *   RAILWAY_ENV_ID      - Found in Railway environment Settings (usually "production")
 *   ADMIN_PASSWORD      - Password to access admin UI
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

// ─── Auth middleware ───────────────────────────────────────────────────────────

router.use((req, res, next) => {
  console.log('AUTH CHECK - received:', req.headers['x-admin-password'], 'expected:', process.env.ADMIN_PASSWORD);
  const auth = req.headers['x-admin-password'];
  if (auth !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

router.use((req, res, next) => {
  // Allow GET to /admin (the HTML page) without auth check here — handled client-side
  // All /api/admin/* routes require the header
  const auth = req.headers['x-admin-password'];
  if (auth !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// ─── Railway helpers ───────────────────────────────────────────────────────────

async function railwayQuery(query, variables = {}) {
  const r = await axios.post(
    RAILWAY_API,
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${process.env.RAILWAY_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
  if (r.data.errors) throw new Error(r.data.errors[0].message);
  return r.data.data;
}

async function getCurrentClients() {
  const raw = process.env.CLIENTS || '[]';
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveClientsToRailway(clients) {
  const { RAILWAY_TOKEN, MY_PROJECT_ID, MY_SERVICE_ID, MY_ENV_ID } = process.env;

  if (!RAILWAY_TOKEN || !MY_PROJECT_ID || !MY_SERVICE_ID || !MY_ENV_ID) {
    throw new Error('Missing Railway env vars: RAILWAY_TOKEN, MY_PROJECT_ID, MY_SERVICE_ID, MY_ENV_ID');
  }

  const mutation = `
    mutation UpsertVariables($input: VariableCollectionUpsertInput!) {
      variableCollectionUpsert(input: $input)
    }
  `;

  await railwayQuery(mutation, {
    input: {
      projectId: MY_PROJECT_ID,
      serviceId: MY_SERVICE_ID,
      environmentId: MY_ENV_ID,
      variables: {
        CLIENTS: JSON.stringify(clients),
      },
    },
  });

  // Also update the in-process env so reads are immediately consistent
  process.env.CLIENTS = JSON.stringify(clients);
}

function generateId(name) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug}-${Date.now().toString(36)}`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/admin/clients — list all clients (full config for editing)
router.get('/clients', async (req, res) => {
  try {
    const clients = await getCurrentClients();
    res.json({ clients });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/clients — add a new client
router.post('/clients', async (req, res) => {
  try {
    const clients = await getCurrentClients();
    const { name, cocLoginId, cocPassword, fbAccessToken, adAccounts } = req.body;

    if (!name || !cocLoginId || !cocPassword || !fbAccessToken) {
      return res.status(400).json({ error: 'name, cocLoginId, cocPassword, fbAccessToken are required' });
    }

    const newClient = {
      id: generateId(name),
      name: name.trim(),
      cocLoginId: cocLoginId.trim(),
      cocPassword: cocPassword.trim(),
      fbAccessToken: fbAccessToken.trim(),
      adAccounts: (adAccounts || []).map(a => ({
        fbAdAccountId: a.fbAdAccountId.trim(),
        cocCampaignId: parseInt(a.cocCampaignId),
        cocCampaignName: a.cocCampaignName.trim(),
        ...(a.cppTarget ? { cppTarget: parseFloat(a.cppTarget) } : {}),
      })),
    };

    clients.push(newClient);
    await saveClientsToRailway(clients);
    res.json({ success: true, client: newClient });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/clients/:id — update existing client
router.put('/clients/:id', async (req, res) => {
  try {
    const clients = await getCurrentClients();
    const idx = clients.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });

    const { name, cocLoginId, cocPassword, fbAccessToken, adAccounts } = req.body;

    clients[idx] = {
      ...clients[idx],
      ...(name && { name: name.trim() }),
      ...(cocLoginId && { cocLoginId: cocLoginId.trim() }),
      ...(cocPassword && { cocPassword: cocPassword.trim() }),
      ...(fbAccessToken && { fbAccessToken: fbAccessToken.trim() }),
      ...(adAccounts && {
        adAccounts: adAccounts.map(a => ({
          fbAdAccountId: a.fbAdAccountId.trim(),
          cocCampaignId: parseInt(a.cocCampaignId),
          cocCampaignName: a.cocCampaignName.trim(),
          ...(a.cppTarget ? { cppTarget: parseFloat(a.cppTarget) } : {}),
        })),
      }),
    };

    await saveClientsToRailway(clients);
    res.json({ success: true, client: clients[idx] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/admin/clients/:id — remove a client
router.delete('/clients/:id', async (req, res) => {
  try {
    const clients = await getCurrentClients();
    const idx = clients.findIndex(c => c.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Client not found' });

    const removed = clients.splice(idx, 1)[0];
    await saveClientsToRailway(clients);
    res.json({ success: true, removed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

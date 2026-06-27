/**
 * Loads client configuration from CLIENTS environment variable
 * 
 * Expected format (set as Railway env var):
 * [
 *   {
 *     "id": "client-slug",
 *     "name": "Client Display Name",
 *     "cocLoginId": "...",
 *     "cocPassword": "...",
 *     "fbAccessToken": "...",
 *     "adAccounts": [
 *       { "fbAdAccountId": "act_XXX", "cocCampaignId": 1, "cocCampaignName": "Plant" },
 *       { "fbAdAccountId": "act_YYY", "cocCampaignId": 2, "cocCampaignName": "Faith" }
 *     ]
 *   }
 * ]
 */

const DEFAULT_TIMEZONE = 'America/Chicago';

let _clients = null;

function getClients() {
  if (_clients) return _clients;

  const raw = process.env.CLIENTS;
  if (!raw) {
    console.warn('WARNING: CLIENTS env var not set. Using empty client list.');
    return [];
  }

  try {
    _clients = JSON.parse(raw);
    console.log(`Loaded ${_clients.length} client(s):`, _clients.map(c => c.name).join(', '));
    return _clients;
  } catch (err) {
    console.error('ERROR: Failed to parse CLIENTS env var:', err.message);
    return [];
  }
}

function getClientById(id) {
  return getClients().find(c => c.id === id) || null;
}

function getClientTimezone(client) {
  return client.timezone || DEFAULT_TIMEZONE;
}

function clearClientCache() {
  _clients = null;
}

/**
 * Find CoC creds (loginId/password) for a given API loginId, reused from the
 * existing per-client config so a shared API user's password (e.g.
 * `brianreports-api`) isn't duplicated into separate env vars.
 */
function getCocCredsByLoginId(loginId) {
  for (const c of getClients()) {
    if (c.cocLoginId === loginId && c.cocPassword) {
      return { loginId: c.cocLoginId, password: c.cocPassword };
    }
  }
  return null;
}

module.exports = { getClients, getClientById, getClientTimezone, clearClientCache, getCocCredsByLoginId };

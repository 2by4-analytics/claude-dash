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

module.exports = { getClients, getClientById };

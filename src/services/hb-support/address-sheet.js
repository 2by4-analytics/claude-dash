// Monday sweep of the "HB Bad Addresses — Replied" sheet (Alan 11-19; JV - baking/shipsem).
// Every customer who replied with an address → re-read their order in ShipStation →
// rewrite the sheet (most urgent first; the Notes column is kept by order #) → close
// tracker records whose copy has shipped → email Alan what still needs a label.
const axios = require('axios');
const { google } = require('googleapis');
const address = require('./address');

const SHEET_ID = () => process.env.HB_ADDRESS_SHEET_ID || '1BnXYFQWuxzyZl3qDKd2HqfUL5jyPYwuZ62Gk7QOGMMs';
const SHEET_URL = () => `https://docs.google.com/spreadsheets/d/${SHEET_ID()}/edit`;
const HB = [4905682, 4905795, 4910136];
const TEE_STORE = 4905795; // shirts: Brian ships and fixes these, not Eric
const HEADER = ['Status', 'Order #', 'Customer', 'Email', 'NEW address (from their reply)', 'Original address', 'Reshipped to', 'Ship date', 'Items', 'Notes (kept each sweep)'];
const RANK = { 'NEEDS NEW LABEL': 0, 'CHECK: shipped to a different address': 1, 'Brian (shirt)': 2, 'In ShipStation, not shipped yet': 3, Shipped: 4 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (t = {}) => [t.street1, t.street2, `${t.city}, ${t.state} ${t.postalCode}`].filter((x) => x && String(x).trim()).join(', ');
const newLine = (a) => (a ? [a.street1, a.street2, `${a.city}, ${a.state} ${a.postalCode || a.zip || ''}`.trim()].filter((x) => x && String(x).trim()).join(', ') : '');
// House/unit numbers. Every number they gave must be on the label.
// The ZIP is left out: ShipStation's validation corrects it (Amy Tzall 89123 → 89122).
const nums = (s) => (String(s).toUpperCase().replace(/\b\d{5}(-\d{4})?\s*$/, '').match(/\d+/g) || []);
const sameAddress = (want, got) => { const g = new Set(nums(got)); return nums(want).every((n) => g.has(n)); };

let client = null;
function sheets() {
  if (client) return client;
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  return (client = google.sheets({ version: 'v4', auth }));
}
function ss() {
  const key = process.env.SHIPSTATION_API_KEY, secret = process.env.SHIPSTATION_API_SECRET;
  return axios.create({ baseURL: 'https://ssapi.shipstation.com', timeout: 30000, headers: { Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` } });
}

async function buildRows() {
  const recs = address.allRecords().filter((r) => r.newAddress && !r.twinOf);
  const seen = new Set(); const rows = []; const http = ss();
  for (const r of recs) {
    if (seen.has(r.orderNumber)) continue; seen.add(r.orderNumber);
    const list = ((await http.get('/orders', { params: { orderNumber: r.orderNumber } })).data.orders || []).filter((o) => HB.includes(o.advancedOptions.storeId));
    await sleep(1600); // V1: 40 calls/min
    const orig = list.find((o) => o.orderStatus === 'cancelled') || list[0] || {};
    const live = list.filter((o) => o.orderStatus !== 'cancelled');
    const want = newLine(r.newAddress);
    // Several copies (Courtney Marsell: two shipped): prefer one that matches their address.
    const ok = (o) => sameAddress(want, oneLine(o.shipTo));
    const shipped = live.find((o) => o.orderStatus === 'shipped' && ok(o)) || live.find((o) => o.orderStatus === 'shipped');
    const copy = shipped || live.find(ok) || live[0];
    let status;
    if ((orig.advancedOptions || {}).storeId === TEE_STORE || r.storeId === TEE_STORE) status = shipped ? 'Shipped' : 'Brian (shirt)';
    else if (!copy) status = 'NEEDS NEW LABEL';
    else if (!sameAddress(want, oneLine(copy.shipTo))) status = 'CHECK: shipped to a different address';
    else status = shipped ? 'Shipped' : 'In ShipStation, not shipped yet';
    rows.push({ status, order: r.orderNumber, name: r.shipTo.name, email: r.email, want, orig: oneLine(orig.shipTo || r.shipTo), sentTo: copy ? oneLine(copy.shipTo) : '', shipDate: shipped && shipped.shipDate ? String(shipped.shipDate).slice(0, 10) : '', items: (orig.items || []).map((i) => `${i.quantity}x ${i.name}`).join('; '), trackerStatus: r.status });
  }
  return rows.sort((a, b) => RANK[a.status] - RANK[b.status] || String(b.shipDate).localeCompare(String(a.shipDate)));
}

async function runSweep({ write = true, sendOwner = null, closeOrders = null } = {}) {
  const rows = await buildRows();
  const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), fields: 'sheets.properties' });
  const { title: tab, sheetId } = meta.data.sheets[0].properties;
  const cur = (await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `'${tab}'!A1:Z2000` })).data.values || [];
  const oi = (cur[0] || []).indexOf('Order #'), ni = (cur[0] || []).findIndex((h) => /^Notes/.test(h));
  const notes = {}; if (oi >= 0 && ni >= 0) cur.slice(1).forEach((c) => { if (c[ni]) notes[c[oi]] = c[ni]; });
  // A note with ok/same/fine on a CHECK row = staff signed off (Kitty Graham 11-19: her
  // "710" reply was a typo of the original 170, Alan: "same as original").
  rows.forEach((r) => { if (r.status === 'CHECK: shipped to a different address' && /\b(ok|okay|same|fine|correct)\b/i.test(notes[r.order] || '')) r.status = r.shipDate ? 'Shipped' : 'In ShipStation, not shipped yet'; });
  rows.sort((a, b) => RANK[a.status] - RANK[b.status] || String(b.shipDate).localeCompare(String(a.shipDate)));
  const swept = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago' });
  const values = [[...HEADER, `Swept ${swept}`], ...rows.map((r) => [r.status, r.order, r.name, r.email, r.want, r.orig, r.sentTo, r.shipDate, r.items, notes[r.order] || ''])];
  const action = rows.filter((r) => RANK[r.status] <= 1);
  const toClose = rows.filter((r) => r.status === 'Shipped' && r.trackerStatus !== 'fixed').map((r) => r.order);
  if (write) {
    await sheets().spreadsheets.values.clear({ spreadsheetId: SHEET_ID(), range: `'${tab}'!A1:Z2000` });
    await sheets().spreadsheets.values.update({ spreadsheetId: SHEET_ID(), range: `'${tab}'!A1`, valueInputOption: 'RAW', requestBody: { values } });
    const bg = (start, end, rgb) => ({ repeatCell: { range: { sheetId, startRowIndex: start, endRowIndex: end }, cell: { userEnteredFormat: { backgroundColorStyle: { rgbColor: rgb } } }, fields: 'userEnteredFormat.backgroundColorStyle' } });
    await sheets().spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID(), requestBody: { requests: [bg(1, 2000, { red: 1, green: 1, blue: 1 }), ...(action.length ? [bg(1, 1 + action.length, { red: 1, green: 0.92, blue: 0.8 })] : [])] } });
    if (toClose.length && closeOrders) await closeOrders(toClose, `shipped; closed by the Monday sheet sweep ${swept}`);
    if (sendOwner && action.length) {
      await sendOwner(`[HB-ADDR-SWEEP] ${action.length} replied address${action.length > 1 ? 'es' : ''} still need action`, [
        `Monday sweep of the replied-address sheet: ${SHEET_URL()}`,
        action.map((r, i) => `${i + 1}. ${r.status}: ${r.name} <${r.email}>, order ${r.order}\n   New address: ${r.want}${r.sentTo ? `\n   Went to: ${r.sentTo}` : ''}`).join('\n\n'),
        `${rows.length - action.length} other rows are shipped, in ShipStation, or with Brian.${toClose.length ? ` Closed ${toClose.length} shipped record${toClose.length > 1 ? 's' : ''} in the tracker.` : ''}`,
      ].join('\n\n'));
    }
  }
  const counts = {}; rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; });
  return { rows: rows.length, counts, closed: write ? toClose : [], wouldClose: write ? [] : toClose, action: action.map((r) => `${r.status}: ${r.order} ${r.name}`) };
}

module.exports = { runSweep, _sameAddress: sameAddress };

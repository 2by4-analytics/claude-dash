// "The Happy Bakers — Ledger" Google Sheet: the same sheet the HB dashboard reads.
// The inventory agent reads Settings / Items / Inventory / Offers / Box Calendar and
// writes Inventory rows, Items unit costs, Settings values and Box Calendar months.
// dash-reader (GOOGLE_SERVICE_ACCOUNT_JSON) is an Editor on it.
const { google } = require('googleapis');

const SHEET_ID = () => process.env.HB_LEDGER_SHEET_ID || '1lW7GijvbiZoopL1fpN0KCGgvxyhSGBevo6uNID5g1g0';
const CALENDAR_TAB = 'Box Calendar';
const CALENDAR_HEADER = ['month', 'sku', 'notes'];

let sheetsClient = null;
function sheets() {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing');
  const auth = new google.auth.GoogleAuth({ credentials: JSON.parse(raw), scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

const blank = (v) => v === undefined || v === null || String(v).trim() === '';
const num = (v) => (blank(v) || Number.isNaN(Number(v)) ? null : Number(v));

// Header row → objects, keyed by header name (columns can move).
function rowsOf(values) {
  const [head = [], ...rows] = values || [];
  const keys = head.map((h) => String(h).trim());
  return rows.filter((r) => r.some((c) => !blank(c)))
    .map((r, i) => ({ _row: i + 2, ...Object.fromEntries(keys.map((k, j) => [k, blank(r[j]) ? null : r[j]])) }));
}

// Accepts 2026-10-02, 10/2/2026 or 10/2/26 → YYYY-MM-DD (or null).
function isoDate(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

// "STK-MAIN*3 + STK-OTHER" → [{sku:'STK-MAIN',qty:3},{sku:'STK-OTHER',qty:1}] (same syntax as the HB dashboard).
function parseComponents(s) {
  if (blank(s) || /^(none|-|0)$/i.test(String(s).trim())) return [];
  return String(s).split('+').map((p) => p.trim()).filter(Boolean).map((p) => {
    const m = p.match(/^([A-Za-z0-9_-]+)\s*(?:[*x×]\s*(\d+))?$/);
    return m ? { sku: m[1].toUpperCase(), qty: m[2] ? Number(m[2]) : 1 } : null;
  }).filter(Boolean);
}

// "2026-11", "Nov 2026", "11/2026", a date in that month → "2026-11".
function monthKey(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})\/(?:\d{1,2}\/)?(\d{4})$/);
  if (m) return `${m[2]}-${m[1].padStart(2, '0')}`;
  const d = new Date(`1 ${s}`);
  return Number.isNaN(d.getTime()) ? null : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function read() {
  const names = ['Settings', 'Items', 'Inventory', 'Offers', CALENDAR_TAB];
  const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), fields: 'sheets.properties.title' });
  const have = new Set(meta.data.sheets.map((s) => s.properties.title));
  const wanted = names.filter((n) => have.has(n));
  const r = await sheets().spreadsheets.values.batchGet({
    spreadsheetId: SHEET_ID(), ranges: wanted.map((n) => `'${n}'!A1:Z3000`), valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const tab = Object.fromEntries(wanted.map((n, i) => [n, r.data.valueRanges[i].values || []]));

  const settings = Object.fromEntries(rowsOf(tab.Settings).map((r) => [String(r.key).trim(), r.value]));
  const items = Object.fromEntries(rowsOf(tab.Items).filter((r) => r.sku).map((r) => [String(r.sku).trim().toUpperCase(), { sku: String(r.sku).trim().toUpperCase(), name: r.name || '', unitCost: num(r.unit_cost), row: r._row }]));
  const inventory = rowsOf(tab.Inventory).filter((r) => r.sku && num(r.qty) != null)
    .map((r) => ({ date: isoDate(r.date), sku: String(r.sku).trim().toUpperCase(), qty: num(r.qty), unitCost: num(r.unit_cost), paidBy: r.paid_by, location: r.location, notes: r.notes || '' }));
  const offers = rowsOf(tab.Offers).filter((r) => num(r.coc_product_id) != null)
    .map((r) => ({ productId: num(r.coc_product_id), name: r.offer || '', first: parseComponents(r.ships_first), role: r.role || '' }));
  const calendar = rowsOf(tab[CALENDAR_TAB]).map((r) => ({ month: monthKey(r.month), sku: blank(r.sku) ? null : String(r.sku).trim().toUpperCase(), notes: r.notes || '', row: r._row }))
    .filter((r) => r.month).sort((a, b) => a.month.localeCompare(b.month));
  return { settings, items, inventory, offers, calendar, hasCalendarTab: have.has(CALENDAR_TAB) };
}

async function append(tabName, row) {
  await sheets().spreadsheets.values.append({ spreadsheetId: SHEET_ID(), range: `'${tabName}'!A1`, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] } });
}

async function setCell(range, value) {
  await sheets().spreadsheets.values.update({ spreadsheetId: SHEET_ID(), range, valueInputOption: 'USER_ENTERED', requestBody: { values: [[value]] } });
}

// Column letter of a header in a tab (headers can move).
async function column(tabName, header) {
  const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: `'${tabName}'!1:1` });
  const i = (r.data.values?.[0] || []).findIndex((h) => String(h).trim() === header);
  if (i < 0) throw new Error(`${tabName} has no "${header}" column`);
  return String.fromCharCode(65 + i);
}

async function addPurchase({ date, sku, qty, unitCost, paidBy, location, notes }) {
  await append('Inventory', [date, sku, qty, unitCost, paidBy, location, notes]);
}

async function setItemCost(row, unitCost) {
  await setCell(`'Items'!${await column('Items', 'unit_cost')}${row}`, unitCost);
}

async function addItem({ sku, name, unitCost, notes }) {
  await append('Items', [sku, name, unitCost ?? '', 'box', '', '', notes || '']);
}

async function setSetting(key, value, notes) {
  const r = await sheets().spreadsheets.values.get({ spreadsheetId: SHEET_ID(), range: "'Settings'!A1:A200" });
  const i = (r.data.values || []).findIndex((x) => String(x[0] || '').trim() === key);
  if (i >= 0) await setCell(`'Settings'!B${i + 1}`, value);
  else await append('Settings', [key, value, notes || '']);
}

async function ensureCalendarTab(seed) {
  const meta = await sheets().spreadsheets.get({ spreadsheetId: SHEET_ID(), fields: 'sheets.properties.title' });
  if (meta.data.sheets.some((s) => s.properties.title === CALENDAR_TAB)) return false;
  await sheets().spreadsheets.batchUpdate({ spreadsheetId: SHEET_ID(), requestBody: { requests: [{ addSheet: { properties: { title: CALENDAR_TAB } } }] } });
  await sheets().spreadsheets.values.update({ spreadsheetId: SHEET_ID(), range: `'${CALENDAR_TAB}'!A1`, valueInputOption: 'RAW', requestBody: { values: [CALENDAR_HEADER, ...seed] } });
  return true;
}

async function setMonth(month, sku, notes) {
  const { calendar } = await read();
  const hit = calendar.find((c) => c.month === month);
  if (hit) {
    await setCell(`'${CALENDAR_TAB}'!B${hit.row}`, sku || '');
    if (notes) await setCell(`'${CALENDAR_TAB}'!C${hit.row}`, notes);
  } else await append(CALENDAR_TAB, [month, sku || '', notes || '']);
}

module.exports = { read, addPurchase, setItemCost, addItem, setSetting, setMonth, ensureCalendarTab, isoDate, monthKey, CALENDAR_TAB };

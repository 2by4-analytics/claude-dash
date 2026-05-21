/**
 * Google Calendar + Drive integration for the launchpad TODAY block.
 *
 * Auth: GOOGLE_SERVICE_ACCOUNT_JSON env var (full service-account JSON as a
 * string). The calendar must be shared with the SA email, and both client
 * parent folders (STICKER_CLIENTS_FOLDER_ID, SHED_CLIENTS_FOLDER_ID) must
 * grant the SA **Editor** access (was Reader; writes need Editor).
 * CALENDAR_ID defaults to 'primary' (only works with domain-wide delegation
 * — for a SA-only setup, set GOOGLE_CALENDAR_ID to the calendar's address,
 * e.g. alan@2by4llc.com).
 */

const { google } = require('googleapis');
const { Readable } = require('stream');

const TZ = 'America/Chicago';
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || 'primary';
const STICKER_FOLDER_ID = process.env.STICKER_CLIENTS_FOLDER_ID;
const SHED_FOLDER_ID = process.env.SHED_CLIENTS_FOLDER_ID;
const TEAM_FOLDER_ID = process.env.TEAM_FOLDER_ID;

const CALENDAR_TTL_MS = 60 * 1000;            // 60s
const TASKS_TTL_MS    = 10 * 60 * 1000;       // 10m
const FOLDERS_TTL_MS  = 10 * 60 * 1000;       // shared with tasks

let _auth = null;
let _calendar = null;
let _drive = null;

function getAuth() {
  if (_auth) return _auth;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is not set');
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + e.message); }
  _auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: [
      'https://www.googleapis.com/auth/calendar.readonly',
      // Full drive scope — we mutate existing CLAUDE.md files (toggle/add tasks)
      // and create new files under client folders (uploaded meeting recaps).
      'https://www.googleapis.com/auth/drive',
    ],
  });
  return _auth;
}

function calendarApi() {
  if (!_calendar) _calendar = google.calendar({ version: 'v3', auth: getAuth() });
  return _calendar;
}

function driveApi() {
  if (!_drive) _drive = google.drive({ version: 'v3', auth: getAuth() });
  return _drive;
}

// ─── Date helpers (Central Time) ──────────────────────────────────────────────

function ctOffsetForDate(d) {
  // Returns "-05:00" (CDT) or "-06:00" (CST) for the given UTC instant.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    timeZoneName: 'shortOffset',
  }).formatToParts(d);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-6';
  const m = tz.match(/GMT([+-])(\d+)/);
  if (!m) return '-06:00';
  return `${m[1]}${String(m[2]).padStart(2, '0')}:00`;
}

function todayInCt() {
  // Returns YYYY-MM-DD for "today" in Central Time, plus the day/month/year ints.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  return {
    dateStr: `${map.year}-${map.month}-${map.day}`,
    year: parseInt(map.year, 10),
    month: parseInt(map.month, 10),
    day: parseInt(map.day, 10),
  };
}

function todayBoundsInCt() {
  const t = todayInCt();
  const offset = ctOffsetForDate(new Date());
  return {
    dateStr: t.dateStr,
    timeMin: `${t.dateStr}T00:00:00${offset}`,
    timeMax: `${t.dateStr}T23:59:59${offset}`,
  };
}

// Day-month → full Date with year inferred per spec:
// - month <  current month   → next year
// - month >  current month+6 → last year
// - else                     → this year
function inferDueDate(day, month) {
  const t = todayInCt();
  let year = t.year;
  if (month < t.month) year = t.year + 1;
  else if (month > t.month + 6) year = t.year - 1;
  return { year, month, day }; // calendar date in CT
}

function ymdInCt(date) {
  return `${date.year}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

function compareYmd(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  if (a.month !== b.month) return a.month - b.month;
  return a.day - b.day;
}

// Signed integer days from `b` to `a`. Anchored to UTC noon so DST shifts can't
// flip the result. Inputs are the {year,month,day} objects produced by
// `inferDueDate` / `todayInCt`.
function daysBetweenYmd(a, b) {
  const noon = (d) => Date.UTC(d.year, d.month - 1, d.day, 12);
  return Math.round((noon(a) - noon(b)) / 86400000);
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

let calendarCache = { data: null, ts: 0 };

async function getTodayMeetings() {
  const now = Date.now();
  if (calendarCache.data && (now - calendarCache.ts) < CALENDAR_TTL_MS) {
    return calendarCache.data;
  }

  const { timeMin, timeMax } = todayBoundsInCt();
  const cal = calendarApi();

  const res = await cal.events.list({
    calendarId: CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: 'startTime',
    timeZone: TZ,
    maxResults: 50,
  });

  // Snapshot of folder names so we can match the title against them.
  // If folders aren't configured, we still return meetings (just no client tag).
  let folderNames = [];
  try {
    const folders = await getClientFolders();
    folderNames = folders.map(f => f.name);
  } catch { /* ignore — meetings still useful without client tagging */ }

  const meetings = (res.data.items || []).map(ev => {
    const title = ev.summary || '(no title)';
    const start = ev.start?.dateTime || ev.start?.date || null;
    const end   = ev.end?.dateTime   || ev.end?.date   || null;
    const attendees = (ev.attendees || []).map(a => a.email).filter(Boolean);
    const hangoutLink = ev.hangoutLink || ev.conferenceData?.entryPoints?.find(e => e.entryPointType === 'video')?.uri || null;
    const client = matchClient(title, folderNames);
    return { start, end, title, attendees, hangoutLink, client };
  });

  calendarCache = { data: meetings, ts: now };
  return meetings;
}

function matchClient(title, folderNames) {
  if (!title || !folderNames.length) return null;
  const lower = title.toLowerCase();
  // Pick the longest substring match (most specific).
  let best = null;
  for (const name of folderNames) {
    if (!name) continue;
    if (lower.includes(name.toLowerCase())) {
      if (!best || name.length > best.length) best = name;
    }
  }
  return best;
}

// ─── Drive: client folders + tasks ────────────────────────────────────────────

let foldersCache = { data: null, ts: 0 };
let tasksCache   = { data: null, asOf: null, ts: 0 };

async function getClientFolders() {
  const now = Date.now();
  if (foldersCache.data && (now - foldersCache.ts) < FOLDERS_TTL_MS) {
    return foldersCache.data;
  }
  const drive = driveApi();
  const parents = [
    { id: STICKER_FOLDER_ID, type: 'sticker' },
    { id: SHED_FOLDER_ID, type: 'shed' },
    { id: TEAM_FOLDER_ID, type: 'team' },
  ].filter(p => p.id);
  if (!parents.length) {
    throw new Error('STICKER_CLIENTS_FOLDER_ID, SHED_CLIENTS_FOLDER_ID, and/or TEAM_FOLDER_ID env vars not set');
  }

  const all = [];
  for (const parent of parents) {
    const res = await drive.files.list({
      q: `'${parent.id}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 200,
    });
    for (const f of (res.data.files || [])) {
      all.push({ id: f.id, name: f.name, type: parent.type });
    }
  }

  foldersCache = { data: all, ts: now };
  return all;
}

async function findClaudeMd(folderId) {
  const drive = driveApi();
  // Drive's `=` operator is case-sensitive; `contains` narrows the result set,
  // then we match case-insensitively client-side so claude.md / Claude.md /
  // CLAUDE.md all hit.
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false and name contains 'CLAUDE'`,
    fields: 'files(id, name, mimeType)',
    pageSize: 50,
  });
  return (res.data.files || []).find(f => /^claude\.md$/i.test(f.name)) || null;
}

async function fetchClaudeMd(folderId) {
  const file = await findClaudeMd(folderId);
  if (!file) return null;
  return fetchFileText(file);
}

async function fetchFileText(file) {
  const drive = driveApi();
  if (file.mimeType === 'application/vnd.google-apps.document') {
    const r = await drive.files.export({ fileId: file.id, mimeType: 'text/plain' }, { responseType: 'text' });
    return typeof r.data === 'string' ? r.data : String(r.data);
  }
  const r = await drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'text' });
  return typeof r.data === 'string' ? r.data : String(r.data);
}

// ─── Drive: write helpers ─────────────────────────────────────────────────────

function bufferToStream(buf) {
  const s = new Readable();
  s.push(buf);
  s.push(null);
  return s;
}

// Locate a client folder by display name (matches our cached folders list).
async function findClientFolderByName(name) {
  const folders = await getClientFolders();
  return folders.find(f => f.name.toLowerCase() === String(name || '').toLowerCase()) || null;
}

// Mutate an existing CLAUDE.md. Throws if it's a Google Doc — we only round-trip
// plain markdown to avoid clobbering Doc formatting on export-then-import.
async function writeClaudeMdContent(folderId, newContent) {
  const file = await findClaudeMd(folderId);
  if (!file) throw new Error(`No CLAUDE.md in folder ${folderId}`);
  if (file.mimeType === 'application/vnd.google-apps.document') {
    throw new Error('CLAUDE.md is a Google Doc — convert to plain .md before editing from the Launchpad');
  }
  const drive = driveApi();
  await drive.files.update({
    fileId: file.id,
    media: { mimeType: 'text/markdown', body: newContent },
  });
  invalidateTasksCache();
  return { id: file.id, name: file.name };
}

// Find a child folder by name; create it if missing. Used to lazy-make a
// `meetings/` subfolder under each client.
async function ensureSubfolder(parentId, name) {
  const drive = driveApi();
  const safe = name.replace(/'/g, "\\'");
  const res = await drive.files.list({
    q: `'${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and name = '${safe}'`,
    fields: 'files(id, name)',
    pageSize: 1,
  });
  if (res.data.files && res.data.files.length) return res.data.files[0];
  const created = await drive.files.create({
    requestBody: { name, parents: [parentId], mimeType: 'application/vnd.google-apps.folder' },
    fields: 'id, name',
  });
  return created.data;
}

// Create a new file (any mime) inside `parentId`. `body` may be a Buffer or string.
async function createFileInFolder(parentId, name, mimeType, body) {
  const drive = driveApi();
  const stream = Buffer.isBuffer(body) ? bufferToStream(body) : body;
  const created = await drive.files.create({
    requestBody: { name, parents: [parentId], mimeType },
    media: { mimeType, body: stream },
    fields: 'id, name, webViewLink',
  });
  return created.data;
}

function invalidateTasksCache() {
  tasksCache = { data: null, asOf: null, ts: 0 };
}

// ─── Task parsing ─────────────────────────────────────────────────────────────

const CHECKBOX_RE = /^\s*[-*]\s*\[([ xX])\]\s*(.+?)\s*$/;
const DUE_RE = /[—–-]\s*due\s+(\d{1,2})-(\d{1,2})\b/i;
const TAG_RE = /(^|\s)#([\w-]+)/g;

function parseTaskLine(rawLine, client) {
  const m = rawLine.match(CHECKBOX_RE);
  if (!m) return null;
  const completed = m[1].toLowerCase() === 'x';
  let body = m[2];

  let urgent = false;
  if (body.startsWith('!!')) {
    urgent = true;
    body = body.slice(2).trim();
  }

  const tags = [];
  body = body.replace(TAG_RE, (_, lead, tag) => {
    tags.push(tag);
    return lead;
  }).replace(/\s+/g, ' ').trim();

  let dueDate = null;
  const dm = body.match(DUE_RE);
  if (dm) {
    const day = parseInt(dm[1], 10);
    const month = parseInt(dm[2], 10);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      dueDate = inferDueDate(day, month);
    }
    body = body.replace(dm[0], '').trim();
  }

  // Trim any trailing/leading dashes left behind
  body = body.replace(/[—–-]\s*$/, '').replace(/^\s*[—–-]\s*/, '').trim();

  let isOverdue = false, isDueToday = false, isDueSoon = false;
  if (dueDate) {
    const today = todayInCt();
    const diff = daysBetweenYmd(dueDate, today);
    isOverdue  = diff < 0;
    isDueToday = diff === 0;
    isDueSoon  = diff >= 1 && diff <= 2;
  }

  return {
    client,
    line: body,
    raw: rawLine,
    completed,
    urgent,
    tags,
    dueDate: dueDate ? ymdInCt(dueDate) : null,
    isOverdue,
    isDueToday,
    isDueSoon,
  };
}

// Accept any of these as a task-bearing section heading.
const TASK_HEADING_RE = /^(tasks|open items|todo|to do|action items|to-do)\s*$/i;

function parseTasksSection(content, client) {
  if (!content) return [];
  const lines = content.split(/\r?\n/);
  const out = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      inSection = TASK_HEADING_RE.test(heading[1]);
      continue;
    }
    if (!inSection) continue;
    const t = parseTaskLine(line, client);
    if (t && !t.completed) out.push(t);
  }
  return out;
}

// ─── Tasks (assembled) ────────────────────────────────────────────────────────

async function getOpenTasks() {
  const now = Date.now();
  if (tasksCache.data && (now - tasksCache.ts) < TASKS_TTL_MS) {
    return { tasks: tasksCache.data, asOf: tasksCache.asOf };
  }

  const folders = await getClientFolders();
  const tasks = [];

  // Sequential to keep Drive API quota happy on a small folder list.
  for (const folder of folders) {
    let content;
    try {
      content = await fetchClaudeMd(folder.id);
    } catch (e) {
      // Per spec: any miss invalidates — surface the error so caller doesn't
      // get a partial list cached.
      throw new Error(`Drive read failed for "${folder.name}": ${e.message}`);
    }
    if (!content) continue;
    const parsed = parseTasksSection(content, folder.name);
    for (const t of parsed) {
      t.clientType = folder.type; // 'sticker' | 'shed' — for grouping in UI
      tasks.push(t);
    }
  }

  const asOf = new Date().toISOString();
  tasksCache = { data: tasks, asOf, ts: now };
  return { tasks, asOf };
}

// ─── Debug helper ─────────────────────────────────────────────────────────────

// Pull the raw lines under a recognized task heading — for diagnosing why
// parseTasksSection returned 0 (heading wrong, no checkboxes, all completed, etc).
function extractTaskSectionLines(content) {
  if (!content) return null;
  const lines = content.split(/\r?\n/);
  const sections = {};
  let current = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      current = TASK_HEADING_RE.test(heading[1]) ? heading[1].trim() : null;
      if (current) sections[current] = [];
      continue;
    }
    if (current) sections[current].push(line);
  }
  return Object.keys(sections).length ? sections : null;
}

async function debugSnapshot() {
  const out = {
    env: {
      GOOGLE_SERVICE_ACCOUNT_JSON: !!process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
      GOOGLE_CALENDAR_ID: CALENDAR_ID,
      STICKER_CLIENTS_FOLDER_ID: STICKER_FOLDER_ID || null,
      SHED_CLIENTS_FOLDER_ID: SHED_FOLDER_ID || null,
      TEAM_FOLDER_ID: TEAM_FOLDER_ID || null,
    },
    serviceAccountEmail: null,
    calendar: {},
    folders: [],
  };

  try {
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (raw) out.serviceAccountEmail = JSON.parse(raw).client_email || null;
  } catch { /* ignore */ }

  // ── Calendar probe ─────────────────────────────────────────────
  try {
    const cal = calendarApi();
    out.calendar.configuredId = CALENDAR_ID;

    // 1) Can we read the calendar's metadata?
    try {
      const meta = await cal.calendars.get({ calendarId: CALENDAR_ID });
      out.calendar.metadata = { id: meta.data.id, summary: meta.data.summary, timeZone: meta.data.timeZone };
    } catch (e) {
      out.calendar.metadataError = e.errors?.[0]?.message || e.message;
    }

    // 2) Which calendars does the SA actually have access to?
    try {
      const list = await cal.calendarList.list({ maxResults: 30 });
      out.calendar.accessibleCalendars = (list.data.items || []).map(c => ({ id: c.id, summary: c.summary, accessRole: c.accessRole }));
    } catch (e) {
      out.calendar.calendarListError = e.errors?.[0]?.message || e.message;
    }

    // 3) Today's events (mirrors the real route)
    const { timeMin, timeMax } = todayBoundsInCt();
    out.calendar.window = { timeMin, timeMax };
    try {
      const ev = await cal.events.list({
        calendarId: CALENDAR_ID, timeMin, timeMax,
        singleEvents: true, orderBy: 'startTime', timeZone: TZ, maxResults: 25,
      });
      out.calendar.eventCount = (ev.data.items || []).length;
      out.calendar.eventTitles = (ev.data.items || []).map(e => e.summary || '(no title)');
    } catch (e) {
      out.calendar.eventsError = e.errors?.[0]?.message || e.message;
    }
  } catch (e) {
    out.calendar.fatalError = e.message;
  }

  // ── Drive / tasks probe ────────────────────────────────────────
  let folders = [];
  try {
    folders = await getClientFolders();
  } catch (e) {
    out.foldersError = e.message;
    return out;
  }

  const drive = driveApi();
  for (const folder of folders) {
    const entry = { id: folder.id, name: folder.name, type: folder.type };
    try {
      const res = await drive.files.list({
        q: `'${folder.id}' in parents and trashed = false and name contains 'CLAUDE'`,
        fields: 'files(id, name, mimeType)',
        pageSize: 50,
      });
      const matches = (res.data.files || []).map(f => ({ name: f.name, mimeType: f.mimeType, id: f.id }));
      entry.candidates = matches;
      const file = matches.find(f => /^claude\.md$/i.test(f.name));
      if (!file) {
        entry.claudeMd = null;
      } else {
        entry.claudeMd = { id: file.id, name: file.name, mimeType: file.mimeType };
        try {
          const content = await fetchClaudeMd(folder.id);
          entry.contentLength = content ? content.length : 0;
          const headings = (content || '').split(/\r?\n/).filter(l => /^##\s/.test(l)).map(l => l.trim());
          entry.h2Headings = headings;
          entry.taskSections = extractTaskSectionLines(content || '');
          const tasks = parseTasksSection(content || '', folder.name);
          entry.openTaskCount = tasks.length;
          entry.firstTask = tasks[0] || null;
        } catch (e) {
          entry.readError = e.message;
        }
      }
    } catch (e) {
      entry.listError = e.message;
    }
    out.folders.push(entry);
  }

  return out;
}

module.exports = {
  getTodayMeetings,
  getOpenTasks,
  getClientFolders,
  debugSnapshot,
  // Write helpers
  findClientFolderByName,
  fetchClaudeMd,
  writeClaudeMdContent,
  ensureSubfolder,
  createFileInFolder,
  invalidateTasksCache,
};

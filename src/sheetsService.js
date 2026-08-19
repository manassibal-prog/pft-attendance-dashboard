const { google } = require('googleapis');
const { getTodayRosterCode } = require('./rosterLookup');
const { computeDayState, deriveSummary } = require('./dayState');
const { toDateOnlyString, toDateTimeString, parseDateTimeString, ymd, weekdayInZone } = require('./dateFmt');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

const SHEET_EMPLOYEE = 'Employee Master';
const SHEET_SETTINGS = 'Settings';
const SHEET_LOG = 'Daily Attendance Log';
const SHEET_EVENTS = 'Punch Events Log';
const SHEET_ROSTER = 'Roster';
const SHEET_SUMMARY = 'Monthly Summary';

let sheetsClient = null;

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');
  let creds;
  try {
    // Accept either raw JSON or base64-encoded JSON (base64 avoids newline
    // escaping headaches when pasting the private key into an env var).
    creds = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON or base64-JSON: ' + e.message);
  }
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function getValues(range) {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  return res.data.values || [];
}

// ---------- Settings ----------
async function getSettings() {
  const rows = await getValues(`'${SHEET_SETTINGS}'!A2:B10`);
  const map = {};
  rows.forEach((r) => { if (r[0]) map[r[0]] = r[1]; });
  return {
    officeName: map['Office Name'] || 'Office',
    lat: Number(map['Office Latitude']),
    lng: Number(map['Office Longitude']),
    radius: Number(map['Allowed Radius (meters)']) || 200,
    grace: Number(map['Late Grace Period (minutes)']) || 15,
  };
}

// ---------- Employee Master ----------
async function findEmployeeByEmail(email) {
  const rows = await getValues(`'${SHEET_EMPLOYEE}'!A2:I1000`);
  const target = String(email).trim().toLowerCase();
  for (const r of rows) {
    if (!r[2]) continue;
    if (String(r[2]).trim().toLowerCase() === target) {
      return {
        empId: r[0], name: r[1], email: r[2], department: r[3], designation: r[4],
        shiftStart: r[5], shiftEnd: r[6], weeklyOff: r[7], status: r[8],
      };
    }
  }
  return null;
}

async function listActiveEmployees() {
  const rows = await getValues(`'${SHEET_EMPLOYEE}'!A2:I1000`);
  return rows
    .filter((r) => r[0] && String(r[8] || '').trim().toLowerCase() === 'active')
    .map((r) => ({
      empId: r[0], name: r[1], email: r[2], department: r[3], designation: r[4],
      shiftStart: r[5], shiftEnd: r[6], weeklyOff: r[7], status: r[8],
    }));
}

// ---------- Roster (read-only) ----------
async function getRosterGrid() {
  return getValues(`'${SHEET_ROSTER}'!A1:AZ400`);
}

// Fallback: Roster hasn't been filled in for today yet — use the static
// weekly-off day from Employee Master so at least WO days aren't blank.
function rosterCodeFromGrid(grid, employeeName, now, weeklyOffFallback) {
  const code = getTodayRosterCode(grid, employeeName, now);
  if (code) return code;
  if (weeklyOffFallback && weekdayInZone(now) === weeklyOffFallback) return 'WO';
  return '';
}

// Single-employee convenience wrapper (fetches Roster fresh each call — fine
// for the one-off lookups in /api/me, /api/day-state, /api/punch). Callers
// handling many employees at once (e.g. /api/team-status) should call
// getRosterGrid() once and use rosterCodeFromGrid directly instead, to avoid
// re-fetching the whole sheet per employee.
async function getTodayRosterCodeFor(employeeName, now, weeklyOffFallback) {
  const grid = await getRosterGrid();
  return rosterCodeFromGrid(grid, employeeName, now, weeklyOffFallback);
}

// ---------- Punch Events Log ----------
async function getTodayEvents(empId, now) {
  const rows = await getValues(`'${SHEET_EVENTS}'!A2:J20000`);
  const todayStr = ymd(now);
  const out = [];
  for (const r of rows) {
    if (!r[0]) continue;
    if (String(r[1]) !== String(empId)) continue;
    if (r[9] !== 'Success') continue;
    const ts = parseDateTimeString(r[0]);
    if (!ts || ymd(ts) !== todayStr) continue;
    out.push({ type: r[4], timestamp: ts });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

// row: [Date, empId, name, email, eventType, lat, lng, distance, withinGeofence, result]
async function appendEvent(now, empId, name, email, eventType, lat, lng, distance, withinGeofence, result) {
  const sheets = getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `'${SHEET_EVENTS}'!A:J`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [[toDateTimeString(now), empId, name, email, eventType, lat ?? '', lng ?? '', distance ?? '', withinGeofence, result]] },
  });
}

// ---------- Daily Attendance Log ----------
async function findTodayLogRow(empId, now) {
  const rows = await getValues(`'${SHEET_LOG}'!A2:N20000`);
  const todayStr = ymd(now);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r[0]) continue;
    const rowDate = parseDateTimeString(r[0]);
    if (rowDate && ymd(rowDate) === todayStr && String(r[1]) === String(empId)) {
      return { rowNumber: i + 2, values: r }; // +2: header row + 1-index
    }
  }
  return null;
}

async function upsertDailySummary(emp, now, state, rosterCode, settings) {
  const sheets = getSheetsClient();
  const summary = deriveSummary(state, rosterCode, emp.shiftStart, settings.grace);
  const existing = await findTodayLogRow(emp.empId, now);

  const punchInText = summary.punchIn ? toDateTimeString(summary.punchIn) : '';
  const punchOutText = summary.punchOut ? toDateTimeString(summary.punchOut) : '';

  if (!existing) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_LOG}'!A:N`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: {
        values: [[
          toDateOnlyString(now), emp.empId, emp.name, emp.email,
          punchInText, punchOutText,
          summary.lunch, summary.tea, summary.bio, summary.totalBreak,
          summary.gross, summary.net, summary.lateBy, summary.status,
        ]],
      },
    });
  } else {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${SHEET_LOG}'!E${existing.rowNumber}:N${existing.rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          punchInText, punchOutText,
          summary.lunch, summary.tea, summary.bio, summary.totalBreak,
          summary.gross, summary.net, summary.lateBy, summary.status,
        ]],
      },
    });
  }
  return summary;
}

async function getTodayLogRows(now) {
  const rows = await getValues(`'${SHEET_LOG}'!A2:N20000`);
  const todayStr = ymd(now);
  const map = {};
  for (const r of rows) {
    if (!r[0]) continue;
    const rowDate = parseDateTimeString(r[0]);
    if (rowDate && ymd(rowDate) === todayStr) {
      map[String(r[1])] = {
        punchIn: r[4] ? parseDateTimeString(r[4]) : null,
        punchOut: r[5] ? parseDateTimeString(r[5]) : null,
        lunch: r[6] || 0, tea: r[7] || 0, bio: r[8] || 0,
        netHours: r[11] || '', lateBy: r[12] || 0, status: r[13] || '',
      };
    }
  }
  return map;
}

module.exports = {
  SHEET_SUMMARY,
  getSheetsClient,
  ymd,
  getSettings,
  findEmployeeByEmail,
  listActiveEmployees,
  getRosterGrid,
  rosterCodeFromGrid,
  getTodayRosterCodeFor,
  getTodayEvents,
  appendEvent,
  upsertDailySummary,
  getTodayLogRows,
};

/**
 * Team Punch In/Out + Breaks + Team Status — Google Apps Script backend
 * Bind this script to the team's Google Sheet (Extensions > Apps Script).
 * Identity comes from Session.getActiveUser().getEmail() — the Google
 * account the visitor is signed in as — never from anything the browser
 * sends, so it cannot be spoofed by editing the page.
 *
 * Roster (the admin-maintained planning tab) is read-only from here: it's
 * used to skip the geofence on WFH days, and as the live Status shown
 * before someone punches in (WO / Leave / Holiday / UP = unpaid leave).
 */

const SHEET_EMPLOYEE = 'Employee Master';
const SHEET_SETTINGS = 'Settings';
const SHEET_LOG = 'Daily Attendance Log';
const SHEET_EVENTS = 'Punch Events Log';
const SHEET_ROSTER = 'Roster';
const SHEET_SUMMARY = 'Monthly Summary';
const GRACE_MINUTES_DEFAULT = 15;

function doGet(e) {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('PFT Team Attendance')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---------- One-time setup ----------
function initializeSheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  if (!ss.getSheetByName(SHEET_EMPLOYEE)) {
    const sh = ss.insertSheet(SHEET_EMPLOYEE);
    sh.appendRow(['Emp ID', 'Employee Name', 'Official Email', 'Department', 'Designation',
                  'Shift Start', 'Shift End', 'Weekly Off Day', 'Status']);
    sh.getRange(1, 1, 1, 9).setFontWeight('bold');
    sh.setFrozenRows(1);
  }

  if (!ss.getSheetByName(SHEET_SETTINGS)) {
    const sh = ss.insertSheet(SHEET_SETTINGS);
    sh.appendRow(['Setting', 'Value', 'Notes']);
    sh.appendRow(['Office Name', 'Head Office', 'Shown to employees in the app']);
    sh.appendRow(['Office Latitude', 0, 'REQUIRED before going live.']);
    sh.appendRow(['Office Longitude', 0, 'REQUIRED before going live.']);
    sh.appendRow(['Allowed Radius (meters)', 200, 'Punch/break actions are blocked outside this distance from the office point (skipped entirely on Roster WFH days).']);
    sh.appendRow(['Late Grace Period (minutes)', GRACE_MINUTES_DEFAULT, 'Minutes after shift start before a punch-in counts as Late.']);
    sh.getRange(1, 1, 1, 3).setFontWeight('bold');
  }

  if (!ss.getSheetByName(SHEET_LOG)) {
    const sh = ss.insertSheet(SHEET_LOG);
    sh.appendRow(['Date', 'Emp ID', 'Employee Name', 'Email', 'Punch In', 'Punch Out',
                  'Lunch Break (min)', 'Tea Break (min)', 'Bio Break (min)', 'Total Break (min)',
                  'Gross Hours', 'Net Working Hours', 'Late By (min)', 'Status']);
    sh.getRange(1, 1, 1, 14).setFontWeight('bold');
    sh.setFrozenRows(1);
  }

  if (!ss.getSheetByName(SHEET_EVENTS)) {
    const sh = ss.insertSheet(SHEET_EVENTS);
    sh.appendRow(['Timestamp', 'Emp ID', 'Employee Name', 'Email', 'Event Type', 'Latitude', 'Longitude',
                  'Distance From Office (m)', 'Within Geofence', 'Result']);
    sh.getRange(1, 1, 1, 10).setFontWeight('bold');
    sh.setFrozenRows(1);
  }

  if (!ss.getSheetByName(SHEET_SUMMARY)) {
    const sh = ss.insertSheet(SHEET_SUMMARY);
    sh.appendRow(['Emp ID', 'Employee Name', 'Present', 'Late', 'Absent (so far this month)',
                  'Net Hours (this month)', 'Avg Hours/Day']);
    sh.getRange(1, 1, 1, 7).setFontWeight('bold');
  }

  SpreadsheetApp.getUi().alert('Setup complete. Fill in Settings (office coordinates) and Employee Master before sharing the app link.');
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Attendance Tool')
    .addItem('Initialize / Repair Sheets', 'initializeSheets')
    .addItem('Refresh Monthly Summary', 'refreshMonthlySummary')
    .addToUi();
}

// ---------- Helpers ----------
function getSettings_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_SETTINGS);
  const data = sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues();
  const map = {};
  data.forEach(r => map[r[0]] = r[1]);
  return {
    officeName: map['Office Name'] || 'Office',
    lat: Number(map['Office Latitude']),
    lng: Number(map['Office Longitude']),
    radius: Number(map['Allowed Radius (meters)']) || 200,
    grace: Number(map['Late Grace Period (minutes)']) || GRACE_MINUTES_DEFAULT
  };
}

function haversineMeters_(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findEmployeeByEmail_(email) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EMPLOYEE);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const emailCol = headers.indexOf('Official Email');
  const idCol = headers.indexOf('Emp ID');
  const nameCol = headers.indexOf('Employee Name');
  const deptCol = headers.indexOf('Department');
  const shiftCol = headers.indexOf('Shift Start');
  const weeklyOffCol = headers.indexOf('Weekly Off Day');
  const statusCol = headers.indexOf('Status');
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][emailCol]).trim().toLowerCase() === String(email).trim().toLowerCase()) {
      return {
        empId: data[i][idCol], name: data[i][nameCol], email: data[i][emailCol],
        department: data[i][deptCol], shiftStart: timeCellToString_(data[i][shiftCol]),
        weeklyOff: data[i][weeklyOffCol], status: data[i][statusCol]
      };
    }
  }
  return null;
}

function listActiveEmployees_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EMPLOYEE);
  const data = sh.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('Emp ID');
  const nameCol = headers.indexOf('Employee Name');
  const deptCol = headers.indexOf('Department');
  const weeklyOffCol = headers.indexOf('Weekly Off Day');
  const statusCol = headers.indexOf('Status');
  const out = [];
  for (let i = 1; i < data.length; i++) {
    if (!data[i][idCol]) continue;
    if (String(data[i][statusCol] || '').trim().toLowerCase() !== 'active') continue;
    out.push({ empId: data[i][idCol], name: data[i][nameCol], department: data[i][deptCol], weeklyOff: data[i][weeklyOffCol] });
  }
  return out;
}

function currentEmployee_() {
  const email = Session.getActiveUser().getEmail();
  if (!email) return { error: 'Could not detect your Google account email. Open this app while signed in to your official work Google account.' };
  const emp = findEmployeeByEmail_(email);
  if (!emp) return { error: 'Email ' + email + ' is not registered in Employee Master. Contact your admin.' };
  if (emp.status !== 'Active') return { error: 'Your record is marked "' + emp.status + '". Contact your admin.' };
  return { emp: emp };
}

function parseShiftTime_(shiftStart, referenceDate) {
  let h, m;
  if (shiftStart instanceof Date) {
    h = shiftStart.getHours();
    m = shiftStart.getMinutes();
  } else if (typeof shiftStart === 'string' && shiftStart.indexOf(':') > -1) {
    const parts = shiftStart.split(':');
    h = Number(parts[0]);
    m = Number(parts[1]);
  } else {
    return null;
  }
  const d = new Date(referenceDate);
  d.setHours(h, m, 0, 0);
  return d;
}

// Time-formatted Sheets cells read back as real Date objects. Sending one
// nested inside an object across the google.script.run bridge can silently
// fail to serialize (client gets null, server logs "Completed" — no error
// anywhere to see), so anything crossing that bridge gets stringified first.
function timeCellToString_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  return v;
}

function labelForBreak_(bt) {
  return bt ? (bt.charAt(0) + bt.slice(1).toLowerCase() + ' Break') : 'break';
}

// ---------- Roster (read-only) ----------
// Roster is a stack of monthly blocks: 2-row header (weekday + "dd/MMM/yyyy"
// date) starting at column K, employee rows below keyed by Name in column B.
// This never writes to Roster — it's the admin-owned planning tab.
function formatDdMmmYyyy_(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(date.getDate()).padStart(2, '0');
  return dd + '/' + months[date.getMonth()] + '/' + date.getFullYear();
}

function cellToDateString_(cell) {
  return typeof cell === 'string' ? cell.trim() : '';
}

function findTodayColumn_(grid, todayStr) {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (cellToDateString_(row[c]) === todayStr) return { headerRow: r, col: c };
    }
  }
  return null;
}

function findEmployeeRow_(grid, headerRow, employeeName) {
  const target = String(employeeName).trim().toLowerCase();
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const name = row[1];
    if (!name || String(name).trim() === '') break;
    if (String(name).trim().toLowerCase() === 'name') break;
    if (String(name).trim().toLowerCase() === target) return r;
  }
  return null;
}

function getRosterGrid_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_ROSTER);
  return sh.getDataRange().getValues();
}

function rosterCodeFromGrid_(grid, employeeName, now, weeklyOffFallback) {
  const todayStr = formatDdMmmYyyy_(now);
  const found = findTodayColumn_(grid, todayStr);
  if (found) {
    const empRow = findEmployeeRow_(grid, found.headerRow, employeeName);
    if (empRow !== null) {
      const code = grid[empRow][found.col];
      if (code) return String(code).trim();
    }
  }
  // Fallback: Roster hasn't been filled in for today yet — use the static
  // weekly-off day from Employee Master so at least WO days aren't blank.
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  if (weeklyOffFallback && dayNames[now.getDay()] === weeklyOffFallback) return 'WO';
  return '';
}

function getTodayRosterCodeFor_(employeeName, now, weeklyOffFallback) {
  return rosterCodeFromGrid_(getRosterGrid_(), employeeName, now, weeklyOffFallback);
}

// ---------- Day-state engine ----------
// Replays today's successful events into: not_started -> working -> on_break -> working -> ... -> completed
function computeDayState_(events) {
  let phase = 'not_started';
  let breakType = null;
  let punchIn = null, punchOut = null;
  const breakStart = { LUNCH: null, TEA: null, BIO: null };
  const breakTotals = { LUNCH: 0, TEA: 0, BIO: 0 };

  events.forEach(function (e) {
    if (e.type === 'PUNCH_IN') { punchIn = e.timestamp; phase = 'working'; }
    else if (e.type === 'PUNCH_OUT') { punchOut = e.timestamp; phase = 'completed'; }
    else if (e.type.indexOf('_START') > -1) {
      const bt = e.type.split('_')[0];
      breakStart[bt] = e.timestamp; phase = 'on_break'; breakType = bt;
    } else if (e.type.indexOf('_END') > -1) {
      const bt = e.type.split('_')[0];
      if (breakStart[bt]) breakTotals[bt] += (e.timestamp - breakStart[bt]) / 60000;
      phase = 'working'; breakType = null;
    }
  });

  return { phase: phase, breakType: breakType, punchIn: punchIn, punchOut: punchOut, breakTotals: breakTotals };
}

function validTransition_(phase, breakType, type) {
  if (type === 'PUNCH_IN') return phase === 'not_started';
  if (type === 'PUNCH_OUT') return phase === 'working';
  if (type === 'LUNCH_START' || type === 'TEA_START' || type === 'BIO_START') return phase === 'working';
  if (type === 'LUNCH_END') return phase === 'on_break' && breakType === 'LUNCH';
  if (type === 'TEA_END') return phase === 'on_break' && breakType === 'TEA';
  if (type === 'BIO_END') return phase === 'on_break' && breakType === 'BIO';
  return false;
}

function transitionErrorMessage_(state, type) {
  if (type === 'PUNCH_IN') return 'You have already punched in today.';
  if (type === 'PUNCH_OUT') {
    if (state.phase === 'on_break') return 'End your ' + labelForBreak_(state.breakType) + ' before punching out.';
    if (state.phase === 'not_started') return 'You need to punch in first.';
    if (state.phase === 'completed') return 'You have already punched out today.';
  }
  if (type.indexOf('_START') > -1) {
    if (state.phase === 'on_break') return 'You are already on a ' + labelForBreak_(state.breakType) + '. End it before starting another break.';
    if (state.phase === 'not_started') return 'You need to punch in before taking a break.';
    if (state.phase === 'completed') return 'You have already punched out today.';
  }
  if (type.indexOf('_END') > -1) return 'You are not currently on that break.';
  return 'That action is not available right now.';
}

function getTodayEvents_(empId) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const data = sh.getDataRange().getValues();
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (!row[0]) continue;
    if (String(row[1]) !== String(empId)) continue;
    if (row[9] !== 'Success') continue;
    const ts = new Date(row[0]);
    if (Utilities.formatDate(ts, tz, 'yyyy-MM-dd') !== today) continue;
    out.push({ type: row[4], timestamp: ts });
  }
  out.sort((a, b) => a.timestamp - b.timestamp);
  return out;
}

// Grace-gates lateBy immediately, so it reads the same whether the day is
// still in progress or already punched out (it used to show raw ungated
// minutes-late all day, then silently change once punched out).
function updateDailySummary_(emp, now, state, rosterCode, settings) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  const tz = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  const data = sh.getDataRange().getValues();
  let row = null;
  for (let i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;
    if (Utilities.formatDate(new Date(data[i][0]), tz, 'yyyy-MM-dd') === todayStr && String(data[i][1]) === String(emp.empId)) {
      row = i + 1;
      break;
    }
  }
  if (!row) {
    sh.appendRow([new Date(todayStr), emp.empId, emp.name, emp.email, '', '', 0, 0, 0, 0, '', '', '', '']);
    row = sh.getLastRow();
  }

  const totalBreak = state.breakTotals.LUNCH + state.breakTotals.TEA + state.breakTotals.BIO;
  let gross = '', net = '', lateBy = 0, status = rosterCode || 'Not Started';

  if (state.punchIn) {
    const shiftStartDate = parseShiftTime_(emp.shiftStart, state.punchIn);
    if (shiftStartDate) {
      const rawLate = Math.max(0, Math.round((state.punchIn - shiftStartDate) / 60000));
      lateBy = rawLate > settings.grace ? rawLate : 0;
    }
    status = 'Working';
  }
  if (state.phase === 'on_break') status = labelForBreak_(state.breakType);
  if (state.punchIn && state.punchOut) {
    gross = Math.round(((state.punchOut - state.punchIn) / 3600000) * 100) / 100;
    net = Math.round((gross - totalBreak / 60) * 100) / 100;
    status = net < 4 ? 'Half Day' : (lateBy > 0 ? 'Late' : 'Present');
  }

  sh.getRange(row, 5, 1, 10).setValues([[
    state.punchIn || '', state.punchOut || '',
    Math.round(state.breakTotals.LUNCH), Math.round(state.breakTotals.TEA), Math.round(state.breakTotals.BIO),
    Math.round(totalBreak), gross, net, lateBy, status
  ]]);
}

// ---------- Client-facing API ----------
function getCurrentUser() {
  const res = currentEmployee_();
  if (res.error) return { error: res.error };
  const settings = getSettings_();
  return { emp: res.emp, officeName: settings.officeName, radius: settings.radius };
}

function checkLocation(lat, lng) {
  const settings = getSettings_();
  const distance = Math.round(haversineMeters_(lat, lng, settings.lat, settings.lng));
  return { distance: distance, radius: settings.radius, within: distance <= settings.radius, officeName: settings.officeName };
}

// Same nested-Date risk as timeCellToString_ above: punchIn/punchOut are
// Date objects one level deep inside the returned object, which is the
// pattern that silently broke getCurrentUser(). Stringify before it crosses
// the bridge rather than relying on Apps Script's nested-Date handling.
function serializeState_(state) {
  return Object.assign({}, state, {
    punchIn: state.punchIn ? state.punchIn.toISOString() : null,
    punchOut: state.punchOut ? state.punchOut.toISOString() : null
  });
}

function getDayState() {
  const res = currentEmployee_();
  if (res.error) return { phase: 'not_started', breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, rosterCode: '', requiresGeofence: true };
  const now = new Date();
  const events = getTodayEvents_(res.emp.empId);
  const state = computeDayState_(events);
  const rosterCode = getTodayRosterCodeFor_(res.emp.name, now, res.emp.weeklyOff);
  return Object.assign(serializeState_(state), { rosterCode: rosterCode, requiresGeofence: rosterCode.toUpperCase() !== 'WFH' });
}

function recordEvent(type, lat, lng) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const res = currentEmployee_();
    if (res.error) throw new Error(res.error);
    const emp = res.emp;
    const now = new Date();
    const eventsLog = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_EVENTS);

    const todayEvents = getTodayEvents_(emp.empId);
    const state = computeDayState_(todayEvents);

    if (!validTransition_(state.phase, state.breakType, type)) {
      eventsLog.appendRow([now, emp.empId, emp.name, emp.email, type, lat, lng, '', '', 'Blocked - invalid order']);
      throw new Error(transitionErrorMessage_(state, type));
    }

    const settings = getSettings_();
    const rosterCode = getTodayRosterCodeFor_(emp.name, now, emp.weeklyOff);
    const requiresGeofence = rosterCode.toUpperCase() !== 'WFH';
    const distance = Math.round(haversineMeters_(lat, lng, settings.lat, settings.lng));
    const within = distance <= settings.radius;

    if (requiresGeofence && !within) {
      eventsLog.appendRow([now, emp.empId, emp.name, emp.email, type, lat, lng, distance, 'No', 'Blocked - outside geofence']);
      throw new Error('You are ' + distance + 'm from ' + settings.officeName + ' (allowed: ' + settings.radius + 'm). Move closer and try again.');
    }

    eventsLog.appendRow([now, emp.empId, emp.name, emp.email, type, lat, lng, distance, requiresGeofence ? (within ? 'Yes' : 'No') : 'N/A (WFH)', 'Success']);

    const newState = computeDayState_(todayEvents.concat([{ type: type, timestamp: now }]));
    updateDailySummary_(emp, now, newState, rosterCode, settings);

    return { success: true, time: now.toLocaleTimeString(), distance: distance, state: serializeState_(newState), rosterCode: rosterCode, requiresGeofence: requiresGeofence };
  } catch (err) {
    return { success: false, message: err.message };
  } finally {
    lock.releaseLock();
  }
}

// Live team status: today's Daily Attendance Log row per active employee,
// falling back to their Roster code if they haven't punched in yet. Fetches
// Roster once and reuses it across everyone, rather than once per employee.
function getTeamStatus() {
  const res = currentEmployee_();
  if (res.error) throw new Error(res.error);

  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');

  const logSh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_LOG);
  const logData = logSh.getDataRange().getValues();
  const todayRows = {};
  for (let i = 1; i < logData.length; i++) {
    const r = logData[i];
    if (!r[0]) continue;
    if (Utilities.formatDate(new Date(r[0]), tz, 'yyyy-MM-dd') === todayStr) {
      todayRows[String(r[1])] = r;
    }
  }

  const employees = listActiveEmployees_();
  const rosterGrid = getRosterGrid_();

  const results = employees.map(function (e) {
    const row = todayRows[e.empId];
    if (row) {
      return {
        empId: e.empId, name: e.name, department: e.department,
        punchIn: row[4] instanceof Date ? row[4].toISOString() : (row[4] || null),
        punchOut: row[5] instanceof Date ? row[5].toISOString() : (row[5] || null),
        lunch: row[6] || 0, tea: row[7] || 0, bio: row[8] || 0,
        netHours: row[11] || '', lateBy: row[12] || 0, status: row[13] || ''
      };
    }
    const rosterCode = rosterCodeFromGrid_(rosterGrid, e.name, now, e.weeklyOff);
    return {
      empId: e.empId, name: e.name, department: e.department,
      punchIn: null, punchOut: null, lunch: 0, tea: 0, bio: 0,
      netHours: '', lateBy: 0, status: rosterCode || 'Not Started'
    };
  });

  return { employees: results, asOf: now.toISOString() };
}

// ---------- Monthly Summary ----------
function countWorkingDaysSoFar_(weeklyOffName, refDate) {
  const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
  const offNum = dayMap[weeklyOffName];
  const year = refDate.getFullYear();
  const month = refDate.getMonth();
  const today = new Date();
  const lastDay = (today.getFullYear() === year && today.getMonth() === month)
    ? today.getDate()
    : new Date(year, month + 1, 0).getDate();
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dt = new Date(year, month, d);
    if (dt > today) break;
    if (dt.getDay() !== offNum) count++;
  }
  return count;
}

function refreshMonthlySummary() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSh = ss.getSheetByName(SHEET_LOG);
  const sumSh = ss.getSheetByName(SHEET_SUMMARY);

  const employees = listActiveEmployees_();
  const now = new Date();
  const tz = Session.getScriptTimeZone();
  const monthKey = Utilities.formatDate(now, tz, 'yyyy-MM');

  const logData = logSh.getDataRange().getValues();
  const stats = {};
  for (let i = 1; i < logData.length; i++) {
    const row = logData[i];
    const date = row[0];
    if (!date) continue;
    if (Utilities.formatDate(new Date(date), tz, 'yyyy-MM') !== monthKey) continue;
    const empId = row[1];
    const netHours = row[11] || 0;
    const status = row[13];
    if (!stats[empId]) stats[empId] = { present: 0, late: 0, halfDay: 0, hours: 0, days: 0 };
    if (status === 'Present') stats[empId].present++;
    if (status === 'Late') stats[empId].late++;
    if (status === 'Half Day') stats[empId].halfDay++;
    if (netHours) { stats[empId].hours += netHours; stats[empId].days++; }
  }

  const lastRow = sumSh.getLastRow();
  if (lastRow > 1) sumSh.getRange(2, 1, lastRow - 1, 7).clearContent();

  const out = employees.map(function (e) {
    const s = stats[e.empId] || { present: 0, late: 0, halfDay: 0, hours: 0, days: 0 };
    const presentTotal = s.present + s.late + s.halfDay;
    const workingDays = countWorkingDaysSoFar_(e.weeklyOff, now);
    const absent = Math.max(0, workingDays - presentTotal);
    const avg = s.days ? Math.round((s.hours / s.days) * 100) / 100 : 0;
    return [e.empId, e.name, presentTotal, s.late, absent, Math.round(s.hours * 100) / 100, avg];
  });
  if (out.length) sumSh.getRange(2, 1, out.length, 7).setValues(out);

  SpreadsheetApp.getUi().alert('Monthly Summary refreshed for ' + monthKey + '.');
}

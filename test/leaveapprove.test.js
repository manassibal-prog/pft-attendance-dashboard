// Team-lead approval of leave requests, and approved leave showing up in the
// Roster grid, Team Status and Day End Report. Runs the real actions from
// apps-script/Code.gs against an in-memory stand-in for the Sheet.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
function throws(fn) { try { fn(); } catch (e) { return e.message; } throw new Error('expected a throw'); }

function makeSheet(rows) {
  const width = function () { return Math.max.apply(null, rows.map(function (r) { return r.length; }).concat([1])); };
  return {
    rows: rows,
    getDataRange: function () { return { getValues: function () { return rows.map(function (r) { const c = r.slice(); while (c.length < width()) c.push(''); return c; }); } }; },
    appendRow: function (r) { rows.push(r.slice()); },
    getLastRow: function () { return rows.length; },
    setFrozenRows: function () {},
    getRange: function (r, c, nr, nc) {
      return {
        setValue: function (v) { while (rows.length < r) rows.push([]); while (rows[r - 1].length < c) rows[r - 1].push(''); rows[r - 1][c - 1] = v; },
        setValues: function (vs) { vs.forEach(function (vr, i) { while (rows.length < r + i) rows.push([]); vr.forEach(function (v, j) { while (rows[r - 1 + i].length < c + j) rows[r - 1 + i].push(''); rows[r - 1 + i][c - 1 + j] = v; }); }); },
        setFontWeight: function () {}, setNumberFormat: function () {}, setDataValidation: function () {}
      };
    }
  };
}

const tz = 'Asia/Kolkata';
const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

function makeEnv() {
  const sheets = {
    'Employee Master': makeSheet([
      ['Emp ID', 'Employee Name', 'Official Email', 'Department', 'Designation', 'Shift Start', 'Shift End', 'Weekly Off Day', 'Status'],
      ['E1', 'Asha', 'asha@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E2', 'Ben', 'ben@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E9', 'Priya', 'priya@wiom.in', 'PFT', 'Team Leader', '10:00', '19:00', 'Sunday', 'Active'],
      ['E8', 'Raj', 'raj@wiom.in', 'PFT', 'Manager', '10:00', '19:00', 'Sunday', 'Active']
    ]),
    'Settings': makeSheet([['Setting', 'Value', 'Notes'], ['Office Name', 'Head Office'], ['Office Latitude', 28.4484], ['Office Longitude', 77.0410], ['Allowed Radius (meters)', 100], ['Late Grace Period (minutes)', 5]]),
    'Daily Attendance Log': makeSheet([['Date', 'Emp ID', 'Employee Name', 'Email', 'Punch In', 'Punch Out', 'Lunch', 'Tea', 'Bio', 'Total', 'Gross', 'Net', 'Late', 'Status']]),
    'Punch Events Log': makeSheet([['Timestamp', 'Emp ID', 'Employee Name', 'Email', 'Event Type', 'Latitude', 'Longitude', 'Distance', 'Within', 'Result']])
  };
  const sandbox = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n] || null; }, insertSheet: function (n) { sheets[n] = makeSheet([]); return sheets[n]; } }; } },
    Session: { getScriptTimeZone: function () { return tz; } },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    Utilities: {
      formatDate: function (d, zone, fmt) {
        const p = {};
        new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
      }
    },
    HtmlService: {}, ContentService: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox);
  const A = vm.runInContext('ACTIONS', sandbox);
  const fn = (name) => vm.runInContext(name, sandbox);

  // The current week (Mon..Sun) the way getTeamRoster works it out, with a Roster tab for it.
  const today = new Date();
  const dow = today.getDay();
  const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() + (dow === 0 ? -6 : 1 - dow));
  const week = fn('dateRangeInfo_')(monday, 7);                    // [{date, key, ...}] key = dd/MMM/yyyy
  const roster = [
    ['', 'Name', '', '', '', '', '', '', '', ''].concat(week.map((d) => d.key)),
    ['', 'Asha', '', '', '', '', '', '', '', ''].concat(['P', 'P', 'P', 'P', 'P', 'P', 'P']),
    ['', 'Ben', '', '', '', '', '', '', '', ''].concat(['P', 'P', 'P', 'WO', 'P', 'P', 'P']),
    ['', 'Priya', '', '', '', '', '', '', '', ''].concat(['P', 'P', 'P', 'P', 'P', 'P', 'P']),
    ['', '']
  ];
  sheets['Roster'] = makeSheet(roster);

  return {
    sheets: sheets, A: A, week: week, todayKey: fn('formatDdMmmYyyy_')(today),
    leaveRows: () => sheets['Leave Requests'].rows,
    submit: (email, type, date, id) => A.submitLeave({ email: email, type: type, date: date, note: '', requestId: id }),
    decide: (email, id, decision) => A.decideLeave({ email: email, id: id, decision: decision }),
    rosterFor: (email) => A.getTeamRoster({ email: email, weekOffset: 0 }),
    dayOf: (i) => ymd(week[i].date)
  };
}
const idx = (env, name) => env.rosterFor('priya@wiom.in').rows.filter((r) => r.name === name)[0];

t('a team lead approves a request: status, who decided and when are recorded, and the advisor sees it', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', env.dayOf(1), 'r1');
  const r = env.decide('priya@wiom.in', 'r1', 'Approved');
  assertEq([r.success, r.request.status, r.request.decidedBy], [true, 'Approved', 'Priya']);
  const row = env.leaveRows()[1];
  assertEq([row[8], row[9]], ['Approved', 'Priya']);
  assertEq(typeof row[10].getTime, 'function', 'decided-at is a real timestamp in the sheet');
  assertEq(env.A.getMyLeave({ email: 'asha@wiom.in' }).requests[0].status, 'Approved');
});

t('reject, and reopen (back to Pending, decision cleared)', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'HD', env.dayOf(2), 'r1');
  assertEq(env.decide('raj@wiom.in', 'r1', 'Rejected').request.status, 'Rejected');
  const re = env.decide('raj@wiom.in', 'r1', 'Pending');
  assertEq([re.success, re.request.status, re.request.decidedBy], [true, 'Pending', '']);
  assertEq([env.leaveRows()[1][8], env.leaveRows()[1][9], env.leaveRows()[1][10]], ['Pending', '', '']);
});

t('deciding the same way twice is harmless', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', env.dayOf(1), 'r1');
  env.decide('priya@wiom.in', 'r1', 'Approved');
  assertEq(env.decide('priya@wiom.in', 'r1', 'Approved').success, true);
});

t('advisors cannot approve or reject — not even their own', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', env.dayOf(1), 'r1');
  const r = env.decide('asha@wiom.in', 'r1', 'Approved');
  assertEq([r.success, r.message], [false, 'Only team leads can approve or reject leave.']);
  assertEq(env.leaveRows()[1][8], 'Pending');
});

t('a team lead cannot decide their own request', () => {
  const env = makeEnv();
  env.submit('priya@wiom.in', 'L', env.dayOf(1), 'p1');
  const r = env.decide('priya@wiom.in', 'p1', 'Approved');
  assertEq(r.success, false);
  assertEq(r.message.indexOf('own request') > -1, true);
  assertEq(env.decide('raj@wiom.in', 'p1', 'Approved').success, true, 'another lead can');
});

t('a request the advisor cancelled cannot be decided; bad ids and bad decisions are refused', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', env.dayOf(1), 'r1');
  env.A.cancelLeave({ email: 'asha@wiom.in', id: 'r1' });
  assertEq(env.decide('priya@wiom.in', 'r1', 'Approved').message.indexOf('cancelled') > -1, true);
  assertEq(env.decide('priya@wiom.in', 'nope', 'Approved').message, 'That request was not found.');
  assertEq(env.decide('priya@wiom.in', 'r1', 'Maybe').message, 'Choose Approve, Reject or Reopen.');
});

t('getLeaveRequests is for team leads only', () => {
  const env = makeEnv();
  assertEq(throws(() => env.A.getLeaveRequests({ email: 'asha@wiom.in' })), 'Only managers can view this.');
  assertEq(env.A.getLeaveRequests({ email: 'priya@wiom.in' }).requests, []);
});

t('the list puts pending first (soonest day first), then decided newest first, with names; old decided ones drop off', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', env.dayOf(3), 'late');
  env.submit('ben@wiom.in', 'HD', env.dayOf(1), 'soon');
  env.submit('asha@wiom.in', 'WO', env.dayOf(5), 'decided');
  env.decide('priya@wiom.in', 'decided', 'Approved');
  // two requests from long ago: one still pending (must stay), one decided (must drop)
  const old = new Date(); old.setDate(old.getDate() - 45);
  const rows = env.leaveRows();
  rows.push(['oldPending', new Date(), 'E1', 'Asha', 'asha@wiom.in', old, 'Leave', '', 'Pending', '', '']);
  rows.push(['oldDecided', new Date(), 'E1', 'Asha', 'asha@wiom.in', old, 'Leave', '', 'Approved', 'Priya', new Date()]);
  const list = env.A.getLeaveRequests({ email: 'priya@wiom.in' }).requests;
  assertEq(list.map((r) => r.id), ['oldPending', 'soon', 'late', 'decided']);
  assertEq(list.filter((r) => r.id === 'soon')[0].name, 'Ben');
  assertEq(list.filter((r) => r.id === 'decided')[0].decidedBy, 'Priya');
});

// ---- approved leave shows in the views ----
t('Roster grid: an APPROVED request shows in the right person\'s cell, over what the Roster tab says', () => {
  const env = makeEnv();
  env.submit('ben@wiom.in', 'L', env.dayOf(3), 'b1');          // Ben's Roster cell for day 3 is "WO"
  env.decide('priya@wiom.in', 'b1', 'Approved');
  const ben = idx(env, 'Ben'), asha = idx(env, 'Asha');
  assertEq(ben.codes[3], 'L');
  assertEq(ben.codes.filter((_, i) => i !== 3), ['P', 'P', 'P', 'P', 'P', 'P'], 'his other days are untouched');
  assertEq(asha.codes, ['P', 'P', 'P', 'P', 'P', 'P', 'P'], 'nobody else is touched');
});

t('Roster grid: every type is shown as its own code', () => {
  const env = makeEnv();
  [['L', 0], ['HD', 1], ['UP', 2], ['WO', 3]].forEach(([code, d]) => {
    env.submit('asha@wiom.in', code, env.dayOf(d), 'x' + code);
    env.decide('priya@wiom.in', 'x' + code, 'Approved');
  });
  assertEq(idx(env, 'Asha').codes.slice(0, 4), ['L', 'HD', 'UP', 'WO']);
});

t('Roster grid: pending, rejected and cancelled requests change nothing; reopening takes an approval back off', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', env.dayOf(0), 'p');
  env.submit('asha@wiom.in', 'L', env.dayOf(1), 'r');
  env.submit('asha@wiom.in', 'L', env.dayOf(2), 'c');
  env.submit('asha@wiom.in', 'L', env.dayOf(3), 'a');
  env.decide('priya@wiom.in', 'r', 'Rejected');
  env.A.cancelLeave({ email: 'asha@wiom.in', id: 'c' });
  env.decide('priya@wiom.in', 'a', 'Approved');
  assertEq(idx(env, 'Asha').codes.slice(0, 4), ['P', 'P', 'P', 'L']);
  env.decide('priya@wiom.in', 'a', 'Pending');
  assertEq(idx(env, 'Asha').codes.slice(0, 4), ['P', 'P', 'P', 'P']);
});

t('Team Status: an advisor on approved leave today shows it instead of the Roster code; someone who punched in keeps their real status', () => {
  const env = makeEnv();
  const todayIdx = env.week.findIndex((d) => d.key === env.todayKey);
  env.submit('asha@wiom.in', 'L', env.dayOf(todayIdx), 'a1');
  env.decide('priya@wiom.in', 'a1', 'Approved');
  env.submit('ben@wiom.in', 'HD', env.dayOf(todayIdx), 'b1');
  env.decide('priya@wiom.in', 'b1', 'Approved');
  // Ben actually worked today: a Daily Attendance Log row exists.
  env.sheets['Daily Attendance Log'].rows.push([new Date(), 'E2', 'Ben', 'ben@wiom.in', new Date(), '', 0, 0, 0, 0, '', '', 0, 'Working']);
  const status = {};
  env.A.getTeamStatus({ email: 'priya@wiom.in' }).employees.forEach((e) => { status[e.name] = e.status; });
  assertEq(status, { Asha: 'L', Ben: 'Working' });
});

t('Day End Report: approved leave shows for that date; a day someone punched in keeps the real status', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'UP', env.dayOf(1), 'a1');
  env.decide('priya@wiom.in', 'a1', 'Approved');
  env.submit('ben@wiom.in', 'L', env.dayOf(1), 'b1');
  env.decide('priya@wiom.in', 'b1', 'Approved');
  const day = new Date(env.week[1].date);
  env.sheets['Daily Attendance Log'].rows.push([day, 'E2', 'Ben', 'ben@wiom.in', day, day, 0, 0, 0, 0, 8, 8, 0, 'Present']);
  const report = env.A.getDayEndReport({ email: 'priya@wiom.in', date: env.dayOf(1) });
  const status = {};
  report.employees.forEach((e) => { status[e.name] = e.status; });
  assertEq(status, { Asha: 'UP', Ben: 'Present' });
  const other = {};
  env.A.getDayEndReport({ email: 'priya@wiom.in', date: env.dayOf(2) }).employees.forEach((e) => { other[e.name] = e.status; });
  assertEq(other.Asha, 'P', 'a different day is unaffected');
});

t('Work From Home cannot be requested, so an approval can never touch the office-range rule', () => {
  const env = makeEnv();
  const todayIdx = env.week.findIndex((d) => d.key === env.todayKey);
  const r = env.submit('asha@wiom.in', 'WFH', env.dayOf(todayIdx), 'w1');
  assertEq(r.success, false);
  const state = env.A.getDayState({ email: 'asha@wiom.in' });
  assertEq([state.requiresGeofence, state.rosterCode], [true, 'P']);
});

t("the Roster tab's own WFH day is untouched: it still skips the office-range check, and still shows in the grid", () => {
  const env = makeEnv();
  const todayIdx = env.week.findIndex((d) => d.key === env.todayKey);
  env.sheets['Roster'].rows[1][10 + todayIdx] = 'WFH';            // Asha's cell for today, set by the admin in the Roster tab
  const state = env.A.getDayState({ email: 'asha@wiom.in' });
  assertEq([state.requiresGeofence, state.rosterCode], [false, 'WFH']);
  assertEq(idx(env, 'Asha').codes[todayIdx], 'WFH');
});

console.log('done');

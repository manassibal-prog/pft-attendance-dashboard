// Runs the real getMyLeave / submitLeave / cancelLeave actions from
// apps-script/Code.gs against an in-memory stand-in for the Sheet (Apps Script
// can't run outside Google). The "Leave Requests" tab starts out missing, like
// the live sheet, and is created on first use.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

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
function dayKey(offsetDays) {
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
  const d = new Date(Number(p.year), Number(p.month) - 1, Number(p.day) + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function makeEnv() {
  const sheets = {
    'Employee Master': makeSheet([
      ['Emp ID', 'Employee Name', 'Official Email', 'Department', 'Designation', 'Shift Start', 'Shift End', 'Weekly Off Day', 'Status'],
      ['E1', 'Asha', 'asha@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E2', 'Ben', 'ben@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E3', 'Old', 'old@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Inactive']
    ])
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
  return {
    sheets: sheets,
    leaveRows: function () { return sheets['Leave Requests'] ? sheets['Leave Requests'].rows : null; },
    mine: function (email) { return A.getMyLeave({ email: email }).requests; },
    submit: function (email, type, date, note, requestId) { return A.submitLeave({ email: email, type: type, date: date, note: note, requestId: requestId }); },
    cancel: function (email, id) { return A.cancelLeave({ email: email, id: id }); },
    A: A
  };
}

t('first use creates the Leave Requests tab with its headers and returns an empty list', () => {
  const env = makeEnv();
  assertEq(env.leaveRows(), null);
  assertEq(env.mine('asha@wiom.in'), []);
  assertEq(env.leaveRows()[0], ['Request ID', 'Submitted At', 'Emp ID', 'Employee Name', 'Email', 'Date', 'Type', 'Note', 'Status', 'Decided By', 'Decided At']);
});

t('a request is saved as Pending, with the type spelled out for whoever reads the sheet', () => {
  const env = makeEnv();
  const day = dayKey(3);
  const r = env.submit('asha@wiom.in', 'HD', day, 'dentist', 'req-1');
  assertEq(r.success, true);
  assertEq([r.request.id, r.request.date, r.request.code, r.request.type, r.request.note, r.request.status], ['req-1', day, 'HD', 'Half Day', 'dentist', 'Pending']);
  const row = env.leaveRows()[1];
  assertEq([row[0], row[2], row[3], row[4], row[6], row[7], row[8]], ['req-1', 'E1', 'Asha', 'asha@wiom.in', 'Half Day', 'dentist', 'Pending']);
});

t('every type maps to its roster code and label', () => {
  const env = makeEnv();
  const seen = {};
  [['L', 'Leave'], ['HD', 'Half Day'], ['UP', 'Unpaid Leave'], ['WFH', 'Work From Home'], ['WO', 'Week Off']].forEach(([code, label], i) => {
    const r = env.submit('asha@wiom.in', code, dayKey(10 + i), '', 'id-' + code);
    seen[code] = [r.request.code, r.request.type];
  });
  assertEq(seen, { L: ['L', 'Leave'], HD: ['HD', 'Half Day'], UP: ['UP', 'Unpaid Leave'], WFH: ['WFH', 'Work From Home'], WO: ['WO', 'Week Off'] });
});

t('people only ever see their own requests, newest date first', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(5), '', 'a1');
  env.submit('asha@wiom.in', 'L', dayKey(9), '', 'a2');
  env.submit('ben@wiom.in', 'L', dayKey(5), '', 'b1');
  assertEq(env.mine('asha@wiom.in').map((r) => r.id), ['a2', 'a1']);
  assertEq(env.mine('ben@wiom.in').map((r) => r.id), ['b1']);
});

t('the same submit retried (reply lost) is not saved twice', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'same');
  const again = env.submit('asha@wiom.in', 'L', dayKey(4), '', 'same');
  assertEq([again.success, again.duplicate], [true, true]);
  assertEq(env.leaveRows().length, 2, 'header + one request');
});

t('a second request for a day that already has an active one is refused, with a way out', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'one');
  const r = env.submit('asha@wiom.in', 'HD', dayKey(4), '', 'two');
  assertEq(r.success, false);
  assertEq(r.message.indexOf('Cancel it first') > -1 && r.message.indexOf('Leave') > -1 && r.message.indexOf('Pending') > -1, true);
});

t('cancelling a pending request frees the day; a cancelled request is recorded as such', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'one');
  const c = env.cancel('asha@wiom.in', 'one');
  assertEq([c.success, c.request.status], [true, 'Cancelled']);
  const row = env.leaveRows()[1];
  assertEq([row[8], String(row[9])], ['Cancelled', 'Asha (self)']);
  assertEq(env.submit('asha@wiom.in', 'HD', dayKey(4), '', 'three').success, true);
});

t('cancelling twice is harmless', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'one');
  env.cancel('asha@wiom.in', 'one');
  const again = env.cancel('asha@wiom.in', 'one');
  assertEq([again.success, again.request.status], [true, 'Cancelled']);
});

t('only a pending request can be cancelled — an approved one needs the team lead', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'one');
  env.leaveRows()[1][8] = 'Approved';           // team lead edits the sheet
  const r = env.cancel('asha@wiom.in', 'one');
  assertEq(r.success, false);
  assertEq(r.message.indexOf('team lead') > -1, true);
  assertEq(env.leaveRows()[1][8], 'Approved');
});

t('nobody can cancel somebody else\'s request', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'one');
  const r = env.cancel('ben@wiom.in', 'one');
  assertEq([r.success, r.message], [false, 'That request was not found.']);
  assertEq(env.leaveRows()[1][8], 'Pending');
});

t('bad input is refused with a clear message, and nothing is written', () => {
  const env = makeEnv();
  const bad = [
    ['nonsense', dayKey(3), 'Choose what you are marking'],
    ['L', 'not-a-date', 'valid date'],
    ['L', '2026-02-30', 'valid date'],
    ['L', '', 'valid date'],
    ['L', dayKey(-8), 'up to 7 days back'],
    ['L', dayKey(181), 'up to 180 days ahead']
  ];
  bad.forEach(([type, date, expect]) => {
    const r = env.submit('asha@wiom.in', type, date, '', 'x-' + date + type);
    assertEq(r.success, false, type + ' ' + date);
    assertEq(r.message.indexOf(expect) > -1, true, r.message);
  });
  assertEq(env.leaveRows(), null, 'refused before touching the sheet — not even the tab is created');
});

t('the window edges are allowed: 7 days back and 180 days ahead', () => {
  const env = makeEnv();
  assertEq(env.submit('asha@wiom.in', 'L', dayKey(-7), '', 'edge1').success, true);
  assertEq(env.submit('asha@wiom.in', 'L', dayKey(180), '', 'edge2').success, true);
});

t('a note can never become a formula, is one short line, and is capped at 200 characters', () => {
  const env = makeEnv();
  const f = env.submit('asha@wiom.in', 'L', dayKey(3), '=HYPERLINK("http://x","click")', 'n1');
  assertEq(f.request.note, '\'=HYPERLINK("http://x","click")');
  const multi = env.submit('asha@wiom.in', 'L', dayKey(4), 'line one\nline two\tend', 'n2');
  assertEq(multi.request.note, 'line one line two end');
  const long = env.submit('asha@wiom.in', 'L', dayKey(5), 'x'.repeat(500), 'n3');
  assertEq(long.request.note.length, 200);
});

t('the team lead\'s edits in the sheet are understood: lowercase status, a typed-in label, a text date', () => {
  const env = makeEnv();
  env.submit('asha@wiom.in', 'L', dayKey(4), '', 'one');
  const rows = env.leaveRows();
  rows[1][8] = 'approved';
  rows[1][6] = 'Sick Leave';
  rows[1][5] = '2026-11-05';
  const r = env.mine('asha@wiom.in')[0];
  assertEq([r.status, r.type, r.code, r.date], ['Approved', 'Sick Leave', '', '2026-11-05']);
});

t('unregistered and inactive people are refused', () => {
  const env = makeEnv();
  assertEq(env.submit('nobody@wiom.in', 'L', dayKey(3), '', 'u1').success, false);
  assertEq(env.submit('old@wiom.in', 'L', dayKey(3), '', 'u2').success, false);
  let threw = false;
  try { env.mine('nobody@wiom.in'); } catch (e) { threw = true; }
  assertEq(threw, true);
});

console.log('done');

// Runs the real recordEvent action from apps-script/Code.gs against an
// in-memory stand-in for the Sheet (Apps Script itself can't run outside
// Google). Covers the retry-safety contract the browser relies on:
//   * the same tap retried with the same requestId is a success, never a repeat
//   * a refused tap still tells the browser the current state
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
    getDataRange: function () {
      return { getValues: function () { return rows.map(function (r) { const c = r.slice(); while (c.length < width()) c.push(''); return c; }); } };
    },
    appendRow: function (r) { rows.push(r.slice()); },
    getLastRow: function () { return rows.length; },
    getLastColumn: function () {
      return rows.reduce(function (m, r) {
        let n = r.length;
        while (n > 0 && (r[n - 1] === '' || r[n - 1] === null || r[n - 1] === undefined)) n--;
        return Math.max(m, n);
      }, 0);
    },
    getRange: function (r, c, nr, nc) {
      return {
        getValues: function () { const out = []; for (let i = 0; i < (nr || 1); i++) { out.push((rows[r - 1 + i] || []).slice(c - 1, c - 1 + (nc || 1))); } return out; },
        setValue: function (v) { while (rows.length < r) rows.push([]); while (rows[r - 1].length < c) rows[r - 1].push(''); rows[r - 1][c - 1] = v; },
        setValues: function (vs) { vs.forEach(function (vr, i) { while (rows.length < r + i) rows.push([]); vr.forEach(function (v, j) { while (rows[r - 1 + i].length < c + j) rows[r - 1 + i].push(''); rows[r - 1 + i][c - 1 + j] = v; }); }); },
        setFontWeight: function () {}, clearContent: function () {}
      };
    }
  };
}

function makeEnv() {
  const sheets = {
    'Employee Master': makeSheet([
      ['Emp ID', 'Employee Name', 'Official Email', 'Department', 'Designation', 'Shift Start', 'Shift End', 'Weekly Off Day', 'Status'],
      ['E1', 'Asha', 'asha@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E2', 'Ben', 'ben@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active']
    ]),
    'Settings': makeSheet([
      ['Setting', 'Value', 'Notes'], ['Office Name', 'Head Office'], ['Office Latitude', 28.4484], ['Office Longitude', 77.0410],
      ['Allowed Radius (meters)', 100], ['Late Grace Period (minutes)', 5]
    ]),
    'Roster': makeSheet([['']]),
    'Daily Attendance Log': makeSheet([['Date', 'Emp ID', 'Employee Name', 'Email', 'Punch In', 'Punch Out', 'Lunch', 'Tea', 'Bio', 'Total', 'Gross', 'Net', 'Late', 'Status']]),
    // The live sheet predates the Request ID column: 10 header cells only.
    'Punch Events Log': makeSheet([['Timestamp', 'Emp ID', 'Employee Name', 'Email', 'Event Type', 'Latitude', 'Longitude', 'Distance From Office (m)', 'Within Geofence', 'Result']])
  };
  const tz = 'Asia/Kolkata';
  const sandbox = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { return sheets[n]; } }; } },
    Session: { getScriptTimeZone: function () { return tz; } },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    Utilities: {
      formatDate: function (d, zone, fmt) {
        const p = {};
        new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
          .formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
        return fmt.replace('yyyy', p.year).replace('MM', p.month).replace('dd', p.day).replace('HH', p.hour).replace('mm', p.minute);
      }
    },
    HtmlService: {}, ContentService: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox);
  const record = vm.runInContext('ACTIONS.recordEvent', sandbox);
  const here = { lat: '28.4484', lng: '77.0410' };
  return {
    sheets: sheets,
    events: sheets['Punch Events Log'].rows,
    tap: function (email, type, requestId, extra) { return record(Object.assign({ email: email, type: type, requestId: requestId }, here, extra || {})); }
  };
}

t('first tap is recorded, with its requestId in column K, and the missing header is added', function () {
  const env = makeEnv();
  const r = env.tap('asha@wiom.in', 'PUNCH_IN', 'req-1');
  assertEq(r.success, true);
  assertEq(r.state.phase, 'working');
  const last = env.events[env.events.length - 1];
  assertEq([last[4], last[9], last[10]], ['PUNCH_IN', 'Success', 'req-1']);
  assertEq(env.events[0][10], 'Request ID');
});

t('the same tap retried (reply was lost) is a success, not a repeat — and writes nothing', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'req-1');
  const rowsBefore = env.events.length;
  const retry = env.tap('asha@wiom.in', 'PUNCH_IN', 'req-1');
  assertEq(retry.success, true);
  assertEq(retry.duplicate, true);
  assertEq(retry.state.phase, 'working');
  assertEq(env.events.length, rowsBefore, 'no new row');
  assertEq(env.sheets['Daily Attendance Log'].rows.length, 2, 'daily log untouched too');
});

t('a genuinely new tap of the same kind (different requestId) is still refused as already done', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'req-1');
  const again = env.tap('asha@wiom.in', 'PUNCH_IN', 'req-2');
  assertEq(again.success, false);
  assertEq(again.message, 'You have already punched in today.');
  const last = env.events[env.events.length - 1];
  assertEq([last[9], last[10]], ['Blocked - invalid order', 'req-2'], 'still logged for audit');
});

t('...and that refusal carries the current state so the screen can correct itself from this one reply', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'req-1');
  const again = env.tap('asha@wiom.in', 'PUNCH_IN', 'req-2');
  assertEq(again.state.phase, 'working');
  assertEq(typeof again.state.punchIn, 'string');
  assertEq(typeof again.rosterCode, 'string');
  assertEq(typeof again.requiresGeofence, 'boolean');
});

t('the exact situation in the log: LUNCH_END tapped again and again after it succeeded', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'a');
  env.tap('asha@wiom.in', 'LUNCH_START', 'b');
  const end = env.tap('asha@wiom.in', 'LUNCH_END', 'c');
  assertEq(end.state.phase, 'working');
  const repeat = env.tap('asha@wiom.in', 'LUNCH_END', 'd');   // user can't see the success, taps again
  assertEq(repeat.success, false);
  assertEq(repeat.state.phase, 'working', 'the refusal itself tells the browser it is already back at work');
  const retry = env.tap('asha@wiom.in', 'LUNCH_END', 'c');     // browser retrying the original tap
  assertEq(retry.success, true);
  assertEq(retry.duplicate, true);
  assertEq(retry.state.breakTotals.LUNCH, end.state.breakTotals.LUNCH, 'break time is not double-counted');
});

t('a retry of an EARLIER tap, after later ones, is still recognised (no spurious refusal)', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'a');
  env.tap('asha@wiom.in', 'LUNCH_START', 'b');
  env.tap('asha@wiom.in', 'LUNCH_END', 'c');
  const late = env.tap('asha@wiom.in', 'LUNCH_START', 'b');
  assertEq([late.success, late.duplicate], [true, true]);
});

t('the same requestId on a different event type is a different request', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'x');
  const r = env.tap('asha@wiom.in', 'LUNCH_START', 'x');
  assertEq([r.success, r.duplicate], [true, undefined]);
  assertEq(r.state.phase, 'on_break');
});

t('requestIds are per person: another employee reusing one is not treated as a retry', function () {
  const env = makeEnv();
  env.tap('asha@wiom.in', 'PUNCH_IN', 'same');
  const r = env.tap('ben@wiom.in', 'PUNCH_IN', 'same');
  assertEq([r.success, r.duplicate], [true, undefined]);
});

t('a tap that was refused is never mistaken for one that went through (outside geofence, then retried from inside)', function () {
  const env = makeEnv();
  const out = env.tap('asha@wiom.in', 'PUNCH_IN', 'z', { lat: '30.0', lng: '78.0' });
  assertEq(out.success, false);
  assertEq(out.state.phase, 'not_started', 'nothing changed, and the reply says so');
  assertEq(out.message.indexOf('from Head Office (allowed: 100m)') > -1, true);
  assertEq(env.events[env.events.length - 1][9], 'Blocked - outside geofence');
  const inside = env.tap('asha@wiom.in', 'PUNCH_IN', 'z');
  assertEq([inside.success, inside.duplicate], [true, undefined]);
});

t('an older frontend that sends no requestId still works exactly as before', function () {
  const env = makeEnv();
  const first = env.tap('asha@wiom.in', 'PUNCH_IN', undefined);
  assertEq(first.success, true);
  const again = env.tap('asha@wiom.in', 'PUNCH_IN', undefined);
  assertEq(again.success, false);
  assertEq(again.message, 'You have already punched in today.');
});

t('mobile devices are still refused (and logged with the requestId)', function () {
  const env = makeEnv();
  const r = env.tap('asha@wiom.in', 'PUNCH_IN', 'm1', { device: 'mobile' });
  assertEq(r.success, false);
  assertEq(r.message, 'Attendance can only be marked from a laptop or desktop browser, not a phone or tablet.');
  assertEq(env.events[env.events.length - 1][9], 'Blocked - mobile device');
});

t('unregistered emails are still refused', function () {
  const env = makeEnv();
  const r = env.tap('nobody@wiom.in', 'PUNCH_IN', 'q');
  assertEq(r.success, false);
});

console.log('done');

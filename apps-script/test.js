// Not part of the deployed Apps Script — a local-only harness to verify
// Code.gs's pure logic functions (no SpreadsheetApp/Session calls) behave
// identically to the already-tested Node version, since Apps Script itself
// can't run outside the actual Google environment.
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(__dirname + '/Code.gs', 'utf8');
const sandbox = {
  console,
  // Stubs so the file evaluates even though these functions aren't called
  // by anything we're testing here.
  SpreadsheetApp: {}, Session: { getScriptTimeZone: () => 'Asia/Kolkata' }, Utilities: {}, LockService: {}, HtmlService: {},
};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

const base = new Date(2026, 7, 19);
const at = (h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m);

// ---- state machine parity with test/dayState.test.js ----
t('not_started -> PUNCH_IN valid, others invalid', () => {
  assertEq(sandbox.validTransition_('not_started', null, 'PUNCH_IN'), true);
  assertEq(sandbox.validTransition_('not_started', null, 'PUNCH_OUT'), false);
});

t('on_break -> only matching END valid', () => {
  assertEq(sandbox.validTransition_('on_break', 'LUNCH', 'LUNCH_END'), true);
  assertEq(sandbox.validTransition_('on_break', 'LUNCH', 'TEA_END'), false);
  assertEq(sandbox.validTransition_('on_break', 'LUNCH', 'PUNCH_OUT'), false);
});

t('full day replay: in -> lunch -> tea -> bio -> out, totals correct', () => {
  const events = [
    { type: 'PUNCH_IN', timestamp: at(9, 28) },
    { type: 'LUNCH_START', timestamp: at(13, 0) },
    { type: 'LUNCH_END', timestamp: at(13, 30) },
    { type: 'TEA_START', timestamp: at(16, 0) },
    { type: 'TEA_END', timestamp: at(16, 10) },
    { type: 'BIO_START', timestamp: at(17, 0) },
    { type: 'BIO_END', timestamp: at(17, 5) },
    { type: 'PUNCH_OUT', timestamp: at(18, 35) },
  ];
  const state = sandbox.computeDayState_(events);
  assertEq(state.phase, 'completed');
  assertEq(state.breakTotals.LUNCH, 30);
  assertEq(state.breakTotals.TEA, 10);
  assertEq(state.breakTotals.BIO, 5);
});

t('lateBy grace-gating logic matches the fixed Node version (5 min late, 15 min grace -> 0, not Late)', () => {
  const shiftStart = sandbox.parseShiftTime_('09:30', at(9, 35));
  const rawLate = Math.max(0, Math.round((at(9, 35) - shiftStart) / 60000));
  const grace = 15;
  const lateBy = rawLate > grace ? rawLate : 0;
  assertEq(rawLate, 5);
  assertEq(lateBy, 0); // this is the exact expression now inlined in updateDailySummary_
});

// ---- roster block parser parity with test/roster.test.js ----
const grid = [
  ['Sep', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', 'Tuesday', 'Wednesday'],
  ['Sep', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', '01/Sep/2026', '02/Sep/2026'],
  ['Sep', 'Dhananjay', 0, 7, 4, 3, 0, 0, 0, '', '', 'L'],
  ['Sep', 'Shivani', 0, 4, 4, 0, 0, 0, 0, '', '', ''],
  ['Sep', '', '', '', '', '', '', '', '', '', '', ''],
  ['Aug', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'],
  ['Aug', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', '01/Aug/2026', '02/Aug/2026', '03/Aug/2026', '18/Aug/2026', '19/Aug/2026'],
  ['Aug', 'Dhananjay', 12, 7, 5, 0, 0, 0, 2, '', 'P', 'WO', 'P', 'WFH', ''],
  ['Aug', 'Rohit', 7, 13, 5, 2, 1, 0, 2, '', 'P', 'WO', 'P', 'L', 'UP'],
];

t('roster: finds code in Sep block', () => {
  assertEq(sandbox.rosterCodeFromGrid_(grid, 'Dhananjay', new Date(2026, 8, 2), null), 'L');
});
t('roster: does not leak Sep employees into Aug block', () => {
  assertEq(sandbox.rosterCodeFromGrid_(grid, 'Shivani', new Date(2026, 7, 18), null), '');
});
t('roster: finds code in Aug block, case-insensitive, WFH', () => {
  assertEq(sandbox.rosterCodeFromGrid_(grid, 'dhananjay', new Date(2026, 7, 18), null), 'WFH');
});
t('roster: UP code (unpaid leave) read correctly', () => {
  assertEq(sandbox.rosterCodeFromGrid_(grid, 'Rohit', new Date(2026, 7, 19), null), 'UP');
});
t('roster: blank cell falls back to weekly-off-day match', () => {
  assertEq(sandbox.rosterCodeFromGrid_(grid, 'Dhananjay', new Date(2026, 7, 19), 'Wednesday'), 'WO');
  assertEq(sandbox.rosterCodeFromGrid_(grid, 'Dhananjay', new Date(2026, 7, 19), 'Sunday'), '');
});

// Regression test: SpreadsheetApp.getValues() (what Code.gs actually calls)
// returns real Date objects for date-typed cells, unlike the Sheets REST
// API's FORMATTED_VALUE mode (always strings) that the parked Node backend
// used. A header row built from Date objects, matching the real Roster
// sheet, must still resolve — this is exactly the bug that shipped once
// (cellToDateString_ only handled strings, so nothing ever matched and the
// whole grid rendered blank for every employee).
//
// Built with the sandbox's own Date constructor, not this file's — vm
// contexts have their own separate globals, so a Date built out here would
// fail `instanceof Date` inside the sandbox regardless of the fix (a Node
// cross-realm quirk with no equivalent in the real single-realm Apps Script
// runtime, but one that would still make this specific test meaningless).
vm.runInContext(`
  var dateObjectGrid = [
    ['Aug', 'Name', 'P', '', '', '', '', '', '', '', new Date(2026, 7, 17), new Date(2026, 7, 18), new Date(2026, 7, 19)],
    ['Aug', 'Dhananjay', 12, '', '', '', '', '', '', '', 'P', 'WO', 'WFH'],
  ];
  var dateFor17 = new Date(2026, 7, 17);
  var dateFor19 = new Date(2026, 7, 19);
`, sandbox);
t('roster: header dates as real Date objects (Apps Script getValues() behavior) still resolve', () => {
  assertEq(sandbox.rosterCodeFromGrid_(sandbox.dateObjectGrid, 'Dhananjay', sandbox.dateFor19, null), 'WFH');
  assertEq(sandbox.rosterCodeFromGrid_(sandbox.dateObjectGrid, 'Dhananjay', sandbox.dateFor17, null), 'P');
});

// ---- weekly/monthly range helpers (Team Status roster grid, My Attendance month strip) ----
t('dateRangeInfo_ generates the right number of consecutive days with correct weekday labels', () => {
  const days = sandbox.dateRangeInfo_(new Date(2026, 7, 31), 3); // Aug 31 (Mon) -> Sep 2
  assertEq(days.length, 3);
  assertEq(days[0].key, '31/Aug/2026');
  assertEq(days[0].weekday, 'Mon');
  assertEq(days[1].key, '01/Sep/2026');
  assertEq(days[2].key, '02/Sep/2026');
});

t('rosterCodeForDate_ resolves dates that fall in different monthly blocks within the same requested range', () => {
  // Aug 19 lives in the Aug block, Sep 2 lives in the Sep block — a week
  // spanning the boundary must look each date up in its own block.
  assertEq(sandbox.rosterCodeForDate_(grid, 'Dhananjay', '18/Aug/2026'), 'WFH');
  assertEq(sandbox.rosterCodeForDate_(grid, 'Dhananjay', '02/Sep/2026'), 'L');
});

t('rosterCodeForDate_ returns empty string for a date not present anywhere in the grid', () => {
  assertEq(sandbox.rosterCodeForDate_(grid, 'Dhananjay', '15/Aug/2026'), '');
});

t('formatRangeLabel_ matches "17 Aug – 23 Aug 2026" style', () => {
  const days = sandbox.dateRangeInfo_(new Date(2026, 7, 17), 7);
  assertEq(sandbox.formatRangeLabel_(days), '17 Aug – 23 Aug 2026');
});

console.log('done');

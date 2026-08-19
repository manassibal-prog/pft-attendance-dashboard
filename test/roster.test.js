const { getTodayRosterCode } = require('../src/rosterLookup');

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Mirrors the real layout: col0=Month(merged), col1=Name, col2..8=summary,
// col9=spacer, col10(K)+ = date columns. Two stacked blocks with a blank
// separator row between them, like the real sheet.
const grid = [
  // --- Sep block ---
  ['Sep', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', 'Tuesday', 'Wednesday'],
  ['Sep', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', '01/Sep/2026', '02/Sep/2026'],
  ['Sep', 'Dhananjay', 0, 7, 4, 3, 0, 0, 0, '', '', 'L'],
  ['Sep', 'Shivani', 0, 4, 4, 0, 0, 0, 0, '', '', ''],
  ['Sep', '', '', '', '', '', '', '', '', '', '', ''], // blank separator
  ['Sep', '', '', '', '', '', '', '', '', '', '', ''],
  // --- Aug block ---
  ['Aug', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', 'Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday'],
  ['Aug', 'Name', 'P', 'Total', 'WO', 'Leaves', 'UP', 'HD', 'Holiday', '', '01/Aug/2026', '02/Aug/2026', '03/Aug/2026', '18/Aug/2026', '19/Aug/2026'],
  ['Aug', 'Dhananjay', 12, 7, 5, 0, 0, 0, 2, '', 'P', 'WO', 'P', 'WFH', ''],
  ['Aug', 'Rohit', 7, 13, 5, 2, 1, 0, 2, '', 'P', 'WO', 'P', 'L', 'UP'],
];

t('finds code in first (Sep) block for known date', () => {
  assertEq(getTodayRosterCode(grid, 'Dhananjay', new Date(2026, 8, 2)), 'L');
});

t('does not leak Sep employee list into Aug block lookup', () => {
  // Shivani only exists in the Sep block; looking her up for an Aug date must miss.
  assertEq(getTodayRosterCode(grid, 'Shivani', new Date(2026, 7, 18)), '');
});

t('finds code in second (Aug) block, case-insensitive name match', () => {
  assertEq(getTodayRosterCode(grid, 'dhananjay', new Date(2026, 7, 18)), 'WFH');
});

t('blank cell (not yet filled in) returns empty string, not an error', () => {
  assertEq(getTodayRosterCode(grid, 'Dhananjay', new Date(2026, 7, 19)), '');
});

t('unknown employee returns empty string', () => {
  assertEq(getTodayRosterCode(grid, 'Nobody', new Date(2026, 7, 18)), '');
});

t('unknown date (not in any header row) returns empty string', () => {
  assertEq(getTodayRosterCode(grid, 'Dhananjay', new Date(2025, 0, 1)), '');
});

t('UP code read correctly (unpaid leave)', () => {
  assertEq(getTodayRosterCode(grid, 'Rohit', new Date(2026, 7, 19)), 'UP');
});

console.log('done');

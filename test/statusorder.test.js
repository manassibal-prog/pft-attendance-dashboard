// The one shared row order for Today's Summary (Team Status) and the Day End
// Report, and the neon-red colouring of Leave / Unpaid Leave. The ordering code
// is sliced out of the real docs/js/app.js (it can't load in Node), the colours
// are read from the real docs/css/style.css.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'docs', 'css', 'style.css'), 'utf8');
const a = appSrc.indexOf('const STATUS_RANK = {');
const b = appSrc.indexOf('function rosterCodeClass(code)');
if (a < 0 || b < a) throw new Error('could not locate the status-order code in app.js');
const sb = {};
vm.createContext(sb);
vm.runInContext(appSrc.slice(a, b), sb);
const rosterClass = vm.runInNewContext(appSrc.slice(b, appSrc.indexOf('// Multi-employee weekly grid')) + '; rosterCodeClass');

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(x, y, msg) { if (JSON.stringify(x) !== JSON.stringify(y)) throw new Error((msg || '') + ' expected ' + JSON.stringify(y) + ' got ' + JSON.stringify(x)); }
const people = (statuses) => statuses.map((s, i) => ({ name: 'p' + i, status: s }));
const order = (statuses) => sb.sortByStatus_(people(statuses)).map((e) => e.status);

t('the requested order: present/working, Work From Home, Week Off, Half Day, Holiday, Leave, Unpaid Leave', () => {
  const shuffled = ['UP', 'Holiday', 'L', 'WO', 'Half Day', 'WFH', 'Present', 'Working', 'UP', 'L'];
  assertEq(order(shuffled), ['Working', 'Present', 'WFH', 'WO', 'Half Day', 'Holiday', 'L', 'L', 'UP', 'UP']);
});

t('everyone at work (working, present, on a break, late, planned-present) sits ahead of Work From Home', () => {
  const out = order(['WFH', 'P', 'Late', 'Bio Break', 'Tea Break', 'Lunch Break', 'Present', 'Working']);
  // the three kinds of break share one rank, so they keep the order received
  assertEq(out, ['Working', 'Present', 'Bio Break', 'Tea Break', 'Lunch Break', 'Late', 'P', 'WFH']);
});

t('Half Day is one rank whether it arrives as the Daily Log word or the Roster code', () => {
  assertEq(sb.statusRank_('Half Day'), sb.statusRank_('HD'));
  assertEq(order(['HD', 'WO', 'Half Day']), ['WO', 'HD', 'Half Day'], 'keeps the server order between the two');
});

t('anything unrecognised (Not Started, Absent, a raw shift like "10 - 7") goes last, in the order received', () => {
  const out = order(['Not Started', 'UP', '10 - 7', 'Absent', 'Working']);
  assertEq(out, ['Working', 'UP', 'Not Started', '10 - 7', 'Absent']);
});

t('rows with the same status keep the order the server sent them (no reshuffle on every poll)', () => {
  const list = [{ name: 'a', status: 'Working' }, { name: 'b', status: 'WO' }, { name: 'c', status: 'Working' }, { name: 'd', status: 'WO' }];
  assertEq(sb.sortByStatus_(list).map((e) => e.name), ['a', 'c', 'b', 'd']);
});

t('sorting never mutates the list it is given', () => {
  const list = people(['L', 'Working']);
  const before = JSON.stringify(list);
  sb.sortByStatus_(list);
  assertEq(JSON.stringify(list), before);
});

t('both tables use this same function — there is no second, different order left in the code', () => {
  assertEq((appSrc.match(/employees: sortByStatus_\(/g) || []).length, 2, 'Team Status and Day End Report');
  assertEq(/sortByDayEndStatus_|DAY_END_SORT_RANK|STATUS_SORT_RANK/.test(appSrc), false);
});

t('the Day End Report status is a coloured pill like Team Status, so Leave / Unpaid Leave show up there too', () => {
  const reportRow = appSrc.slice(appSrc.indexOf('DAY_REPORT.employees.forEach'), appSrc.indexOf('DAY_REPORT.employees.forEach') + 400);
  assertEq(reportRow.indexOf('status-pill') > -1 && reportRow.indexOf('statusPillClass_(e.status)') > -1, true);
});

t('status pill class names: spaces dropped, codes kept', () => {
  assertEq([sb.statusPillClass_('Half Day'), sb.statusPillClass_('L'), sb.statusPillClass_('UP'), sb.statusPillClass_('Not Started')], ['st-HalfDay', 'st-L', 'st-UP', 'st-NotStarted']);
});

// ---- neon red ----
const rule = (selector) => {
  const i = css.indexOf(selector + '{');
  if (i < 0) throw new Error('no CSS rule for ' + selector);
  return css.slice(i, css.indexOf('}', i));
};
t('Leave and Unpaid Leave are neon red in the roster grid and its legend (rc-L covers both codes)', () => {
  assertEq(rosterClass('L'), 'rc-L');
  assertEq(rosterClass('UP'), 'rc-L');
  const r = rule('.rc-L');
  assertEq(r.indexOf('var(--neon)') > -1 && r.indexOf('var(--neon-text)') > -1 && r.indexOf('var(--neon-glow)') > -1, true);
});
t('Leave and Unpaid Leave are neon red as status pills and row stripes too', () => {
  const r = rule('.st-L,.st-UP');
  assertEq(r.indexOf('var(--neon)') > -1 && r.indexOf('var(--neon-glow)') > -1, true);
  assertEq(rule('.team-row:has(.st-L),.team-row:has(.st-UP)').indexOf('var(--neon)') > -1, true);
});
t('Work From Home is no longer lumped in with Leave: it stays blue', () => {
  assertEq(rule('.rc-WFH').indexOf('var(--blue-bg)') > -1 && rule('.rc-WFH').indexOf('neon'), -1);
  assertEq(rule('.st-WFH').indexOf('var(--blue-bg)') > -1, true);
});
t('the neon colours are defined for the dark theme and again, readable, for the light theme', () => {
  assertEq(/:root\{[^}]*--neon:#ff1f4b[^}]*--neon-text:#ff5a78/.test(css), true, 'dark');
  assertEq(/:root\[data-theme="light"\]\{[^}]*--neon-text:#e0002e/.test(css), true, 'light');
});

console.log('done');

const { computeDayState, validTransition, deriveSummary, haversineMeters } = require('../src/dayState');

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

const base = new Date('2026-08-19T00:00:00');
const at = (h, m) => new Date(base.getFullYear(), base.getMonth(), base.getDate(), h, m);

t('not_started -> PUNCH_IN valid, others invalid', () => {
  assertEq(validTransition('not_started', null, 'PUNCH_IN'), true);
  assertEq(validTransition('not_started', null, 'PUNCH_OUT'), false);
  assertEq(validTransition('not_started', null, 'LUNCH_START'), false);
});

t('working -> can start any break or punch out, not punch in again', () => {
  assertEq(validTransition('working', null, 'PUNCH_IN'), false);
  assertEq(validTransition('working', null, 'LUNCH_START'), true);
  assertEq(validTransition('working', null, 'TEA_START'), true);
  assertEq(validTransition('working', null, 'BIO_START'), true);
  assertEq(validTransition('working', null, 'PUNCH_OUT'), true);
});

t('on_break -> only matching END valid, not punch out', () => {
  assertEq(validTransition('on_break', 'LUNCH', 'LUNCH_END'), true);
  assertEq(validTransition('on_break', 'LUNCH', 'TEA_END'), false);
  assertEq(validTransition('on_break', 'LUNCH', 'PUNCH_OUT'), false);
  assertEq(validTransition('on_break', 'LUNCH', 'TEA_START'), false);
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
  const state = computeDayState(events);
  assertEq(state.phase, 'completed');
  assertEq(state.breakTotals.LUNCH, 30);
  assertEq(state.breakTotals.TEA, 10);
  assertEq(state.breakTotals.BIO, 5);

  const summary = deriveSummary(state, 'P', '09:30', 15);
  // gross = 18:35 - 09:28 = 9h07m = 9.1166... -> rounds to 9.12
  assertEq(summary.gross, 9.12);
  // net = gross - totalBreak(45min=0.75h) = 8.37 (rounded)
  assertEq(summary.net, 8.37);
  assertEq(summary.status, 'Present'); // on-time (within 15 min grace), net>=4
});

t('late punch-in flagged Late after punch-out', () => {
  const events = [
    { type: 'PUNCH_IN', timestamp: at(9, 52) }, // 22 min late vs 09:30 shift start
    { type: 'PUNCH_OUT', timestamp: at(18, 40) },
  ];
  const state = computeDayState(events);
  const summary = deriveSummary(state, 'P', '09:30', 15);
  assertEq(summary.status, 'Late');
  assertEq(summary.lateBy, 22);
});

t('lateBy is consistent before and after punch-out (grace-gated both times)', () => {
  const graceMinutes = 15;
  // 5 min late, inside the 15-min grace — should read 0 the whole day, not
  // just after punch-out.
  const midDay = computeDayState([{ type: 'PUNCH_IN', timestamp: at(9, 35) }]);
  const midDaySummary = deriveSummary(midDay, 'P', '09:30', graceMinutes);
  assertEq(midDaySummary.lateBy, 0);
  assertEq(midDaySummary.status, 'Working');

  const doneDay = computeDayState([
    { type: 'PUNCH_IN', timestamp: at(9, 35) },
    { type: 'PUNCH_OUT', timestamp: at(18, 35) },
  ]);
  const doneDaySummary = deriveSummary(doneDay, 'P', '09:30', graceMinutes);
  assertEq(doneDaySummary.lateBy, 0);
  assertEq(doneDaySummary.status, 'Present');
});

t('short day flagged Half Day even if on time', () => {
  const events = [
    { type: 'PUNCH_IN', timestamp: at(10, 5) },
    { type: 'PUNCH_OUT', timestamp: at(13, 20) },
  ];
  const state = computeDayState(events);
  const summary = deriveSummary(state, 'P', '10:00', 15);
  assertEq(summary.status, 'Half Day');
});

t('mid-day status while on break shows break label, roster fallback before punch-in', () => {
  const notStarted = computeDayState([]);
  const s1 = deriveSummary(notStarted, 'WO', '09:30', 15);
  assertEq(s1.status, 'WO');

  const onBreak = computeDayState([
    { type: 'PUNCH_IN', timestamp: at(9, 30) },
    { type: 'TEA_START', timestamp: at(11, 0) },
  ]);
  const s2 = deriveSummary(onBreak, 'P', '09:30', 15);
  assertEq(s2.status, 'Tea Break');
});

t('haversine roughly correct for a small known offset (~157m for 0.001 lat delta at 28.4N... just sanity check ordering)', () => {
  const d1 = haversineMeters(28.44844645, 77.04104379, 28.44844645, 77.04104379);
  assertEq(d1, 0);
  const d2 = haversineMeters(28.44844645, 77.04104379, 28.4494, 77.0420);
  if (!(d2 > 0 && d2 < 500)) throw new Error('distance out of expected small range: ' + d2);
});

console.log('done');

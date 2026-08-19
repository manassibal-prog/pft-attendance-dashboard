process.env.TIMEZONE = 'Asia/Kolkata';
const { toDateOnlyString, toDateTimeString, parseDateTimeString, ymd } = require('../src/dateFmt');

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ` expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

t('09:28:03 IST formats unambiguously (day-MMM-year, not day/month numeric)', () => {
  // 2026-08-19T03:58:03Z == 09:28:03 IST (UTC+5:30)
  const d = new Date('2026-08-19T03:58:03.000Z');
  assertEq(toDateTimeString(d), '19/Aug/2026 09:28:03');
  assertEq(toDateOnlyString(d), '19/Aug/2026');
});

t('round-trips through the exact text Sheets would store, back to the same instant', () => {
  const original = new Date('2026-08-19T03:58:03.000Z');
  const text = toDateTimeString(original);
  const parsed = parseDateTimeString(text);
  assertEq(parsed.getTime(), original.getTime());
});

t('date-only string parses to local midnight IST, not UTC midnight', () => {
  const parsed = parseDateTimeString('19/Aug/2026');
  // local midnight IST 19-Aug-2026 == 2026-08-18T18:30:00Z
  assertEq(parsed.toISOString(), '2026-08-18T18:30:00.000Z');
});

t('a day/month value that would be ambiguous under naive Date parsing still round-trips correctly (day=08, month=Sep)', () => {
  const original = new Date(Date.UTC(2026, 8, 8, 4, 0, 0)); // Sep 8, 2026, 09:30 IST
  const text = toDateTimeString(original);
  assertEq(text, '08/Sep/2026 09:30:00');
  const parsed = parseDateTimeString(text);
  assertEq(parsed.getTime(), original.getTime());
});

t('ymd is stable and matches the date-only string\'s date', () => {
  const d = new Date('2026-08-19T20:00:00.000Z'); // 20:00 UTC = 01:30 IST next day
  assertEq(ymd(d), '2026-08-20');
});

console.log('done');

// The advisor's "Leave Requests" card in docs/js/app.js: the click-to-select
// calendar, how the card renders, and how submit / cancel / load behave.
// Sliced out of the real file and run in a vm with a scripted api(), since
// app.js can't load in Node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
function slice(from, to) {
  const a = appSrc.indexOf(from), b = appSrc.indexOf(to, a);
  if (a < 0 || b < a) throw new Error('could not locate ' + from + ' .. ' + to);
  return appSrc.slice(a, b);
}
const cardSrc = slice('const LEAVE_TYPES', 'function renderTeam() {');
const classSrc = slice('function rosterCodeClass(code)', '// Multi-employee weekly grid');

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const flush = function () { return new Promise(function (r) { setImmediate(r); }); };
const count = (html, re) => (html.match(re) || []).length;

function makeEnv(over) {
  const env = { renders: 0, apiCalls: [], pending: [], cacheWrites: [], ids: 0 };
  const sandbox = Object.assign({
    LEAVE: null, LEAVE_BAL: null, LEAVE_ERROR: null, LEAVE_BUSY: false, LEAVE_MSG: null, LEAVE_DRAFT: { dates: [], type: 'L', note: '' }, LEAVE_CAL: null,
    CURRENT: { email: 'a@wiom.in' },
    renderMe: function () { env.renders++; },
    newRequestId_: function () { return 'rid-' + (++env.ids); },
    cacheSet: function (e, n, v) { env.cacheWrites.push([e, n, JSON.parse(JSON.stringify(v))]); },
    api: function (params) {
      env.apiCalls.push(params);
      return new Promise(function (resolve, reject) { env.pending.push({ resolve: resolve, reject: reject }); });
    },
    document: { getElementById: function () { return null; }, querySelectorAll: function () { return []; } }
  }, over || {});
  vm.createContext(sandbox);
  vm.runInContext(classSrc + '\n' + cardSrc, sandbox);
  env.sb = sandbox;
  env.settle = async function (how, v) { env.pending.shift()[how](v); await flush(); };
  return env;
}
const req = (o) => Object.assign({ id: 'r1', date: '2026-11-05', code: 'L', type: 'Leave', note: '', status: 'Pending', submittedAt: '2026-11-01T05:00:00.000Z' }, o || {});
// A day offset from today, in the same local terms the app uses.
const day = (sb, n) => sb.dayOffsetKey_(n);
// The enabled / disabled day buttons in the rendered calendar.
const dayButtons = (html) => (html.match(/<button type="button" class="cal-day[^"]*" data-cal-day="[^"]+"[^>]*>\d+<\/button>/g) || []);
const keyOf = (btn) => /data-cal-day="([^"]+)"/.exec(btn)[1];

(async function () {
  // ---------- the calendar ----------
  await t('a month is laid out Monday-first with the right number of days and blank cells (Nov 2026 starts on a Sunday)', async function () {
    const sb = makeEnv().sb;
    const weeks = sb.monthWeeks_(2026, 10);
    assertEq(weeks[0].map((k) => k === null ? null : 'd'), [null, null, null, null, null, null, 'd'], 'six blanks, then Sunday the 1st');
    assertEq(weeks[0][6], '2026-11-01');
    assertEq(weeks.flat().filter(Boolean).length, 30);
    assertEq(weeks.every((w) => w.length === 7), true);
    assertEq(sb.monthWeeks_(2028, 1).flat().filter(Boolean).length, 29, 'leap February');
  });

  await t('the calendar shows the month, Mo–Su headers, and a button per day', async function () {
    const env = makeEnv();
    const html = env.sb.renderLeaveCalendar_();
    const now = new Date();
    assertEq(html.indexOf(new Date(now.getFullYear(), now.getMonth(), 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })) > -1, true);
    ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].forEach((w) => assertEq(html.indexOf('>' + w + '<') > -1, true, w));
    assertEq(dayButtons(html).length, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
  });

  await t('days outside the allowed window (7 back … 180 ahead) cannot be clicked; the others can', async function () {
    const env = makeEnv();
    const sb = env.sb;
    const win = sb.leaveWindow_();
    assertEq([win.min, win.max], [day(sb, -7), day(sb, 180)]);
    // look at a month that straddles the lower edge
    const lowEdge = new Date(); lowEdge.setDate(lowEdge.getDate() - 7);
    sb.LEAVE_CAL = { y: lowEdge.getFullYear(), m: lowEdge.getMonth() };
    dayButtons(sb.renderLeaveCalendar_()).forEach((btn) => {
      const k = keyOf(btn);
      const disabled = /disabled/.test(btn);
      assertEq(disabled, k < win.min || k > win.max, k);
    });
  });

  await t('previous / next month are disabled once the window ends (no browsing into the past or far future)', async function () {
    const sb = makeEnv().sb;
    const now = new Date();
    // this month: next is open; previous only if the 7-day lookback reaches into last month
    const prevOpen = sb.dayOffsetKey_(-7) < sb.ymd_(new Date(now.getFullYear(), now.getMonth(), 1));
    let html = sb.renderLeaveCalendar_();
    assertEq(/data-cal-nav="1"[^>]*disabled/.test(html), false);
    assertEq(/data-cal-nav="-1"[^>]*disabled/.test(html), !prevOpen);
    // 7 months ahead is beyond 180 days: its next button is shut
    sb.LEAVE_CAL = { y: new Date(now.getFullYear(), now.getMonth() + 7, 1).getFullYear(), m: new Date(now.getFullYear(), now.getMonth() + 7, 1).getMonth() };
    html = sb.renderLeaveCalendar_();
    assertEq(/data-cal-nav="1"[^>]*disabled/.test(html), true);
    // three months back: previous is shut
    sb.LEAVE_CAL = { y: new Date(now.getFullYear(), now.getMonth() - 3, 1).getFullYear(), m: new Date(now.getFullYear(), now.getMonth() - 3, 1).getMonth() };
    assertEq(/data-cal-nav="-1"[^>]*disabled/.test(sb.renderLeaveCalendar_()), true);
  });

  await t('paging months moves forwards and backwards across a year end', async function () {
    const sb = makeEnv().sb;
    sb.LEAVE_CAL = { y: 2026, m: 11 };
    sb.shiftLeaveMonth_(1);
    assertEq(sb.LEAVE_CAL, { y: 2027, m: 0 });
    sb.shiftLeaveMonth_(-1);
    assertEq(sb.LEAVE_CAL, { y: 2026, m: 11 });
  });

  await t('clicking days selects them; clicking a selected day unselects it; the list stays sorted', async function () {
    const env = makeEnv();
    const sb = env.sb;
    const [a, b, c] = [day(sb, 12), day(sb, 10), day(sb, 11)];
    sb.toggleLeaveDay_(a); sb.toggleLeaveDay_(b); sb.toggleLeaveDay_(c);
    assertEq(sb.LEAVE_DRAFT.dates, [b, c, a].sort());
    sb.toggleLeaveDay_(c);
    assertEq(sb.LEAVE_DRAFT.dates, [b, a].sort());
    assertEq(env.renders, 4, 'redrawn after every click');
  });

  await t('selected days are highlighted and announced as pressed; today is ringed', async function () {
    const sb = makeEnv().sb;
    const pick = day(sb, 3);
    sb.LEAVE_CAL = { y: Number(pick.slice(0, 4)), m: Number(pick.slice(5, 7)) - 1 };
    sb.toggleLeaveDay_(pick);
    const html = sb.renderLeaveCalendar_();
    const btn = dayButtons(html).filter((b) => keyOf(b) === pick)[0];
    assertEq(/cal-sel/.test(btn) && /aria-pressed="true"/.test(btn), true);
    assertEq(count(html, /cal-sel/g), 1);
    assertEq(count(html, /cal-today/g) <= 1, true);
  });

  await t('days outside the window cannot be selected even by a stray click', async function () {
    const sb = makeEnv().sb;
    sb.toggleLeaveDay_(day(sb, -8));
    sb.toggleLeaveDay_(day(sb, 181));
    assertEq(sb.LEAVE_DRAFT.dates, []);
  });

  await t('a day that already has a Pending or Approved request is greyed out with the reason, and cannot be picked', async function () {
    const sb = makeEnv().sb;
    const booked = day(sb, 4), free = day(sb, 5);
    sb.LEAVE = [req({ id: 'a', date: booked, status: 'Pending', type: 'Half Day', code: 'HD' }), req({ id: 'b', date: free, status: 'Rejected' })];
    sb.LEAVE_CAL = { y: Number(booked.slice(0, 4)), m: Number(booked.slice(5, 7)) - 1 };
    const html = sb.renderLeaveCalendar_();
    const bookedBtn = dayButtons(html).filter((b) => keyOf(b) === booked)[0];
    assertEq(/disabled/.test(bookedBtn) && /cal-booked/.test(bookedBtn) && /title="Already requested: Half Day \(Pending\)"/.test(bookedBtn), true);
    const freeBtn = dayButtons(html).filter((b) => keyOf(b) === free)[0];
    assertEq(/disabled/.test(freeBtn), false, 'a Rejected request does not block the day');
    sb.toggleLeaveDay_(booked);
    assertEq(sb.LEAVE_DRAFT.dates, []);
  });

  await t('at most 31 days at once: the 32nd click is refused with a message and nothing changes', async function () {
    const sb = makeEnv().sb;
    for (let i = 1; i <= 31; i++) sb.toggleLeaveDay_(day(sb, i));
    assertEq(sb.LEAVE_DRAFT.dates.length, 31);
    sb.toggleLeaveDay_(day(sb, 40));
    assertEq(sb.LEAVE_DRAFT.dates.length, 31);
    assertEq(sb.LEAVE_MSG, { kind: 'err', text: 'You can select up to 31 days at a time.' });
    sb.toggleLeaveDay_(day(sb, 1));          // unselecting still works at the cap
    assertEq(sb.LEAVE_DRAFT.dates.length, 30);
    assertEq(sb.LEAVE_MSG, null);
  });

  await t('the picked days appear as removable chips, with Clear all; with none picked there is a hint instead', async function () {
    const sb = makeEnv().sb;
    assertEq(sb.renderLeaveSelection_().indexOf('Click the days you need') > -1, true);
    const [a, b] = [day(sb, 3), day(sb, 4)];
    sb.LEAVE_DRAFT.dates = [a, b];
    const html = sb.renderLeaveSelection_();
    assertEq(count(html, /class="cal-chip"/g), 2);
    assertEq(html.indexOf('data-cal-remove="' + a + '"') > -1 && html.indexOf('id="leaveClear"') > -1, true);
    sb.toggleLeaveDay_(a);                   // what the chip's × does
    assertEq(sb.LEAVE_DRAFT.dates, [b]);
  });

  await t('the Submit button counts the days, and is off until at least one is picked', async function () {
    const sb = makeEnv().sb;
    assertEq(/id="leaveSubmit" type="button" disabled>Submit</.test(sb.renderLeaveCard_()), true);
    sb.LEAVE_DRAFT.dates = [day(sb, 3)];
    assertEq(sb.renderLeaveCard_().indexOf('id="leaveSubmit" type="button">Submit 1 day<') > -1, true);
    sb.LEAVE_DRAFT.dates = [day(sb, 3), day(sb, 4), day(sb, 5)];
    assertEq(sb.renderLeaveCard_().indexOf('Submit 3 days<') > -1, true);
  });

  // ---------- the rest of the card ----------
  await t('loading: shows Loading… before the list arrives, but the calendar and form are already usable', async function () {
    const html = makeEnv().sb.renderLeaveCard_();
    assertEq(html.indexOf('<h1>Leave Requests</h1>') > -1 && html.indexOf('Loading…') > -1, true);
    assertEq(html.indexOf('Half Day</h1>'), -1, 'the old heading is gone');
    assertEq(html.indexOf('class="cal"') > -1 && html.indexOf('id="leaveType"') > -1 && html.indexOf('id="leaveNote"') > -1, true);
  });

  await t('the type list offers exactly Leave and Half Day', async function () {
    const html = makeEnv().sb.renderLeaveCard_();
    const options = (html.match(/<option value="([A-Z]+)"[^>]*>([^<]+)</g) || []).map((o) => o.replace(/<option value="([A-Z]+)"[^>]*>([^<]+)</, '$1=$2'));
    assertEq(options, ['L=Leave', 'HD=Half Day']);
    assertEq(/Unpaid|Week Off|Work From Home/i.test(html), false, 'no other kind is offered or mentioned on the card');
  });

  await t('there is no single-date box any more', async function () {
    assertEq(makeEnv().sb.renderLeaveCard_().indexOf('type="date"'), -1);
  });

  await t('empty list: a friendly prompt, no table', async function () {
    const html = makeEnv({ LEAVE: [] }).sb.renderLeaveCard_();
    assertEq(html.indexOf('No requests yet') > -1 && html.indexOf('<table') === -1, true);
  });

  await t('a list shows date, type pill (Leave / Unpaid Leave use the neon class — older rows of retired types still draw), note and status; only Pending has Cancel', async function () {
    const html = makeEnv({ LEAVE: [
      req({ id: 'a', code: 'L', type: 'Leave', status: 'Pending', note: 'fever' }),
      req({ id: 'b', code: 'UP', type: 'Unpaid Leave', status: 'Approved', date: '2026-11-04' }),
      req({ id: 'c', code: 'HD', type: 'Half Day', status: 'Rejected', date: '2026-11-03' }),
      req({ id: 'd', code: 'WO', type: 'Week Off', status: 'Cancelled', date: '2026-11-02' })
    ] }).sb.renderLeaveCard_();
    assertEq(html.indexOf('<span class="rc rc-L">Leave</span>') > -1 && html.indexOf('<span class="rc rc-L">Unpaid Leave</span>') > -1, true, 'neon class');
    assertEq(html.indexOf('<span class="rc rc-HD">Half Day</span>') > -1 && html.indexOf('<span class="rc rc-WO">Week Off</span>') > -1, true);
    ['Pending', 'Approved', 'Rejected', 'Cancelled'].forEach((s) => assertEq(html.indexOf('status-pill st-' + s) > -1, true, s));
    assertEq(count(html, /data-cancel-leave=/g), 1);
    assertEq(html.indexOf('fever') > -1, true);
  });

  await t('notes and ids are escaped — HTML in a note can never run', async function () {
    const html = makeEnv({ LEAVE: [req({ id: 'x"><img src=x onerror=alert(1)>', note: '<img src=x onerror=alert(1)>' })] }).sb.renderLeaveCard_();
    assertEq(html.indexOf('<img') === -1 && html.indexOf('&lt;img') > -1 && html.indexOf('"><img') === -1, true);
  });

  await t('a half-typed form survives a re-render: type, note and picked days are what is drawn', async function () {
    const sb = makeEnv({ LEAVE_DRAFT: { dates: [], type: 'HD', note: 'dent "ist"' } }).sb;
    const pick = day(sb, 3);
    sb.LEAVE_CAL = { y: Number(pick.slice(0, 4)), m: Number(pick.slice(5, 7)) - 1 };
    sb.LEAVE_DRAFT.dates = [pick];
    const html = sb.renderLeaveCard_();
    assertEq(html.indexOf('<option value="HD" selected>') > -1 && html.indexOf('value="dent &quot;ist&quot;"') > -1, true);
    assertEq(html.indexOf('cal-sel') > -1 && html.indexOf('data-cal-remove="' + pick + '"') > -1, true);
  });

  await t('while saving, the button is disabled and says so', async function () {
    const sb = makeEnv({ LEAVE_BUSY: true, LEAVE: [] }).sb;
    sb.LEAVE_DRAFT.dates = [day(sb, 3)];
    assertEq(sb.renderLeaveCard_().indexOf('id="leaveSubmit" type="button" disabled>Saving…') > -1, true);
  });

  await t('dates are drawn from their parts, never shifted by a timezone', async function () {
    const sb = makeEnv().sb;
    assertEq(sb.fmtLeaveDate_('2026-11-01'), new Date(2026, 10, 1).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
    assertEq(sb.fmtLeaveDate_('garbage'), 'garbage');
  });

  await t('the list is always newest date first, and an updated request replaces itself', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'a', date: '2026-11-03' }), req({ id: 'b', date: '2026-11-01' })] });
    env.sb.upsertLeave_(req({ id: 'c', date: '2026-11-09' }));
    env.sb.upsertLeave_(req({ id: 'b', date: '2026-11-01', status: 'Cancelled' }));
    assertEq(env.sb.LEAVE.map((r) => r.id), ['c', 'a', 'b']);
    assertEq(env.sb.LEAVE.filter((r) => r.id === 'b')[0].status, 'Cancelled');
  });

  // ---- submit ----
  await t('submit with no day picked: tells the person, sends nothing', async function () {
    const env = makeEnv();
    env.sb.submitLeave_();
    assertEq(env.apiCalls.length, 0);
    assertEq(env.sb.LEAVE_MSG, { kind: 'err', text: 'Click at least one day on the calendar first.' });
  });

  await t('submit sends every picked day in one request, with a requestId, locks the card, then lists them all', async function () {
    const env = makeEnv({ LEAVE: [] });
    const [a, b, c] = [day(env.sb, 10), day(env.sb, 11), day(env.sb, 14)];
    env.sb.LEAVE_DRAFT = { dates: [a, b, c], type: 'HD', note: 'dentist' };
    env.sb.submitLeave_();
    assertEq(env.sb.LEAVE_BUSY, true);
    assertEq(env.apiCalls.length, 1, 'one request, not one per day');
    assertEq(env.apiCalls[0], { action: 'submitLeave', email: 'a@wiom.in', dates: [a, b, c].join(','), type: 'HD', note: 'dentist', requestId: 'rid-1' });
    await env.settle('resolve', { success: true, requests: [a, b, c].map((d, i) => req({ id: 'rid-1#' + (i + 1), date: d, code: 'HD', type: 'Half Day', note: 'dentist' })) });
    assertEq(env.sb.LEAVE_BUSY, false);
    assertEq(env.sb.LEAVE.length, 3);
    assertEq(env.sb.LEAVE_DRAFT, { dates: [], type: 'HD', note: '' }, 'form cleared for the next one, type kept');
    assertEq(env.sb.LEAVE_MSG, { kind: 'ok', text: 'Submitted 3 days. They stay Pending until your team lead approves them.' });
    assertEq(env.cacheWrites.length, 1);
    assertEq(env.cacheWrites[0][2].length, 3);
  });

  await t('one day: the single-day wording, and an older server reply (just `request`) still works', async function () {
    const env = makeEnv({ LEAVE: [] });
    const d = day(env.sb, 5);
    env.sb.LEAVE_DRAFT = { dates: [d], type: 'L', note: '' };
    env.sb.submitLeave_();
    await env.settle('resolve', { success: true, request: req({ id: 'rid-1', date: d }) });
    assertEq(env.sb.LEAVE.map((r) => r.id), ['rid-1']);
    assertEq(env.sb.LEAVE_MSG, { kind: 'ok', text: 'Submitted. It stays Pending until your team lead approves it.' });
  });

  await t('a retried submit that was already saved says so, for one day or several', async function () {
    const env = makeEnv({ LEAVE: [] });
    env.sb.LEAVE_DRAFT = { dates: [day(env.sb, 5), day(env.sb, 6)], type: 'L', note: '' };
    env.sb.submitLeave_();
    await env.settle('resolve', { success: true, duplicate: true, requests: [req({ id: 'x#1' }), req({ id: 'x#2', date: '2026-11-06' })] });
    assertEq(env.sb.LEAVE_MSG.text, 'Already submitted — those days are in the list below.');
  });

  await t('a second tap on Submit while one is saving does nothing', async function () {
    const env = makeEnv({ LEAVE: [] });
    env.sb.LEAVE_DRAFT = { dates: [day(env.sb, 5)], type: 'L', note: '' };
    env.sb.submitLeave_();
    env.sb.submitLeave_();
    assertEq(env.apiCalls.length, 1);
  });

  await t('the server refusing it (e.g. a day already requested) shows its reason and KEEPS the picked days', async function () {
    const env = makeEnv({ LEAVE: [] });
    const picked = [day(env.sb, 5), day(env.sb, 6)];
    env.sb.LEAVE_DRAFT = { dates: picked, type: 'L', note: 'x' };
    env.sb.submitLeave_();
    await env.settle('resolve', { success: false, message: 'You already have Leave on ' + picked[0] + ' (Pending). Cancel it first to change it.' });
    assertEq(env.sb.LEAVE_MSG.kind, 'err');
    assertEq(env.sb.LEAVE_DRAFT.dates, picked);
    assertEq(env.sb.LEAVE.length, 0);
  });

  await t('no answer at all: says it may or may not be saved, unlocks the card, and re-reads the real list', async function () {
    const env = makeEnv({ LEAVE: [] });
    env.sb.LEAVE_DRAFT = { dates: [day(env.sb, 5)], type: 'L', note: '' };
    env.sb.submitLeave_();
    await env.settle('reject', new Error('Server busy — please wait a moment and try again.'));
    assertEq(env.sb.LEAVE_BUSY, false);
    assertEq(env.sb.LEAVE_MSG.text.indexOf('Server busy') > -1 && env.sb.LEAVE_MSG.text.indexOf('whether it was saved') > -1, true);
    assertEq(env.apiCalls[1].action, 'getMyLeave', 'refreshes from the server instead of guessing');
  });

  // ---- cancel ----
  await t('cancel marks the request Cancelled in the list and confirms', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'a' })] });
    env.sb.cancelLeave_('a');
    assertEq(env.apiCalls[0], { action: 'cancelLeave', email: 'a@wiom.in', id: 'a', requestId: 'rid-1' });
    await env.settle('resolve', { success: true, request: req({ id: 'a', status: 'Cancelled' }) });
    assertEq(env.sb.LEAVE[0].status, 'Cancelled');
    assertEq(env.sb.LEAVE_MSG, { kind: 'ok', text: 'Request cancelled.' });
  });

  await t('a day of a multi-day request can be cancelled on its own (its id carries a # that must survive)', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'grp#1' }), req({ id: 'grp#2', date: '2026-11-06' })] });
    const html = env.sb.renderLeaveCard_();
    assertEq(html.indexOf('data-cancel-leave="grp#2"') > -1, true);
    env.sb.cancelLeave_('grp#2');
    assertEq(env.apiCalls[0].id, 'grp#2');
  });

  await t('a refused cancel (already approved) shows the reason and leaves the list alone', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'a', status: 'Approved' })] });
    env.sb.cancelLeave_('a');
    await env.settle('resolve', { success: false, message: 'Only a pending request can be cancelled.' });
    assertEq(env.sb.LEAVE[0].status, 'Approved');
    assertEq(env.sb.LEAVE_MSG.kind, 'err');
  });

  // ---- load ----
  await t('loading the list: newest first, saved for next time', async function () {
    const env = makeEnv();
    const p = env.sb.loadLeave_();
    assertEq(env.apiCalls[0], { action: 'getMyLeave', email: 'a@wiom.in' });
    await env.settle('resolve', { requests: [req({ id: 'old', date: '2026-10-01' }), req({ id: 'new', date: '2026-12-01' })] });
    await p;
    assertEq(env.sb.LEAVE.map((r) => r.id), ['new', 'old']);
    assertEq(env.cacheWrites[0][1], 'leave');
  });

  await t('a failed load with nothing on screen shows the error with a Try again button', async function () {
    const env = makeEnv();
    const p = env.sb.loadLeave_();
    await env.settle('reject', new Error('API request failed (404)'));
    await p;
    const html = env.sb.renderLeaveCard_();
    assertEq(env.sb.LEAVE_ERROR, 'API request failed (404)');
    assertEq(html.indexOf('API request failed (404)') > -1 && html.indexOf('id="leaveRetry"') > -1, true);
  });

  await t('a failed refresh when a saved list is already showing keeps that list, no error banner', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'a' })] });
    const p = env.sb.loadLeave_();
    await env.settle('reject', new Error('API request failed (404)'));
    await p;
    assertEq(env.sb.LEAVE_ERROR, null);
    assertEq(env.sb.LEAVE.length, 1);
  });

  console.log('done');
})();

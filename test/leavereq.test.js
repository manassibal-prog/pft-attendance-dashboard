// The team lead's "Leave Requests" card in docs/js/app.js: a submitted request of
// several days is ONE line, with one Approve / Reject; days can be opened out and
// decided one by one. Sliced out of the real file and run in a vm with a scripted
// api() (app.js can't load in Node).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
function slice(from, to) {
  const a = appSrc.indexOf(from), b = appSrc.indexOf(to, a);
  if (a < 0 || b < a) throw new Error('could not locate ' + from + ' .. ' + to);
  return appSrc.slice(a, b);
}
const code = slice('function rosterCodeClass(code)', '// Multi-employee weekly grid') + '\n' + slice('const LEAVE_TYPES', 'function renderTeam() {');

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const flush = function () { return new Promise(function (r) { setImmediate(r); }); };

function makeEnv(over) {
  const env = { renders: 0, apiCalls: [], pending: [], cacheWrites: [], rosterLoads: 0, ids: 0 };
  const sandbox = Object.assign({
    LEAVE_REQS: null, LEAVE_REQS_ERROR: null, LEAVE_REQS_BUSY: false, LEAVE_REQS_MSG: null, LEAVE_REQS_OPEN: {},
    CURRENT: { email: 'lead@wiom.in' },
    renderTeam: function () { env.renders++; },
    loadTeamRoster: function () { env.rosterLoads++; },
    newRequestId_: function () { return 'rid-' + (++env.ids); },
    cacheSet: function (e, n, v) { env.cacheWrites.push([e, n, JSON.parse(JSON.stringify(v))]); },
    api: function (params) {
      env.apiCalls.push(params);
      return new Promise(function (resolve, reject) { env.pending.push({ resolve: resolve, reject: reject }); });
    },
    document: { getElementById: function () { return null; }, querySelectorAll: function () { return []; } }
  }, over || {});
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  env.sb = sandbox;
  env.settle = async function (how, v) { env.pending.shift()[how](v); await flush(); };
  return env;
}
const req = (o) => Object.assign({ id: 'r1', empId: 'E1', name: 'Asha', date: '2026-11-05', code: 'L', type: 'Leave', note: '', status: 'Pending', submittedAt: '2026-11-01T05:00:00.000Z', decidedBy: '', decidedAt: '' }, o || {});
const count = (html, re) => (html.match(re) || []).length;
// n consecutive days from a start date, as one submitted request "base" (ids base#1 … base#n)
function run(base, who, empId, from, n, over) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(2026, 10, 1 + (from - 1) + i);   // from = day of Nov 2026
    const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    out.push(req(Object.assign({ id: n > 1 ? base + '#' + (i + 1) : base, name: who, empId: empId, date: key }, over || {})));
  }
  return out;
}

(async function () {
  // ---------- grouping ----------
  await t('the days of one submitted request become one group, in date order, with their ids', async function () {
    const sb = makeEnv().sb;
    const rows = run('a', 'Pintoo', 'E4', 28, 3).reverse();      // fed in scrambled order
    const g = sb.groupLeaveRequests_(rows);
    assertEq(g.length, 1);
    assertEq([g[0].name, g[0].dates, g[0].ids], ['Pintoo', ['2026-11-28', '2026-11-29', '2026-11-30'], ['a#1', 'a#2', 'a#3']]);
  });

  await t('separate requests stay separate: two different submits, two different advisors, or a plain single-day row', async function () {
    const sb = makeEnv().sb;
    const rows = [].concat(run('a', 'Pintoo', 'E4', 2, 2), run('b', 'Pintoo', 'E4', 9, 2), run('c', 'Nirmal', 'E7', 2, 2), run('solo', 'Amar', 'E2', 20, 1));
    assertEq(sb.groupLeaveRequests_(rows).map((g) => [g.name, g.rows.length]).sort(), [['Amar', 1], ['Nirmal', 2], ['Pintoo', 2], ['Pintoo', 2]]);
  });

  await t('days of one request that are in different states are separate lines (e.g. one day was cancelled)', async function () {
    const sb = makeEnv().sb;
    const rows = run('a', 'Pintoo', 'E4', 2, 3);
    rows[1].status = 'Cancelled';
    const g = sb.groupLeaveRequests_(rows);
    assertEq(g.map((x) => [x.status, x.dates.length]).sort(), [['Cancelled', 1], ['Pending', 2]]);
  });

  await t('ordering: pending first (soonest first), then decided (latest first)', async function () {
    const sb = makeEnv().sb;
    const rows = [].concat(
      run('old', 'Old', 'E1', 1, 2, { status: 'Approved' }), run('far', 'Far', 'E2', 20, 2), run('new', 'New', 'E3', 12, 3, { status: 'Rejected' }), run('soon', 'Soon', 'E4', 3, 2));
    assertEq(sb.groupLeaveRequests_(rows).map((g) => g.name), ['Soon', 'Far', 'New', 'Old']);
  });

  await t('consecutive days compress into ranges; a gap, a month end and a leap day are all handled', async function () {
    const sb = makeEnv().sb;
    assertEq(sb.leaveRanges_(['2026-11-27', '2026-11-28', '2026-12-01']), [['2026-11-27', '2026-11-28'], ['2026-12-01', '2026-12-01']]);
    assertEq(sb.leaveRanges_(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']), [['2026-12-30', '2027-01-02']]);
    assertEq(sb.leaveRanges_(['2028-02-28', '2028-02-29', '2028-03-01']), [['2028-02-28', '2028-03-01']]);
    assertEq(sb.leaveRanges_(['2026-11-05']), [['2026-11-05', '2026-11-05']]);
    assertEq(sb.nextDayKey_('2026-12-31'), '2027-01-01');
  });

  await t('the date text shows a range once, not every day', async function () {
    const sb = makeEnv().sb;
    const one = sb.fmtLeaveDate_('2026-11-28'), two = sb.fmtLeaveDate_('2026-12-05');
    assertEq(sb.fmtLeaveRanges_(['2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05']), one + ' – ' + two);
    assertEq(sb.fmtLeaveRanges_(['2026-11-28']), one);
  });

  // ---------- rendering ----------
  await t('loading, empty and error states', async function () {
    assertEq(makeEnv().sb.renderLeaveRequestsCard_().indexOf('Loading…') > -1, true);
    assertEq(makeEnv({ LEAVE_REQS: [] }).sb.renderLeaveRequestsCard_().indexOf('No leave requests right now.') > -1, true);
    const err = makeEnv({ LEAVE_REQS_ERROR: 'API request failed (404)' }).sb.renderLeaveRequestsCard_();
    assertEq(err.indexOf('API request failed (404)') > -1 && err.indexOf('id="leaveReqRetry"') > -1, true);
  });

  await t('THE SCREENSHOT CASE: Pintoo\'s eight days and Nirmal\'s two are two lines with two Approve buttons — not ten rows', async function () {
    const rows = [].concat(run('p', 'Pintoo', 'E4', 28, 8), run('n', 'Nirmal', 'E7', 27, 2, { note: 'Marriage' }));
    const html = makeEnv({ LEAVE_REQS: rows }).sb.renderLeaveRequestsCard_();
    assertEq(count(html, /<tr class="leave-group"/g), 2);
    assertEq(count(html, /data-decision="Approved"/g), 2);
    assertEq(count(html, /data-decision="Rejected"/g), 2);
    assertEq(html.indexOf('8 days') > -1 && html.indexOf('2 days') > -1, true);
    assertEq(html.indexOf('Approve all') > -1 && html.indexOf('Reject all') > -1, true);
    assertEq(count(html, /<tr class="leave-day"/g), 0, 'the individual days stay tucked away');
  });

  await t('the heading counts requests waiting, not days', async function () {
    const rows = [].concat(run('p', 'Pintoo', 'E4', 28, 8), run('n', 'Nirmal', 'E7', 27, 2), run('d', 'Done', 'E9', 1, 3, { status: 'Approved' }));
    assertEq(makeEnv({ LEAVE_REQS: rows }).sb.renderLeaveRequestsCard_().indexOf('<span class="count-badge">2 pending</span>') > -1, true);
    assertEq(makeEnv({ LEAVE_REQS: run('d', 'Done', 'E9', 1, 3, { status: 'Approved' }) }).sb.renderLeaveRequestsCard_().indexOf('count-badge'), -1);
  });

  await t('a multi-day line decides all its days: its button carries every id', async function () {
    const html = makeEnv({ LEAVE_REQS: run('p', 'Pintoo', 'E4', 28, 3) }).sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('data-decide="p#1,p#2,p#3" data-decision="Approved"') > -1, true);
    assertEq(html.indexOf('data-decide="p#1,p#2,p#3" data-decision="Rejected"') > -1, true);
  });

  await t('a single-day request looks as before: plain Approve / Reject, no "all", no days toggle', async function () {
    const html = makeEnv({ LEAVE_REQS: [req({ id: 'one' })] }).sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('>Approve<') > -1 && html.indexOf('>Reject<') > -1, true);
    assertEq(html.indexOf('Approve all'), -1);
    assertEq(html.indexOf('data-leave-toggle'), -1);
    assertEq(html.indexOf('1 days'), -1);
  });

  await t('decided lines offer Reopen (all); cancelled ones offer nothing', async function () {
    const html = makeEnv({ LEAVE_REQS: [].concat(
      run('a', 'Amar', 'E2', 2, 3, { status: 'Approved', decidedBy: 'Priya' }), run('b', 'Ben', 'E3', 9, 1, { status: 'Rejected' }), run('c', 'Cy', 'E5', 15, 2, { status: 'Cancelled' })) }).sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('Reopen all') > -1 && html.indexOf('>Reopen<') > -1, true);
    assertEq(count(html, /data-decision="Pending"/g), 2);
    assertEq(html.indexOf('data-decide="c#'), -1);
    assertEq(html.indexOf('by Priya') > -1, true);
  });

  await t('"Show days" opens a multi-day line out to its individual days, each with its own buttons', async function () {
    const env = makeEnv({ LEAVE_REQS: run('p', 'Pintoo', 'E4', 28, 3) });
    const key = env.sb.groupLeaveRequests_(env.sb.LEAVE_REQS)[0].key;
    assertEq(env.sb.renderLeaveRequestsCard_().indexOf('Show days') > -1, true);
    env.sb.LEAVE_REQS_OPEN = { [key]: true };
    const html = env.sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('Hide days') > -1 && /aria-expanded="true"/.test(html), true);
    assertEq(count(html, /<tr class="leave-day"/g), 3);
    assertEq(html.indexOf('data-decide="p#2" data-decision="Approved"') > -1, true, 'a single day can be decided on its own');
  });

  await t('names, notes and ids are escaped — nothing an advisor types can run', async function () {
    const html = makeEnv({ LEAVE_REQS: [req({ id: 'x"><b>', name: '<img src=x onerror=alert(1)>', note: '<script>alert(1)</script>' })] }).sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('<img') === -1 && html.indexOf('<script') === -1 && html.indexOf('"><b>') === -1, true);
  });

  await t('while a decision is saving every button is disabled', async function () {
    const html = makeEnv({ LEAVE_REQS_BUSY: true, LEAVE_REQS: [].concat(run('p', 'P', 'E4', 2, 3), run('a', 'A', 'E2', 20, 2, { status: 'Approved' })) }).sb.renderLeaveRequestsCard_();
    assertEq(count(html, /<button class="leave-(approve|reject|cancel)"[^>]* disabled>/g), 3);
  });

  // ---------- clicking ----------
  await t('clicking a line\'s Approve sends all its ids; the "days" toggle flips and redraws', async function () {
    const clicks = {};
    const mk = (attrs) => ({ getAttribute: (k) => attrs[k], addEventListener: (ev, fn) => { clicks[attrs['data-decide'] || attrs['data-leave-toggle']] = fn; } });
    const env = makeEnv({
      LEAVE_REQS: run('p', 'Pintoo', 'E4', 28, 3),
      document: { getElementById: () => null, querySelectorAll: (sel) => sel === '[data-decide]' ? [mk({ 'data-decide': 'p#1,p#2,p#3', 'data-decision': 'Approved' })] : sel === '[data-leave-toggle]' ? [mk({ 'data-leave-toggle': 'k1' })] : [] }
    });
    env.sb.wireLeaveRequests_();
    clicks['p#1,p#2,p#3']();
    assertEq(env.apiCalls[0].ids, 'p#1,p#2,p#3');
    clicks['k1']();
    assertEq(env.sb.LEAVE_REQS_OPEN, { k1: true });
    clicks['k1']();
    assertEq(env.sb.LEAVE_REQS_OPEN, { k1: false });
  });

  // ---------- deciding ----------
  await t('Approve on a multi-day line: one request with every id, locks the card, updates every day, refreshes the roster grid', async function () {
    const env = makeEnv({ LEAVE_REQS: [].concat(run('p', 'Pintoo', 'E4', 28, 3), run('b', 'Ben', 'E3', 9, 1)) });
    env.sb.decideLeave_(['p#1', 'p#2', 'p#3'], 'Approved');
    assertEq(env.sb.LEAVE_REQS_BUSY, true);
    assertEq(env.apiCalls.length, 1, 'one request for the whole line');
    assertEq(env.apiCalls[0], { action: 'decideLeave', email: 'lead@wiom.in', ids: 'p#1,p#2,p#3', decision: 'Approved', requestId: 'rid-1' });
    await env.settle('resolve', { success: true, changed: 3, skipped: 0, requests: run('p', 'Pintoo', 'E4', 28, 3, { status: 'Approved', decidedBy: 'Priya' }) });
    assertEq(env.sb.LEAVE_REQS_BUSY, false);
    assertEq(env.sb.LEAVE_REQS.filter((r) => r.status === 'Approved').length, 3);
    assertEq(env.sb.LEAVE_REQS.filter((r) => r.id === 'b')[0].status, 'Pending', 'someone else\'s request untouched');
    assertEq(env.sb.LEAVE_REQS_MSG.kind, 'ok');
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Approved Pintoo’s Leave for 3 days (') === 0, true, env.sb.LEAVE_REQS_MSG.text);
    assertEq(env.rosterLoads, 1);
    assertEq(env.cacheWrites[0][1], 'leavereqs');
  });

  await t('a single day still works as before, with the single-day wording', async function () {
    const env = makeEnv({ LEAVE_REQS: [req({ id: 'a' })] });
    env.sb.decideLeave_('a', 'Rejected');                       // a plain id is accepted too
    assertEq(env.apiCalls[0].ids, 'a');
    await env.settle('resolve', { success: true, request: req({ id: 'a', status: 'Rejected', decidedBy: 'Priya' }) });
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Rejected Asha’s Leave on ') === 0, true);
  });

  await t('Reopen wording; and days the advisor cancelled meanwhile are reported, not hidden', async function () {
    const env = makeEnv({ LEAVE_REQS: run('p', 'Pintoo', 'E4', 2, 3, { status: 'Approved' }) });
    env.sb.decideLeave_(['p#1', 'p#2', 'p#3'], 'Pending');
    await env.settle('resolve', { success: true, changed: 2, skipped: 1, requests: run('p', 'Pintoo', 'E4', 2, 2, { status: 'Pending' }) });
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Reopened Pintoo') === 0, true);
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('1 day was skipped — the advisor cancelled it.') > -1, true);
  });

  await t('a second click while one is saving does nothing', async function () {
    const env = makeEnv({ LEAVE_REQS: [].concat(run('a', 'A', 'E1', 2, 2), run('b', 'B', 'E2', 9, 2)) });
    env.sb.decideLeave_(['a#1', 'a#2'], 'Approved');
    env.sb.decideLeave_(['b#1', 'b#2'], 'Approved');
    assertEq(env.apiCalls.length, 1);
  });

  await t('the server refusing (e.g. the advisor just cancelled everything) shows its reason and leaves the list alone', async function () {
    const env = makeEnv({ LEAVE_REQS: run('a', 'A', 'E1', 2, 2) });
    env.sb.decideLeave_(['a#1', 'a#2'], 'Approved');
    await env.settle('resolve', { success: false, message: 'The advisor cancelled this request, so there is nothing to decide.' });
    assertEq(env.sb.LEAVE_REQS.every((r) => r.status === 'Pending'), true);
    assertEq(env.sb.LEAVE_REQS_MSG, { kind: 'err', text: 'The advisor cancelled this request, so there is nothing to decide.' });
    assertEq(env.rosterLoads, 0);
  });

  await t('no answer at all: says so, unlocks the card, and re-reads the real list instead of guessing', async function () {
    const env = makeEnv({ LEAVE_REQS: run('a', 'A', 'E1', 2, 2) });
    env.sb.decideLeave_(['a#1', 'a#2'], 'Approved');
    await env.settle('reject', new Error('Server busy — please wait a moment and try again.'));
    assertEq(env.sb.LEAVE_REQS_BUSY, false);
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Server busy') > -1 && env.sb.LEAVE_REQS_MSG.text.indexOf('whether it went through') > -1, true);
    assertEq(env.apiCalls[1].action, 'getLeaveRequests');
    assertEq(env.sb.LEAVE_REQS.every((r) => r.status === 'Pending'), true, 'nothing shown as decided that is not confirmed');
  });

  // ---------- loading ----------
  await t('loading the list: ordered, and saved for next time', async function () {
    const env = makeEnv();
    const p = env.sb.loadLeaveRequests_();
    assertEq(env.apiCalls[0], { action: 'getLeaveRequests', email: 'lead@wiom.in' });
    await env.settle('resolve', { requests: [req({ id: 'd', status: 'Approved', date: '2026-11-01' }), req({ id: 'p', date: '2026-11-08' })] });
    await p;
    assertEq(env.sb.LEAVE_REQS.map((r) => r.id), ['p', 'd']);
    assertEq(env.cacheWrites[0][1], 'leavereqs');
  });

  await t('a failed load shows the error only when there is nothing else on the card; a saved list stays', async function () {
    const empty = makeEnv();
    const p1 = empty.sb.loadLeaveRequests_();
    await empty.settle('reject', new Error('API request failed (404)'));
    await p1;
    assertEq(empty.sb.LEAVE_REQS_ERROR, 'API request failed (404)');
    const saved = makeEnv({ LEAVE_REQS: [req({ id: 'a' })] });
    const p2 = saved.sb.loadLeaveRequests_();
    await saved.settle('reject', new Error('API request failed (404)'));
    await p2;
    assertEq(saved.sb.LEAVE_REQS_ERROR, null);
    assertEq(saved.sb.LEAVE_REQS.length, 1);
  });

  // ---------- wiring into the manager screen ----------
  await t('the card sits between the Day End Report and Recent Activity, is wired up, and is fetched with the poll', async function () {
    const team = appSrc.slice(appSrc.indexOf('function renderTeam() {'));
    const day = team.indexOf('Day End Report</h1>'), leave = team.indexOf('renderLeaveRequestsCard_()'), recent = team.indexOf('Recent Activity</h1>');
    assertEq(day > 0 && day < leave && leave < recent, true);
    assertEq(team.indexOf('wireLeaveRequests_();') > -1, true);
    assertEq(/leaveReqPollCount\+\+ % 9 === 0\) jobs\.push\(loadLeaveRequests_\(\)\)/.test(appSrc), true);
  });

  console.log('done');
})();

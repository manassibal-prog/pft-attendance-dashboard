// The team lead's "Leave Requests" card in docs/js/app.js: how it renders and
// how approve / reject / reopen / load behave. Sliced out of the real file and
// run in a vm with a scripted api() (app.js can't load in Node).
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
    LEAVE_REQS: null, LEAVE_REQS_ERROR: null, LEAVE_REQS_BUSY: false, LEAVE_REQS_MSG: null,
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

(async function () {
  await t('loading, empty and error states', async function () {
    assertEq(makeEnv().sb.renderLeaveRequestsCard_().indexOf('Loading…') > -1, true);
    assertEq(makeEnv({ LEAVE_REQS: [] }).sb.renderLeaveRequestsCard_().indexOf('No leave requests right now.') > -1, true);
    const err = makeEnv({ LEAVE_REQS_ERROR: 'API request failed (404)' }).sb.renderLeaveRequestsCard_();
    assertEq(err.indexOf('API request failed (404)') > -1 && err.indexOf('id="leaveReqRetry"') > -1, true);
  });

  await t('the heading counts what is waiting, and says nothing when nothing is', async function () {
    const two = makeEnv({ LEAVE_REQS: [req({ id: 'a' }), req({ id: 'b' }), req({ id: 'c', status: 'Approved' })] }).sb.renderLeaveRequestsCard_();
    assertEq(two.indexOf('<span class="count-badge">2 pending</span>') > -1, true);
    const none = makeEnv({ LEAVE_REQS: [req({ status: 'Approved' })] }).sb.renderLeaveRequestsCard_();
    assertEq(none.indexOf('count-badge'), -1);
  });

  await t('Pending rows get Approve + Reject; Approved/Rejected get Reopen; Cancelled get nothing', async function () {
    const html = makeEnv({ LEAVE_REQS: [
      req({ id: 'p', status: 'Pending' }), req({ id: 'a', status: 'Approved', decidedBy: 'Priya' }),
      req({ id: 'j', status: 'Rejected', decidedBy: 'Raj' }), req({ id: 'c', status: 'Cancelled' })
    ] }).sb.renderLeaveRequestsCard_();
    assertEq(count(html, /data-decision="Approved"/g), 1);
    assertEq(count(html, /data-decision="Rejected"/g), 1);
    assertEq(count(html, /data-decision="Pending"/g), 2);
    assertEq(html.indexOf('data-decide="p" data-decision="Approved"') > -1 && html.indexOf('data-decide="p" data-decision="Rejected"') > -1, true);
    assertEq(html.indexOf('data-decide="c"'), -1, 'nothing to do on a cancelled request');
  });

  await t('shows who asked, the day, the type pill (Leave / Unpaid Leave neon via rc-L), the note, and who decided', async function () {
    const html = makeEnv({ LEAVE_REQS: [
      req({ id: 'a', name: 'Asha', code: 'UP', type: 'Unpaid Leave', note: 'family', status: 'Approved', decidedBy: 'Priya' }),
      req({ id: 'b', name: 'Ben', code: 'WFH', type: 'Work From Home', status: 'Pending' })
    ] }).sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('>Asha<') > -1 && html.indexOf('>Ben<') > -1, true);
    assertEq(html.indexOf('<span class="rc rc-L">Unpaid Leave</span>') > -1 && html.indexOf('<span class="rc rc-WFH">Work From Home</span>') > -1, true);
    assertEq(html.indexOf('by Priya') > -1, true);
    assertEq(html.indexOf('family') > -1, true);
  });

  await t('names, notes and ids are escaped — nothing an advisor types can run', async function () {
    const html = makeEnv({ LEAVE_REQS: [req({ id: 'x"><b>', name: '<img src=x onerror=alert(1)>', note: '<script>alert(1)</script>' })] }).sb.renderLeaveRequestsCard_();
    assertEq(html.indexOf('<img') === -1 && html.indexOf('<script') === -1 && html.indexOf('"><b>') === -1, true);
    assertEq(html.indexOf('&lt;img') > -1 && html.indexOf('&lt;script') > -1, true);
  });

  await t('while a decision is saving every button is disabled', async function () {
    const html = makeEnv({ LEAVE_REQS_BUSY: true, LEAVE_REQS: [req({ id: 'p' }), req({ id: 'a', status: 'Approved' })] }).sb.renderLeaveRequestsCard_();
    assertEq(count(html, /<button class="leave-(approve|reject|cancel)"[^>]* disabled>/g), 3);
  });

  await t('ordering: pending first (soonest day first), then decided (newest day first)', async function () {
    const sb = makeEnv().sb;
    const out = sb.sortLeaveRequests_([
      req({ id: 'dOld', date: '2026-10-01', status: 'Approved' }), req({ id: 'pLate', date: '2026-11-20' }),
      req({ id: 'dNew', date: '2026-11-02', status: 'Rejected' }), req({ id: 'pSoon', date: '2026-11-03' })
    ]);
    assertEq(out.map((r) => r.id), ['pSoon', 'pLate', 'dNew', 'dOld']);
  });

  // ---- deciding ----
  await t('Approve sends the decision with a requestId, locks the card, then updates the row and refreshes the roster grid', async function () {
    const env = makeEnv({ LEAVE_REQS: [req({ id: 'a' }), req({ id: 'b', name: 'Ben', date: '2026-11-09' })] });
    env.sb.decideLeave_('a', 'Approved');
    assertEq(env.sb.LEAVE_REQS_BUSY, true);
    assertEq(env.apiCalls[0], { action: 'decideLeave', email: 'lead@wiom.in', id: 'a', decision: 'Approved', requestId: 'rid-1' });
    await env.settle('resolve', { success: true, request: req({ id: 'a', status: 'Approved', decidedBy: 'Priya' }) });
    assertEq(env.sb.LEAVE_REQS_BUSY, false);
    assertEq(env.sb.LEAVE_REQS.map((r) => [r.id, r.status]), [['b', 'Pending'], ['a', 'Approved']], 'the decided row moves below the pending one');
    assertEq(env.sb.LEAVE_REQS_MSG.kind, 'ok');
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Approved Asha’s Leave on ') === 0, true);
    assertEq(env.rosterLoads, 1, 'the grid is re-fetched so the approval shows straight away');
    assertEq(env.cacheWrites[0][1], 'leavereqs');
  });

  await t('Reject and Reopen word their confirmation correctly', async function () {
    const env = makeEnv({ LEAVE_REQS: [req({ id: 'a' })] });
    env.sb.decideLeave_('a', 'Rejected');
    await env.settle('resolve', { success: true, request: req({ id: 'a', status: 'Rejected', decidedBy: 'Priya' }) });
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Rejected Asha') === 0, true);
    env.sb.decideLeave_('a', 'Pending');
    await env.settle('resolve', { success: true, request: req({ id: 'a', status: 'Pending' }) });
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Reopened Asha') === 0, true);
  });

  await t('a second click while one is saving does nothing', async function () {
    const env = makeEnv({ LEAVE_REQS: [req({ id: 'a' }), req({ id: 'b' })] });
    env.sb.decideLeave_('a', 'Approved');
    env.sb.decideLeave_('b', 'Approved');
    assertEq(env.apiCalls.length, 1);
  });

  await t('the server refusing (e.g. the advisor just cancelled) shows its reason and leaves the list alone', async function () {
    const env = makeEnv({ LEAVE_REQS: [req({ id: 'a' })] });
    env.sb.decideLeave_('a', 'Approved');
    await env.settle('resolve', { success: false, message: 'The advisor cancelled this request, so there is nothing to decide.' });
    assertEq(env.sb.LEAVE_REQS[0].status, 'Pending');
    assertEq(env.sb.LEAVE_REQS_MSG, { kind: 'err', text: 'The advisor cancelled this request, so there is nothing to decide.' });
    assertEq(env.rosterLoads, 0);
  });

  await t('no answer at all: says so, unlocks the card, and re-reads the real list instead of guessing', async function () {
    const env = makeEnv({ LEAVE_REQS: [req({ id: 'a' })] });
    env.sb.decideLeave_('a', 'Approved');
    await env.settle('reject', new Error('Server busy — please wait a moment and try again.'));
    assertEq(env.sb.LEAVE_REQS_BUSY, false);
    assertEq(env.sb.LEAVE_REQS_MSG.text.indexOf('Server busy') > -1 && env.sb.LEAVE_REQS_MSG.text.indexOf('whether it went through') > -1, true);
    assertEq(env.apiCalls[1].action, 'getLeaveRequests');
    assertEq(env.sb.LEAVE_REQS[0].status, 'Pending', 'nothing is shown as decided that is not confirmed');
  });

  // ---- loading ----
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

  // ---- wiring into the manager screen ----
  await t('the card sits between the Day End Report and Recent Activity, is wired up, and is fetched with the poll', async function () {
    const team = appSrc.slice(appSrc.indexOf('function renderTeam() {'));
    const day = team.indexOf('Day End Report</h1>'), leave = team.indexOf('renderLeaveRequestsCard_()'), recent = team.indexOf('Recent Activity</h1>');
    assertEq(day > 0 && day < leave && leave < recent, true);
    assertEq(team.indexOf('wireLeaveRequests_();') > -1, true);
    assertEq(/leaveReqPollCount\+\+ % 9 === 0\) jobs\.push\(loadLeaveRequests_\(\)\)/.test(appSrc), true);
  });

  console.log('done');
})();

// The advisor's "Leave & Half Day" card in docs/js/app.js: how it renders and
// how submit / cancel / load behave. Sliced out of the real file and run in a
// vm with a scripted api(), since app.js can't load in Node.
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

function makeEnv(over) {
  const env = { renders: 0, apiCalls: [], pending: [], cacheWrites: [], ids: 0 };
  const sandbox = Object.assign({
    LEAVE: null, LEAVE_ERROR: null, LEAVE_BUSY: false, LEAVE_MSG: null, LEAVE_DRAFT: { date: '', type: 'L', note: '' },
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

(async function () {
  await t('loading: shows Loading… before the list arrives, but the form is already usable', async function () {
    const html = makeEnv().sb.renderLeaveCard_();
    assertEq(html.indexOf('Leave &amp; Half Day') > -1 && html.indexOf('Loading…') > -1, true);
    assertEq(html.indexOf('id="leaveSubmit"') > -1 && html.indexOf('id="leaveDate"') > -1 && html.indexOf('id="leaveType"') > -1, true);
  });

  await t('the type list offers exactly Leave, Half Day, Unpaid Leave, Work From Home, Week Off', async function () {
    const html = makeEnv().sb.renderLeaveCard_();
    const options = (html.match(/<option value="([A-Z]+)"[^>]*>([^<]+)</g) || []).map((o) => o.replace(/<option value="([A-Z]+)"[^>]*>([^<]+)</, '$1=$2'));
    assertEq(options, ['L=Leave', 'HD=Half Day', 'UP=Unpaid Leave', 'WFH=Work From Home', 'WO=Week Off']);
  });

  await t('the date picker only allows 7 days back to 180 days ahead (same window the server enforces)', async function () {
    const sb = makeEnv().sb;
    const html = sb.renderLeaveCard_();
    assertEq(html.indexOf('min="' + sb.dayOffsetKey_(-7) + '"') > -1 && html.indexOf('max="' + sb.dayOffsetKey_(180) + '"') > -1, true);
  });

  await t('empty list: a friendly prompt, no table', async function () {
    const env = makeEnv({ LEAVE: [] });
    const html = env.sb.renderLeaveCard_();
    assertEq(html.indexOf('No requests yet') > -1 && html.indexOf('<table') === -1, true);
  });

  await t('a list shows date, type pill (Leave / Unpaid Leave use the neon class), note and status; only Pending has Cancel', async function () {
    const env = makeEnv({ LEAVE: [
      req({ id: 'a', code: 'L', type: 'Leave', status: 'Pending', note: 'fever' }),
      req({ id: 'b', code: 'UP', type: 'Unpaid Leave', status: 'Approved', date: '2026-11-04' }),
      req({ id: 'c', code: 'HD', type: 'Half Day', status: 'Rejected', date: '2026-11-03' }),
      req({ id: 'd', code: 'WFH', type: 'Work From Home', status: 'Cancelled', date: '2026-11-02' })
    ] });
    const html = env.sb.renderLeaveCard_();
    assertEq(html.indexOf('<span class="rc rc-L">Leave</span>') > -1 && html.indexOf('<span class="rc rc-L">Unpaid Leave</span>') > -1, true, 'neon class');
    assertEq(html.indexOf('<span class="rc rc-HD">Half Day</span>') > -1 && html.indexOf('<span class="rc rc-WFH">Work From Home</span>') > -1, true);
    ['Pending', 'Approved', 'Rejected', 'Cancelled'].forEach((s) => assertEq(html.indexOf('status-pill st-' + s) > -1, true, s));
    assertEq((html.match(/data-cancel-leave=/g) || []).length, 1);
    assertEq(html.indexOf('data-cancel-leave="a"') > -1, true);
    assertEq(html.indexOf('fever') > -1, true);
  });

  await t('notes and ids are escaped — HTML in a note can never run', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'x"><img src=x onerror=alert(1)>', note: '<img src=x onerror=alert(1)>' })] });
    const html = env.sb.renderLeaveCard_();
    assertEq(html.indexOf('<img') === -1 && html.indexOf('&lt;img') > -1, true);
    assertEq(html.indexOf('"><img') === -1, true);
  });

  await t('a half-typed form survives a re-render (the draft is what is drawn)', async function () {
    const env = makeEnv({ LEAVE_DRAFT: { date: '2026-11-09', type: 'HD', note: 'dent "ist"' } });
    const html = env.sb.renderLeaveCard_();
    assertEq(html.indexOf('value="2026-11-09"') > -1 && html.indexOf('<option value="HD" selected>') > -1 && html.indexOf('value="dent &quot;ist&quot;"') > -1, true);
  });

  await t('while saving, the button is disabled and says so', async function () {
    const html = makeEnv({ LEAVE_BUSY: true, LEAVE: [] }).sb.renderLeaveCard_();
    assertEq(html.indexOf('id="leaveSubmit" type="button" disabled>Saving…') > -1, true);
  });

  await t('dates are drawn from their parts, never shifted by a timezone', async function () {
    const sb = makeEnv().sb;
    assertEq(sb.fmtLeaveDate_('2026-11-01'), new Date(2026, 10, 1).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }));
    assertEq(sb.fmtLeaveDate_('garbage'), 'garbage');
  });

  await t('the list is always newest date first, and a re-submitted/updated request replaces itself', async function () {
    const env = makeEnv({ LEAVE: [req({ id: 'a', date: '2026-11-03' }), req({ id: 'b', date: '2026-11-01' })] });
    env.sb.upsertLeave_(req({ id: 'c', date: '2026-11-09' }));
    env.sb.upsertLeave_(req({ id: 'b', date: '2026-11-01', status: 'Cancelled' }));
    assertEq(env.sb.LEAVE.map((r) => r.id), ['c', 'a', 'b']);
    assertEq(env.sb.LEAVE.filter((r) => r.id === 'b')[0].status, 'Cancelled');
  });

  // ---- submit ----
  await t('submit with no date: tells the person, sends nothing', async function () {
    const env = makeEnv();
    env.sb.submitLeave_();
    assertEq(env.apiCalls.length, 0);
    assertEq(env.sb.LEAVE_MSG, { kind: 'err', text: 'Pick a date first.' });
  });

  await t('submit sends the draft with a requestId, locks the card while saving, then lists the new request', async function () {
    const env = makeEnv({ LEAVE_DRAFT: { date: '2026-11-09', type: 'HD', note: 'dentist' }, LEAVE: [] });
    env.sb.submitLeave_();
    assertEq(env.sb.LEAVE_BUSY, true);
    assertEq(env.apiCalls[0], { action: 'submitLeave', email: 'a@wiom.in', date: '2026-11-09', type: 'HD', note: 'dentist', requestId: 'rid-1' });
    await env.settle('resolve', { success: true, request: req({ id: 'rid-1', date: '2026-11-09', code: 'HD', type: 'Half Day', note: 'dentist' }) });
    assertEq(env.sb.LEAVE_BUSY, false);
    assertEq(env.sb.LEAVE.map((r) => r.id), ['rid-1']);
    assertEq(env.sb.LEAVE_DRAFT, { date: '', type: 'HD', note: '' }, 'form cleared for the next one, type kept');
    assertEq(env.sb.LEAVE_MSG.kind, 'ok');
    assertEq(env.cacheWrites.length, 1);
    assertEq(env.cacheWrites[0][1], 'leave');
  });

  await t('a second tap on Submit while one is saving does nothing', async function () {
    const env = makeEnv({ LEAVE_DRAFT: { date: '2026-11-09', type: 'L', note: '' }, LEAVE: [] });
    env.sb.submitLeave_();
    env.sb.submitLeave_();
    assertEq(env.apiCalls.length, 1);
  });

  await t('the server refusing it (e.g. already requested that day) shows its reason and keeps what was typed', async function () {
    const env = makeEnv({ LEAVE_DRAFT: { date: '2026-11-09', type: 'L', note: 'x' }, LEAVE: [] });
    env.sb.submitLeave_();
    await env.settle('resolve', { success: false, message: 'You already have Leave on 2026-11-09 (Pending). Cancel it first to change it.' });
    assertEq(env.sb.LEAVE_MSG, { kind: 'err', text: 'You already have Leave on 2026-11-09 (Pending). Cancel it first to change it.' });
    assertEq(env.sb.LEAVE_DRAFT.date, '2026-11-09');
    assertEq(env.sb.LEAVE.length, 0);
  });

  await t('no answer at all: says it may or may not be saved, unlocks the card, and re-reads the real list', async function () {
    const env = makeEnv({ LEAVE_DRAFT: { date: '2026-11-09', type: 'L', note: '' }, LEAVE: [] });
    env.sb.submitLeave_();
    await env.settle('reject', new Error('Server busy — please wait a moment and try again.'));
    assertEq(env.sb.LEAVE_BUSY, false);
    assertEq(env.sb.LEAVE_MSG.kind, 'err');
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
    assertEq(env.sb.LEAVE_BUSY, false);
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
    assertEq(env.sb.LEAVE_ERROR, 'API request failed (404)');
    const html = env.sb.renderLeaveCard_();
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

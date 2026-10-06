// Exercises, from the real docs/js/app.js source (sliced out and run in a vm —
// app.js itself can't load in Node because it imports Firebase from a CDN):
//   * predictState_  — the optimistic result of a tap, checked against the
//                      server's own computeDayState_ from Code.gs
//   * onAction       — optimistic apply, confirm, rollback, double-tap guard
//   * hydrateFromCache_ / reportCacheValid_ / resetSessionData_
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
function slice(startMarker, endMarker) {
  const a = appSrc.indexOf(startMarker);
  const b = appSrc.indexOf(endMarker, a);
  if (a < 0 || b < a) throw new Error('could not locate ' + startMarker + ' .. ' + endMarker + ' in app.js');
  return appSrc.slice(a, b);
}
const actionSrc = slice('function predictState_', "// Leaving mid-save");
const hydrateSrc = slice('function resetSessionData_', '// Stale-while-revalidate sign-in');

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const flush = function () { return new Promise(function (r) { setImmediate(r); }); };
const clone = function (x) { return JSON.parse(JSON.stringify(x)); };

// Same shape as freshState_() in app.js — read from there so they can't drift.
const freshState = vm.runInNewContext(appSrc.slice(appSrc.indexOf('function freshState_()'), appSrc.indexOf('let STATE = freshState_()')) + '; freshState_');

// ---- the server's own state engine, for the parity test ----
const server = {
  console, SpreadsheetApp: {}, Session: { getScriptTimeZone: function () { return 'Asia/Kolkata'; } }, Utilities: {}, LockService: {}, HtmlService: {}
};
vm.createContext(server);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), server);

function actionEnv() {
  const env = { renders: [], pending: [], apiCalls: [], refreshCalls: [], cacheWrites: [], msg: { innerHTML: '' } };
  const sandbox = {
    STATE: freshState(), ACTION_IN_FLIGHT: false, STATE_LOADED: true, STATE_LOAD_ERROR: null, STATE_PENDING_NOTE: null, STATE_RECHECK: null,
    CURRENT: { email: 'a@wiom.in' }, LAST_LOC: { lat: 28.44, lng: 77.04 },
    isMobileOrTablet_: function () { return false; },
    renderMe: function () { env.renders.push({ state: clone(sandbox.STATE), inFlight: sandbox.ACTION_IN_FLIGHT }); },
    refreshDayState: function (a, b) { env.refreshCalls.push([a, b]); },
    cacheSet: function (email, name, v) { env.cacheWrites.push([email, name, clone(v)]); },
    document: { getElementById: function (id) { return id === 'msg' ? env.msg : null; } },
    api: function (params) {
      env.apiCalls.push(params);
      return new Promise(function (resolve, reject) { env.pending.push({ resolve: resolve, reject: reject }); });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(actionSrc, sandbox);
  env.sb = sandbox;
  env.settle = async function (how, v) { env.pending.shift()[how](v); await flush(); };
  return env;
}

(async function () {
  // ---------- predictState_ ----------
  await t('predictState_ matches the server\'s computeDayState_ across a full day (in, 3 breaks, out)', async function () {
    const base = new Date(2026, 9, 5, 10, 0, 0).getTime();
    const seq = [['PUNCH_IN', 0], ['LUNCH_START', 120], ['LUNCH_END', 150], ['TEA_START', 200], ['TEA_END', 215], ['BIO_START', 300], ['BIO_END', 305], ['LUNCH_START', 400], ['LUNCH_END', 430], ['PUNCH_OUT', 520]]
      .map(function (p) { return { type: p[0], at: new Date(base + p[1] * 60000) }; });
    const env = actionEnv(); // its sandbox has predictState_
    const events = [];
    let predicted = freshState();
    for (const step of seq) {
      predicted = env.sb.predictState_(predicted, step.type, step.at);
      events.push({ type: step.type, timestamp: step.at });
      const truth = JSON.parse(JSON.stringify(vm.runInContext('serializeState_', server)(vm.runInContext('computeDayState_', server)(events))));
      const shared = {};
      Object.keys(truth).forEach(function (k) { shared[k] = predicted[k]; });
      assertEq(shared, truth, 'after ' + step.type + ':');
    }
  });

  await t('predictState_ does not mutate the state it was given (rollback depends on that)', async function () {
    const env = actionEnv();
    const before = freshState();
    const snapshot = clone(before);
    env.sb.predictState_(before, 'PUNCH_IN', new Date());
    assertEq(before, snapshot);
  });

  // ---------- onAction ----------
  await t('a tap shows its result immediately, before the server has answered', async function () {
    const env = actionEnv();
    env.sb.onAction('PUNCH_IN');
    assertEq(env.sb.STATE.phase, 'working');
    assertEq(env.sb.ACTION_IN_FLIGHT, true);
    assertEq(env.renders.length, 1);
    assertEq(env.renders[0].inFlight, true);
    assertEq(env.apiCalls.length, 1);
    assertEq(env.apiCalls[0].action, 'recordEvent');
    assertEq(env.apiCalls[0].type, 'PUNCH_IN');
    assertEq(env.apiCalls[0].device, 'desktop');
  });

  await t('server confirms: server state replaces the guess, is saved, and "Recorded" is shown', async function () {
    const env = actionEnv();
    env.sb.onAction('PUNCH_IN');
    const serverState = { phase: 'working', breakType: null, punchIn: '2026-10-05T04:31:09.000Z', punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, breakStartedAt: null };
    await env.settle('resolve', { success: true, time: '10:01:09 AM', state: serverState, rosterCode: 'P', requiresGeofence: true });
    assertEq(env.sb.ACTION_IN_FLIGHT, false);
    assertEq(env.sb.STATE.punchIn, '2026-10-05T04:31:09.000Z', 'server timestamp wins over the local guess');
    assertEq(env.sb.STATE.rosterCode, 'P');
    assertEq(env.cacheWrites.length, 1);
    assertEq(env.cacheWrites[0][1], 'daystate');
    assertEq(env.msg.innerHTML.indexOf('Recorded at 10:01:09 AM') > -1, true);
  });

  await t('further taps are ignored while one is in flight (no out-of-order writes)', async function () {
    const env = actionEnv();
    env.sb.onAction('PUNCH_IN');
    env.sb.onAction('LUNCH_START');
    env.sb.onAction('PUNCH_OUT');
    assertEq(env.apiCalls.length, 1);
    assertEq(env.sb.STATE.phase, 'working', 'state reflects only the first tap');
  });

  await t('every tap carries its own requestId (the server\'s retry-safety key); two taps never share one', async function () {
    const env = actionEnv();
    env.sb.onAction('PUNCH_IN');
    await env.settle('resolve', { success: true, time: 't', state: { phase: 'working', breakType: null, punchIn: 'x', punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, breakStartedAt: null }, rosterCode: '', requiresGeofence: true });
    env.sb.onAction('LUNCH_START');
    const ids = env.apiCalls.map(function (c) { return c.requestId; });
    assertEq(ids.every(function (i) { return typeof i === 'string' && i.length >= 8; }), true);
    assertEq(ids[0] !== ids[1], true);
  });

  await t('refused WITH a state (already recorded, wrong order…): adopts the server state at once — no second request, no rollback to a stale screen', async function () {
    const env = actionEnv();
    env.sb.onAction('PUNCH_IN');
    const serverState = { phase: 'working', breakType: null, punchIn: '2026-10-05T04:30:00.000Z', punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, breakStartedAt: null };
    await env.settle('resolve', { success: false, message: 'You have already punched in today.', state: serverState, rosterCode: 'P', requiresGeofence: true });
    assertEq(env.sb.ACTION_IN_FLIGHT, false);
    assertEq(env.sb.STATE.phase, 'working');
    assertEq(env.sb.STATE.punchIn, '2026-10-05T04:30:00.000Z');
    assertEq(env.sb.STATE_LOADED, true);
    assertEq(env.refreshCalls.length, 0, 'no follow-up round trip needed');
    assertEq(env.apiCalls.length, 1);
    assertEq(env.msg.innerHTML.indexOf('Already recorded') > -1, true, 'what they wanted is already true — say so, not an error');
  });

  await t('refused with a state that differs from what they wanted: shows the server state and the real reason', async function () {
    const env = actionEnv();
    env.sb.onAction('LUNCH_START');            // they thought they were working…
    const serverState = { phase: 'on_break', breakType: 'TEA', punchIn: 'x', punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, breakStartedAt: '2026-10-05T05:00:00.000Z' };
    await env.settle('resolve', { success: false, message: 'You are already on a Tea Break. End it before starting another break.', state: serverState, rosterCode: '', requiresGeofence: true });
    assertEq([env.sb.STATE.phase, env.sb.STATE.breakType], ['on_break', 'TEA']);
    assertEq(env.msg.innerHTML.indexOf('already on a Tea Break') > -1, true);
    assertEq(env.msg.innerHTML.indexOf('Already recorded'), -1);
  });

  await t('refused by an older server (no state in the reply): rolls back, then re-reads the server', async function () {
    const env = actionEnv();
    const before = clone(env.sb.STATE);
    env.sb.onAction('PUNCH_IN');
    await env.settle('resolve', { success: false, message: 'You have already punched in today.' });
    assertEq(env.sb.STATE, before, 'guess undone');
    assertEq(env.refreshCalls.length, 1);
    assertEq(env.refreshCalls[0][0].indexOf('already punched in') > -1, true);
    assertEq(env.cacheWrites.length, 0, 'an unconfirmed state is never saved');
  });

  await t('no answer at all (retries exhausted): does NOT guess — locks the tiles, asks the server, and offers no tap meanwhile', async function () {
    const env = actionEnv();
    env.sb.onAction('LUNCH_START');
    await env.settle('reject', new Error('API request failed (404)'));
    assertEq(env.sb.ACTION_IN_FLIGHT, false);
    assertEq(env.sb.STATE_LOADED, false, 'tiles stay locked until the truth is known');
    assertEq(env.sb.STATE_PENDING_NOTE, 'Confirming your last punch…');
    assertEq(env.refreshCalls.length, 1, 'one re-read of the real state');
    assertEq(env.cacheWrites.length, 0);
  });

  await t('...and once the truth arrives it says plainly whether the punch was recorded', async function () {
    const env = actionEnv();
    env.sb.onAction('LUNCH_START');
    await env.settle('reject', new Error('x'));
    const after = env.refreshCalls[0][0];
    const recorded = Object.assign(freshState(), { phase: 'on_break', breakType: 'LUNCH' });
    const notRecorded = Object.assign(freshState(), { phase: 'working' });
    assertEq(after(recorded).indexOf('was recorded') > -1, true);
    assertEq(after(notRecorded).indexOf('wasn’t recorded') > -1, true);
  });

  await t('...and if even that re-check fails, the failure text says the punch is unconfirmed', async function () {
    const env = actionEnv();
    env.sb.onAction('PUNCH_OUT');
    await env.settle('reject', new Error('Server busy — please wait a moment and try again.'));
    const failText = env.refreshCalls[0][1];
    assertEq(failText.indexOf('Server busy') > -1 && failText.indexOf('couldn’t confirm whether your last punch was recorded') > -1, true);
  });

  // ---------- hydration ----------
  function hydrateEnv(saved, extra) {
    const calls = [];
    const sandbox = Object.assign({
      CURRENT: { email: 'a@wiom.in' }, IS_MANAGER: false, DAY_REPORT_DATE: '2026-10-05', TEAM_ROSTER_OFFSET: 0,
      TEAM: null, TEAM_STALE: false, TEAM_ERROR: null, RECENT_LOG: null, TEAM_ROSTER: null, TEAM_ROSTER_FRESH: false, DAY_REPORT: null,
      STATE: freshState(), STATE_LOADED: false, STATE_LOAD_ERROR: null, STATE_PENDING_NOTE: null, STATE_RECHECK: null, ACTION_IN_FLIGHT: false,
      freshState_: freshState,
      localDay: function () { return '2026-10-05'; },
      cacheGet: function (email, name, valid) {
        calls.push(name);
        if (!(name in saved)) return null;
        const entry = saved[name];
        const ok = valid ? valid(entry) : entry.day === '2026-10-05';
        return ok ? entry.v : null;
      }
    }, extra || {});
    vm.createContext(sandbox);
    vm.runInContext(hydrateSrc, sandbox);
    sandbox.calls = calls;
    return sandbox;
  }
  const today = '2026-10-05';

  await t('manager: team status, activity, report and roster paint from saved copies, marked as saved', async function () {
    const sb = hydrateEnv({
      team: { day: today, v: { asOf: 'x', employees: [1] } },
      recent: { day: today, v: [{ n: 1 }] },
      'dayreport:2026-10-05': { day: today, v: { date: today, employees: [2] } },
      'roster:0': { day: today, v: { rows: [3] } }
    }, { IS_MANAGER: true });
    vm.runInContext('hydrateFromCache_()', sb);
    assertEq(sb.TEAM, { asOf: 'x', employees: [1] });
    assertEq(sb.TEAM_STALE, true);
    assertEq(sb.RECENT_LOG, [{ n: 1 }]);
    assertEq(sb.DAY_REPORT.employees, [2]);
    assertEq(sb.TEAM_ROSTER, { rows: [3] });
    assertEq(sb.TEAM_ROSTER_FRESH, false, 'a saved roster must still be re-fetched');
  });

  await t('advisor: today\'s saved punch state paints as loaded; roster too', async function () {
    const saved = Object.assign(freshState(), { phase: 'working', punchIn: '2026-10-05T04:30:00.000Z' });
    const sb = hydrateEnv({ daystate: { day: today, v: saved }, 'roster:0': { day: today, v: { rows: [3] } } });
    vm.runInContext('hydrateFromCache_()', sb);
    assertEq(sb.STATE.phase, 'working');
    assertEq(sb.STATE_LOADED, true);
    assertEq(sb.TEAM_ROSTER, { rows: [3] });
    assertEq(sb.calls.indexOf('team'), -1, 'an advisor never reads manager-only copies');
  });

  await t('nothing saved: nothing painted, advisor stays gated on the live status', async function () {
    const sb = hydrateEnv({});
    vm.runInContext('hydrateFromCache_()', sb);
    assertEq(sb.STATE_LOADED, false);
    assertEq(sb.TEAM_ROSTER, null);
  });

  await t('never overwrites data that has already arrived live', async function () {
    const live = { asOf: 'live', employees: [9] };
    const sb = hydrateEnv({ team: { day: today, v: { asOf: 'old', employees: [1] } } }, { IS_MANAGER: true, TEAM: live });
    vm.runInContext('hydrateFromCache_()', sb);
    assertEq(sb.TEAM, live);
    assertEq(sb.TEAM_STALE, false);
  });

  await t('Day End Report cache rule: today saved today, or any date saved after that day ended; never a past day saved mid-day', async function () {
    const sb = hydrateEnv({});
    const ok = function (date, entryDay) { return vm.runInContext('reportCacheValid_', sb)(date)({ day: entryDay }); };
    assertEq(ok('2026-10-05', '2026-10-05'), true, 'today, saved today');
    assertEq(ok('2026-10-05', '2026-10-04'), false, 'today\'s report saved yesterday is for a different day');
    assertEq(ok('2026-10-03', '2026-10-04'), true, 'past day, saved after it ended = final');
    assertEq(ok('2026-10-03', '2026-10-03'), false, 'past day saved on that day = was still filling in');
  });

  await t('resetSessionData_ clears everything loaded for the previous person', async function () {
    const sb = hydrateEnv({}, { TEAM: { a: 1 }, TEAM_STALE: true, RECENT_LOG: [1], TEAM_ROSTER: {}, TEAM_ROSTER_FRESH: true, DAY_REPORT: {}, STATE_LOADED: true, ACTION_IN_FLIGHT: true, STATE: Object.assign(freshState(), { phase: 'working' }) });
    vm.runInContext('resetSessionData_()', sb);
    assertEq([sb.TEAM, sb.TEAM_STALE, sb.RECENT_LOG, sb.TEAM_ROSTER, sb.TEAM_ROSTER_FRESH, sb.DAY_REPORT, sb.STATE_LOADED, sb.ACTION_IN_FLIGHT], [null, false, null, null, false, null, false, false]);
    assertEq(sb.STATE.phase, 'not_started');
  });

  // ---------- renderMe (advisor punch card) ----------
  const renderSrc = slice('function renderMe()', 'function predictState_');
  function renderEnv(over) {
    const out = { html: '' };
    const sandbox = Object.assign({
      ACTIVE_TAB: 'me', STATE: freshState(), STATE_LOADED: true, STATE_LOAD_ERROR: null, STATE_PENDING_NOTE: null, STATE_RECHECK: null, ACTION_IN_FLIGHT: false,
      LOC_INFO: null, LAST_LOC: { lat: 1, lng: 2 },
      BREAK_LABEL: { LUNCH: 'Lunch Break', TEA: 'Tea Break', BIO: 'Bio Break' },
      renderRosterCard: function () { return ''; }, wireRosterNav: function () {}, fmtTime: function (v) { return v ? 'T' : '—'; },
      onAction: function () {}, refreshDayState: function () {}, breakTimerHandle: null,
      setInterval: function () { return 1; }, clearInterval: function () {},
      document: {
        getElementById: function (id) { return id === 'tabBody' ? { set innerHTML(v) { out.html = v; } } : null; },
        querySelectorAll: function () { return []; }
      }
    }, over || {});
    vm.createContext(sandbox);
    vm.runInContext(renderSrc, sandbox);
    sandbox.out = out;
    sandbox.renderMe();
    return out.html;
  }
  const clickable = function (html) { return (html.match(/data-type="/g) || []).length; };

  await t('render: before the live status arrives, no tile is actionable and it says so (no misleading "out of range")', async function () {
    const html = renderEnv({ STATE_LOADED: false });
    assertEq(clickable(html), 0);
    assertEq(html.indexOf('Loading today’s status…') > -1, true);
    assertEq(html.indexOf('within office range'), -1);
  });

  await t('render: while a tap\'s outcome is unknown the card says so and NO tile can be tapped', async function () {
    const html = renderEnv({ STATE_LOADED: false, STATE_PENDING_NOTE: 'Confirming your last punch…' });
    assertEq(html.indexOf('Confirming your last punch…') > -1, true);
    assertEq(clickable(html), 0);
    assertEq(html.indexOf('within office range'), -1);
  });

  await t('render: a failed status load shows the error and a Try again button', async function () {
    const html = renderEnv({ STATE_LOADED: false, STATE_LOAD_ERROR: 'API request failed (404)' });
    assertEq(html.indexOf('id="stateRetryBtn"') > -1 && html.indexOf('API request failed (404)') > -1, true);
    assertEq(clickable(html), 0);
  });

  await t('render: with a GPS fix, tiles come alive without waiting for the checkLocation reply', async function () {
    const html = renderEnv({ LOC_INFO: null, LAST_LOC: { lat: 1, lng: 2 } });
    assertEq(clickable(html), 1, 'Punch In is the one valid action');
    assertEq(html.indexOf('data-type="PUNCH_IN"') > -1, true);
  });

  await t('render: known to be outside the geofence → blocked with the range message', async function () {
    const html = renderEnv({ LOC_INFO: { within: false, distance: 800, radius: 100 } });
    assertEq(clickable(html), 0);
    assertEq(html.indexOf('within office range') > -1, true);
  });

  await t('render: location denied / unavailable → blocked', async function () {
    const html = renderEnv({ LOC_INFO: { error: 'denied' }, LAST_LOC: null });
    assertEq(clickable(html), 0);
  });

  await t('render: no fix yet and nothing known → blocked', async function () {
    assertEq(clickable(renderEnv({ LOC_INFO: null, LAST_LOC: null })), 0);
  });

  await t('render: a WFH day (no geofence) needs no location at all', async function () {
    const st = Object.assign(freshState(), { requiresGeofence: false });
    assertEq(clickable(renderEnv({ STATE: st, LOC_INFO: null, LAST_LOC: null })), 1);
  });

  await t('render: while a tap is saving, tiles lock, a Saving banner shows, and "out of range" does not', async function () {
    const st = Object.assign(freshState(), { phase: 'working', punchIn: '2026-10-05T04:30:00.000Z' });
    const html = renderEnv({ STATE: st, ACTION_IN_FLIGHT: true, LOC_INFO: null, LAST_LOC: null });
    assertEq(clickable(html), 0);
    assertEq(html.indexOf('Saving your punch') > -1, true);
    assertEq(html.indexOf('within office range'), -1);
  });

  await t('render: working → Punch Out and the three break starts are actionable; completed shows the done message', async function () {
    const working = Object.assign(freshState(), { phase: 'working', punchIn: '2026-10-05T04:30:00.000Z' });
    assertEq(clickable(renderEnv({ STATE: working })), 4);
    const done = Object.assign(freshState(), { phase: 'completed', punchIn: 'a', punchOut: 'b' });
    const html = renderEnv({ STATE: done });
    assertEq(clickable(html), 0);
    assertEq(html.indexOf('completed attendance for today') > -1, true);
  });

  console.log('done');
})();

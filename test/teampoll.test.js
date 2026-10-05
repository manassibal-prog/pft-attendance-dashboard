// Exercises the manager auto-refresh scheduler in docs/js/app.js (stopTeamPolling_
// / startTeamPolling_ / teamPollTick_ / the visibilitychange hook) against a
// fake clock. app.js itself can't be loaded in Node (it imports Firebase from a
// CDN URL), so the scheduler's source is sliced out of the real file and run
// in a vm sandbox — what's tested is what ships.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
const from = appSrc.indexOf('function stopTeamPolling_()');
const to = appSrc.lastIndexOf('boot();');
if (from < 0 || to < from) throw new Error('could not locate the polling code in app.js');
const pollSrc = appSrc.slice(from, to);

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const flush = function () { return new Promise(function (r) { setImmediate(r); }); };

// Fresh sandbox per test: fake clock, fake document, scripted loadTeam.
function makeEnv() {
  const env = { now: 1000000, timers: [], nextId: 1, loadCalls: 0, pending: [], listeners: {}, hidden: false };
  const sandbox = {
    document: {
      get hidden() { return env.hidden; },
      addEventListener: function (type, fn) { env.listeners[type] = fn; }
    },
    Date: { now: function () { return env.now; } },
    setTimeout: function (fn, ms) { const id = env.nextId++; env.timers.push({ id: id, at: env.now + ms, fn: fn }); return id; },
    clearTimeout: function (id) { env.timers = env.timers.filter(function (x) { return x.id !== id; }); },
    // Each loadTeam() call stays pending until the test settles it.
    loadTeam: function () {
      env.loadCalls++;
      return new Promise(function (resolve, reject) { env.pending.push({ resolve: resolve, reject: reject }); });
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(
    'let teamPollHandle = null; const TEAM_POLL_MS = 20000; let teamPollGen = 0; let teamPollBusy = false; let teamPollLastAt = 0;\n' + pollSrc,
    sandbox
  );
  env.run = function (code) { return vm.runInContext(code, sandbox); };
  env.advance = async function (ms) {
    const target = env.now + ms;
    for (;;) {
      env.timers.sort(function (a, b) { return a.at - b.at; });
      const next = env.timers[0];
      if (!next || next.at > target) break;
      env.timers.shift();
      env.now = next.at;
      next.fn();
      await flush();
    }
    env.now = target;
    await flush();
  };
  env.settle = async function (how) { const p = env.pending.shift(); p[how || 'resolve'](); await flush(); };
  return env;
}

(async function () {
  await t('first cycle starts immediately; never overlaps while a slow cycle is still in flight', async function () {
    const env = makeEnv();
    env.run('startTeamPolling_()');
    assertEq(env.loadCalls, 1);
    await env.advance(120000);
    assertEq(env.loadCalls, 1, 'a 2-minute-slow cycle must not trigger a second request');
  });

  await t('next cycle is scheduled TEAM_POLL_MS after the previous one finished, not after it started', async function () {
    const env = makeEnv();
    env.run('startTeamPolling_()');
    await env.advance(45000);          // cycle takes 45s
    await env.settle();
    await env.advance(19000);
    assertEq(env.loadCalls, 1, 'not yet — only 19s since it finished');
    await env.advance(1500);
    assertEq(env.loadCalls, 2);
  });

  await t('a failed cycle does not kill the loop', async function () {
    const env = makeEnv();
    env.run('startTeamPolling_()');
    await env.settle('reject');
    await env.advance(20000);
    assertEq(env.loadCalls, 2);
  });

  await t('hidden tab skips its cycle (no request) but keeps checking', async function () {
    const env = makeEnv();
    env.run('startTeamPolling_()');
    await env.settle();
    env.hidden = true;
    await env.advance(100000);
    assertEq(env.loadCalls, 1, 'no requests while hidden');
    env.hidden = false;
    await env.advance(20000);
    assertEq(env.loadCalls, 2, 'resumes on the next tick once visible');
  });

  await t('returning to a stale hidden tab refreshes immediately via visibilitychange', async function () {
    const env = makeEnv();
    env.run('startTeamPolling_()');
    await env.settle();
    env.hidden = true;
    await env.advance(60000);
    env.hidden = false;
    env.listeners.visibilitychange();
    assertEq(env.loadCalls, 2, 'refreshed without waiting for the timer');
  });

  await t('visibilitychange does nothing for a fresh tab, or when polling is not running (advisors)', async function () {
    const env = makeEnv();
    env.listeners.visibilitychange();
    assertEq(env.loadCalls, 0, 'advisor / signed-out: no poller, no request');
    env.run('startTeamPolling_()');
    await env.settle();
    await env.advance(5000);
    env.listeners.visibilitychange();
    assertEq(env.loadCalls, 1, 'only 5s old — not stale enough to refetch');
  });

  await t('stopTeamPolling_ ends the loop even with a request still in flight; restart works', async function () {
    const env = makeEnv();
    env.run('startTeamPolling_()');
    env.run('stopTeamPolling_()');             // e.g. sign-out mid-request
    await env.settle();                        // the stale request finishing must not reschedule anything
    await env.advance(200000);
    assertEq(env.loadCalls, 1);
    env.run('startTeamPolling_()');            // sign back in
    assertEq(env.loadCalls, 2);
    await env.settle();
    await env.advance(20000);
    assertEq(env.loadCalls, 3);
  });

  console.log('done');
})();

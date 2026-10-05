// Exercises the cached ("stale-while-revalidate") sign-in in docs/js/app.js:
// readCachedUser_ / writeCachedUser_ / clearCachedUsers_ / sameUser_ /
// loadCurrentUser. app.js can't be loaded in Node (it imports Firebase from a
// CDN URL), so those functions are sliced out of the real file and run in a vm
// sandbox with a fake localStorage, fake clock, and scripted api() — what's
// tested is what ships.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
const from = appSrc.indexOf('const USER_CACHE_PREFIX');
const to = appSrc.indexOf('function onFatal');
if (from < 0 || to < from) throw new Error('could not locate the sign-in code in app.js');
const src = appSrc.slice(from, to);

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
const flush = function () { return new Promise(function (r) { setImmediate(r); }); };

const ADVISOR = { emp: { empId: 'PFT003', name: 'Saddam', designation: 'Advisor' }, isManager: false, officeName: 'Head Office', radius: 100 };
const MANAGER = { emp: { empId: 'PFT001', name: 'Manas', designation: 'Manager' }, isManager: true, officeName: 'Head Office', radius: 100 };

function makeEnv() {
  const store = {};
  const env = { store: store, now: 1700000000000, onUserCalls: [], fatalCalls: [], apiCalls: [], pending: [], appHtml: null };
  const sandbox = {
    localStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; }
    },
    Date: { now: function () { return env.now; } },
    document: { getElementById: function () { return { set innerHTML(v) { env.appHtml = v; } }; } },
    CURRENT: { email: 'Saddam.Husain@wiom.in' },
    api: function (params) {
      env.apiCalls.push(params);
      return new Promise(function (resolve, reject) { env.pending.push({ resolve: resolve, reject: reject }); });
    },
    onUser: function (res) { env.onUserCalls.push(res); },
    onFatal: function (err) { env.fatalCalls.push(err.message); }
  };
  vm.createContext(sandbox);
  // Object.keys(localStorage) in clearCachedUsers_ needs enumerable own keys.
  sandbox.localStorage = new Proxy(sandbox.localStorage, { ownKeys: function () { return Object.keys(store); }, getOwnPropertyDescriptor: function (_, k) { return { enumerable: true, configurable: true, value: store[k] }; } });
  vm.runInContext(src, sandbox);
  env.run = function (code) { return vm.runInContext(code, sandbox); };
  env.settle = async function (how, value) { const p = env.pending.shift(); p[how](value); await flush(); };
  env.cacheKey = 'pft-user:saddam.husain@wiom.in';
  return env;
}

(async function () {
  await t('first visit (no cache): shows Loading…, then renders the server answer and caches it', async function () {
    const env = makeEnv();
    env.run('loadCurrentUser()');
    assertEq(env.appHtml, '<div class="loading">Loading…</div>');
    assertEq(env.onUserCalls.length, 0, 'nothing to paint yet');
    await env.settle('resolve', ADVISOR);
    assertEq(env.onUserCalls, [ADVISOR]);
    assertEq(JSON.parse(env.store[env.cacheKey]).res, ADVISOR);
  });

  await t('returning visit: paints the cached user BEFORE the server answers', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("saddam.husain@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.run('loadCurrentUser()');
    assertEq(env.onUserCalls, [ADVISOR], 'painted instantly, request still in flight');
    assertEq(env.pending.length, 1);
  });

  await t('revalidation that matches the cache does not re-render (no flicker, no duplicate loads)', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("saddam.husain@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.run('loadCurrentUser()');
    await env.settle('resolve', Object.assign({}, ADVISOR, { radius: 150 })); // unrelated setting changed
    assertEq(env.onUserCalls.length, 1);
    assertEq(JSON.parse(env.store[env.cacheKey]).res.radius, 150, 'cache still refreshed');
  });

  await t('role changed since last visit: re-renders with the fresh answer and updates the cache', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("saddam.husain@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.run('loadCurrentUser()');
    await env.settle('resolve', Object.assign({}, MANAGER, { emp: Object.assign({}, MANAGER.emp, { empId: 'PFT003' }) }));
    assertEq(env.onUserCalls.length, 2);
    assertEq(env.onUserCalls[1].isManager, true);
    assertEq(JSON.parse(env.store[env.cacheKey]).res.isManager, true);
  });

  await t('access revoked: error is shown, and the cache is cleared so it is not replayed next visit', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("saddam.husain@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.run('loadCurrentUser()');
    await env.settle('resolve', { error: 'Your record is marked "Inactive". Contact your admin.' });
    assertEq(env.onUserCalls.length, 2);
    assertEq(env.onUserCalls[1].error, 'Your record is marked "Inactive". Contact your admin.');
    assertEq(env.store[env.cacheKey], undefined);
  });

  await t('errors are never written to the cache', async function () {
    const env = makeEnv();
    env.run('loadCurrentUser()');
    await env.settle('resolve', { error: 'Email x is not registered in Employee Master.' });
    assertEq(Object.keys(env.store), []);
  });

  await t('backend down + cached user: keeps the cached screen, no fatal error screen', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("saddam.husain@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.run('loadCurrentUser()');
    await env.settle('reject', new Error('API request failed (404)'));
    assertEq(env.onUserCalls, [ADVISOR]);
    assertEq(env.fatalCalls, []);
  });

  await t('backend down + no cache: falls back to the error screen with Try again', async function () {
    const env = makeEnv();
    env.run('loadCurrentUser()');
    await env.settle('reject', new Error('API request failed (404)'));
    assertEq(env.fatalCalls, ['API request failed (404)']);
  });

  await t('a reply that lands after sign-out/sign-in (stale request) is ignored entirely', async function () {
    const env = makeEnv();
    env.run('loadCurrentUser()');
    env.run('userLoadSeq++'); // what boot() does on every auth change
    await env.settle('resolve', ADVISOR);
    assertEq(env.onUserCalls.length, 0);
    assertEq(Object.keys(env.store), [], 'and must not write a cache entry for a signed-out session');
  });

  await t('cache older than 14 days is ignored', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("saddam.husain@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.now += 15 * 24 * 60 * 60 * 1000;
    env.run('loadCurrentUser()');
    assertEq(env.onUserCalls.length, 0);
    assertEq(env.appHtml, '<div class="loading">Loading…</div>');
  });

  await t('corrupt / hostile cache contents are ignored, not thrown', async function () {
    const env = makeEnv();
    for (const bad of ['{not json', 'null', '{"res":{}}', '{"at":1,"res":{"emp":null}}', '"string"']) {
      env.store[env.cacheKey] = bad;
      assertEq(env.run('readCachedUser_("saddam.husain@wiom.in")'), null, bad);
    }
  });

  await t('cache key is case/whitespace-insensitive on email', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("  SADDAM.Husain@WIOM.in ", ' + JSON.stringify(ADVISOR) + ')');
    assertEq(Object.keys(env.store), [env.cacheKey]);
  });

  await t('clearCachedUsers_ (sign-out) removes every cached user but leaves other keys alone', async function () {
    const env = makeEnv();
    env.run('writeCachedUser_("a@wiom.in", ' + JSON.stringify(ADVISOR) + ')');
    env.run('writeCachedUser_("b@i2e1.com", ' + JSON.stringify(MANAGER) + ')');
    env.store['pft-theme'] = 'dark';
    env.run('clearCachedUsers_()');
    assertEq(Object.keys(env.store), ['pft-theme']);
  });

  await t('blocked/full storage never breaks sign-in', async function () {
    const env = makeEnv();
    env.run('localStorage.getItem = function () { throw new Error("denied"); }; localStorage.setItem = function () { throw new Error("quota"); };');
    env.run('loadCurrentUser()');
    await env.settle('resolve', ADVISOR);
    assertEq(env.onUserCalls, [ADVISOR]);
  });

  console.log('done');
})();

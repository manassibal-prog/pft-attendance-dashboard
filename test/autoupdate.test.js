// Exercises the "pick up new versions" check in docs/js/app.js (fetchVersion_ /
// checkForUpdate_ / applyUpdate_). Sliced out of the real file and run in a vm
// with a scripted fetch/document/location, since app.js can't load in Node.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
const from = appSrc.indexOf('const VERSION_FILES');
const to = appSrc.indexOf('function startUpdateChecks_');
if (from < 0 || to < from) throw new Error('could not locate the update-check code in app.js');
const src = appSrc.slice(from, to);

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

function makeEnv() {
  const env = { reloads: 0, banners: [], session: {}, etags: null, headCalls: [], hidden: false, inFlight: false };
  const sandbox = {
    ACTION_IN_FLIGHT: false,
    location: { href: 'https://x.github.io/pft-attendance-dashboard/', reload: function () { env.reloads++; } },
    sessionStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(env.session, k) ? env.session[k] : null; },
      setItem: function (k, v) { env.session[k] = String(v); }
    },
    fetch: function (url, init) {
      env.headCalls.push([url, init.method]);
      const tag = env.etags ? env.etags[url.split('/').slice(3).join('/').replace(/^pft-attendance-dashboard\/?/, '') || './'] : '';
      return Promise.resolve({
        ok: tag !== undefined,
        headers: { get: function (h) { return h === 'etag' ? (tag || null) : null; } }
      });
    },
    document: {
      get hidden() { return env.hidden; },
      createElement: function () { const el = { id: '', className: '', innerHTML: '', listeners: {}, addEventListener: function (n, f) { el.listeners[n] = f; } }; return el; },
      getElementById: function (id) { return id === 'updateBanner' ? env.banners.find(function (b) { return b.id === id; }) || null : (id === 'updateNowBtn' ? { addEventListener: function () {} } : null); },
      body: { firstChild: null, insertBefore: function (el) { env.banners.push(el); } }
    },
    URL: URL
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  env.sb = sandbox;
  env.set = function (v) {
    env.etags = {};
    ['./', 'js/app.js', 'js/db.js', 'js/http.js', 'js/cache.js', 'js/auth.js', 'js/config.js'].forEach(function (f) { env.etags[f] = v + ':' + f; });
  };
  return env;
}
const check = function (env) { return env.sb.checkForUpdate_(); };

(async function () {
  await t('first check only records what this tab is running; nothing happens', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    assertEq([env.reloads, env.banners.length], [0, 0]);
  });

  await t('every deployed file is compared, not just one (a change to any of them counts)', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    assertEq(env.headCalls.length, 7);
    assertEq(env.headCalls.every(function (c) { return c[1] === 'HEAD'; }), true);
    env.etags['js/db.js'] = 'changed';
    env.hidden = true;
    await check(env);
    assertEq(env.reloads, 1);
  });

  await t('unchanged version: nothing happens, however many checks', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env); await check(env); await check(env);
    assertEq([env.reloads, env.banners.length], [0, 0]);
  });

  await t('new version while the tab is hidden (nobody looking): reloads quietly', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = true;
    await check(env);
    assertEq([env.reloads, env.banners.length], [1, 0]);
  });

  await t('new version while someone is looking: shows a Reload now bar, does NOT yank the page away', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = false;
    await check(env);
    assertEq(env.reloads, 0);
    assertEq(env.banners.length, 1);
    assertEq(env.banners[0].innerHTML.indexOf('Reload now') > -1, true);
    await check(env);
    assertEq(env.banners.length, 1, 'one bar, not one per check');
  });

  await t('never reloads or interrupts while a punch is saving', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = true; env.sb.ACTION_IN_FLIGHT = true;
    await check(env);
    assertEq([env.reloads, env.banners.length], [0, 0]);
    env.sb.ACTION_IN_FLIGHT = false;               // saved; the next opportunity (e.g. tab hidden again) reloads
    env.sb.applyUpdate_();
    assertEq(env.reloads, 1);
  });

  await t('reload-loop guard: the same new version never triggers a second automatic reload', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = true;
    await check(env);
    await check(env);
    env.sb.applyUpdate_();
    assertEq(env.reloads, 1);
  });

  await t('headers that cannot be read (no etag/last-modified, or a failed request) never cause a reload', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.etags = {};                                 // every HEAD answers ok with no validators
    env.hidden = true;
    await check(env);
    assertEq(env.reloads, 0);
  });

  await t('offline / failing fetch is swallowed', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.sb.fetch = function () { return Promise.reject(new TypeError('Failed to fetch')); };
    await check(env);
    assertEq(env.reloads, 0);
  });

  console.log('done');
})();

// Exercises the "pick up new versions" check in docs/js/app.js (hashText_ /
// fetchVersion_ / checkForUpdate_ / applyUpdate_ / reloadForUpdate_). Sliced out
// of the real file and run in a vm with a scripted fetch/document/location,
// since app.js can't load in Node.
//
// The check compares file CONTENT. Comparing ETag/Last-Modified falsely reported
// "new version" over and over, because GitHub Pages' servers disagree on those
// for unchanged files.
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
const tick = function () { return new Promise(function (r) { setImmediate(r); }); };

const FILES = ['./', 'js/app.js', 'js/db.js', 'js/http.js', 'js/cache.js', 'js/auth.js', 'js/config.js'];

function makeEnv() {
  const env = { reloads: 0, banners: [], session: {}, files: null, calls: [], hidden: false, noisy: false, clicks: {} };
  const sandbox = {
    ACTION_IN_FLIGHT: false,
    location: { href: 'https://x.github.io/pft-attendance-dashboard/', reload: function () { env.reloads++; } },
    sessionStorage: {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(env.session, k) ? env.session[k] : null; },
      setItem: function (k, v) { env.session[k] = String(v); }
    },
    fetch: function (url, init) {
      const key = url.split('/').slice(3).join('/').replace(/^pft-attendance-dashboard\/?/, '') || './';
      env.calls.push({ key: key, cache: init && init.cache, method: init && init.method });
      const body = env.files[key];
      // "noisy" = the GitHub Pages behaviour: headers differ on every request, content does not.
      const headers = { get: function () { return env.noisy ? 'W/"' + Math.random() + '"' : '"fixed"'; } };
      return Promise.resolve({ ok: body !== undefined, headers: headers, text: function () { return Promise.resolve(body || ''); } });
    },
    document: {
      get hidden() { return env.hidden; },
      createElement: function () { const el = { id: '', className: '', innerHTML: '' }; return el; },
      getElementById: function (id) {
        if (id === 'updateBanner') return env.banners.find(function (b) { return b.id === id; }) || null;
        if (id === 'updateNowBtn') return { addEventListener: function (n, f) { env.clicks[n] = f; } };
        return null;
      },
      body: { firstChild: null, insertBefore: function (el) { env.banners.push(el); } }
    },
    URL: URL
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  env.sb = sandbox;
  env.set = function (v) { env.files = {}; FILES.forEach(function (f) { env.files[f] = 'content of ' + f + ' @ ' + v; }); };
  return env;
}
const check = function (env) { return env.sb.checkForUpdate_(); };

(async function () {
  await t('first check only records what this tab is running; nothing happens', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    assertEq([env.reloads, env.banners.length], [0, 0]);
  });

  await t('THE BUG: headers that change on every request but identical content never trigger anything', async function () {
    const env = makeEnv(); env.set('v1'); env.noisy = true;
    await check(env);
    env.hidden = false;
    for (let i = 0; i < 6; i++) await check(env);
    assertEq([env.reloads, env.banners.length], [0, 0]);
    env.hidden = true;
    for (let i = 0; i < 6; i++) await check(env);
    await tick();
    assertEq(env.reloads, 0, 'no quiet reload either');
  });

  await t('the baseline reads what this tab loaded (cache), the checks read what is deployed (no-store)', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    assertEq(env.calls.length, 7);
    assertEq(env.calls.every(function (c) { return c.cache === 'default'; }), true);
    env.calls.length = 0;
    await check(env);
    assertEq(env.calls.length, 7);
    assertEq(env.calls.every(function (c) { return c.cache === 'no-store'; }), true);
  });

  await t('every deployed file is compared, not just one (a change to any of them counts)', async function () {
    for (const f of FILES) {
      const env = makeEnv(); env.set('v1');
      await check(env);
      env.files[f] = 'changed';
      env.hidden = true;
      await check(env);
      await tick();
      assertEq(env.reloads, 1, f);
    }
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
    await tick();
    assertEq([env.reloads, env.banners.length], [1, 0]);
  });

  await t('reloading first refreshes the browser\'s cached copies so the old code does not come straight back', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = true; env.calls.length = 0;
    await check(env);
    await tick();
    const reloaded = env.calls.filter(function (c) { return c.cache === 'reload'; }).map(function (c) { return c.key; }).sort();
    assertEq(reloaded, FILES.slice().sort());
    assertEq(env.reloads, 1);
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

  await t('Reload now reloads; if the same version still shows afterwards, no second bar (no nagging loop)', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = false;
    await check(env);
    env.clicks.click();
    await tick();
    assertEq(env.reloads, 1);
    // simulate the page coming back (new JS context, same session): the bar must not return for v2
    const again = makeEnv(); again.set('v1'); again.session = env.session;
    await check(again);
    again.set('v2'); again.hidden = false;
    await check(again);
    assertEq([again.reloads, again.banners.length], [0, 0]);
    // …but a genuinely newer v3 is announced again
    again.set('v3');
    await check(again);
    assertEq(again.banners.length, 1);
  });

  await t('never reloads or interrupts while a punch is saving', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = true; env.sb.ACTION_IN_FLIGHT = true;
    await check(env);
    await tick();
    assertEq([env.reloads, env.banners.length], [0, 0]);
    env.sb.ACTION_IN_FLIGHT = false;               // saved; the next opportunity (e.g. tab hidden again) reloads
    env.sb.applyUpdate_();
    await tick();
    assertEq(env.reloads, 1);
  });

  await t('reload-loop guard: the same new version never triggers a second automatic reload', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.set('v2'); env.hidden = true;
    await check(env);
    await tick();
    await check(env);
    env.sb.applyUpdate_();
    await tick();
    assertEq(env.reloads, 1);
  });

  await t('a file that cannot be fetched (404 / failed request) never causes a reload', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    delete env.files['js/db.js'];                   // that request answers not-ok
    env.hidden = true;
    await check(env);
    await tick();
    assertEq(env.reloads, 0);
  });

  await t('offline / failing fetch is swallowed', async function () {
    const env = makeEnv(); env.set('v1');
    await check(env);
    env.sb.fetch = function () { return Promise.reject(new TypeError('Failed to fetch')); };
    await check(env);
    assertEq(env.reloads, 0);
  });

  await t('a failing first (baseline) check is retried next time instead of locking in nothing', async function () {
    const env = makeEnv(); env.set('v1');
    const good = env.sb.fetch;
    env.sb.fetch = function () { return Promise.reject(new TypeError('Failed to fetch')); };
    await check(env);
    env.sb.fetch = good;
    await check(env);                               // becomes the baseline
    env.set('v2'); env.hidden = true;
    await check(env);
    await tick();
    assertEq(env.reloads, 1);
  });

  console.log('done');
})();

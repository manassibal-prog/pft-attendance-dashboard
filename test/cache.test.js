// Exercises docs/js/cache.js (saved copies of server answers) with a fake
// localStorage. Loaded via a data: URL because it's an ES module inside a
// CommonJS package.
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'cache.js'), 'utf8');

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

function fakeStorage() {
  const store = {};
  return {
    store: store,
    get length() { return Object.keys(store).length; },
    key: function (i) { return Object.keys(store)[i] === undefined ? null : Object.keys(store)[i]; },
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
    setItem: function (k, v) { store[k] = String(v); },
    removeItem: function (k) { delete store[k]; }
  };
}

(async function () {
  const m = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const day = m.localDay();

  await t('round-trips a value saved today', async function () {
    globalThis.localStorage = fakeStorage();
    m.cacheSet('a@wiom.in', 'team', { employees: [1, 2] });
    assertEq(m.cacheGet('a@wiom.in', 'team'), { employees: [1, 2] });
  });

  await t('is keyed per user (case/whitespace-insensitive) and per name', async function () {
    globalThis.localStorage = fakeStorage();
    m.cacheSet('  A@Wiom.in ', 'team', 'mine');
    assertEq(m.cacheGet('a@wiom.in', 'team'), 'mine');
    assertEq(m.cacheGet('b@wiom.in', 'team'), null, 'other user must not see it');
    assertEq(m.cacheGet('a@wiom.in', 'recent'), null, 'other name must not see it');
  });

  await t('a copy saved on an earlier day is not used (yesterday\'s "Working" must not paint today)', async function () {
    globalThis.localStorage = fakeStorage();
    globalThis.localStorage.setItem('pft-cache:a@wiom.in:team', JSON.stringify({ at: 1, day: '2000-01-01', v: 'old' }));
    assertEq(m.cacheGet('a@wiom.in', 'team'), null);
  });

  await t('a custom validity rule overrides the same-day default', async function () {
    globalThis.localStorage = fakeStorage();
    globalThis.localStorage.setItem('pft-cache:a@wiom.in:r', JSON.stringify({ at: 1, day: '2000-01-01', v: 'old-but-final' }));
    assertEq(m.cacheGet('a@wiom.in', 'r', function (e) { return e.day > '1999-12-31'; }), 'old-but-final');
    assertEq(m.cacheGet('a@wiom.in', 'r', function () { return false; }), null);
  });

  await t('corrupt or empty entries read as a miss, never throw', async function () {
    globalThis.localStorage = fakeStorage();
    for (const bad of ['{nope', 'null', '{}', '{"day":"' + day + '"}', '{"day":"' + day + '","v":null}', '"str"', '123']) {
      globalThis.localStorage.setItem('pft-cache:a@wiom.in:x', bad);
      assertEq(m.cacheGet('a@wiom.in', 'x'), null, bad);
    }
  });

  await t('cacheClearAll (sign-out) removes only saved copies, leaving other keys', async function () {
    globalThis.localStorage = fakeStorage();
    m.cacheSet('a@wiom.in', 'team', 1);
    m.cacheSet('b@i2e1.com', 'roster:0', 2);
    globalThis.localStorage.setItem('pft-theme', 'dark');
    globalThis.localStorage.setItem('pft-user:a@wiom.in', '{}');
    m.cacheClearAll();
    assertEq(Object.keys(globalThis.localStorage.store).sort(), ['pft-theme', 'pft-user:a@wiom.in']);
  });

  await t('blocked or full storage degrades to "no cache" without throwing', async function () {
    globalThis.localStorage = {
      get length() { throw new Error('denied'); },
      key: function () { throw new Error('denied'); },
      getItem: function () { throw new Error('denied'); },
      setItem: function () { throw new Error('quota'); },
      removeItem: function () { throw new Error('denied'); }
    };
    m.cacheSet('a@wiom.in', 'team', 1);
    assertEq(m.cacheGet('a@wiom.in', 'team'), null);
    m.cacheClearAll();
  });

  console.log('done');
})();

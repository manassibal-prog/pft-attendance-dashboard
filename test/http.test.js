// Exercises docs/js/http.js (the browser transport for the Apps Script API)
// with a mocked fetch. The file is an ES module inside a CommonJS package, so
// it's loaded via a data: URL rather than require().
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'http.js'), 'utf8');

function t(label, fn) {
  return fn().then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }
async function rejects(promise) { try { await promise; } catch (e) { return e; } throw new Error('expected rejection'); }

const ok = function (body) { return { ok: true, status: 200, json: async function () { return body; } }; };
const http = function (status) { return { ok: false, status: status, json: async function () { throw new Error('not json'); } }; };

// Replaces global fetch with a scripted sequence; returns a call counter.
function mockFetch(steps) {
  const calls = { n: 0 };
  globalThis.fetch = function (url, init) {
    const step = steps[Math.min(calls.n, steps.length - 1)];
    calls.n++;
    return step(init);
  };
  return calls;
}

(async function () {
  const { fetchJson } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const fast = { timeoutMs: 1000, retryDelaysMs: [1, 1] };

  await t('returns the JSON body on success, one request', async function () {
    const calls = mockFetch([async function () { return ok({ a: 1 }); }]);
    assertEq(await fetchJson('u', fast), { a: 1 });
    assertEq(calls.n, 1);
  });

  await t('404 then 200: retried, returns the good response', async function () {
    const calls = mockFetch([async function () { return http(404); }, async function () { return ok({ a: 2 }); }]);
    assertEq(await fetchJson('u', fast), { a: 2 });
    assertEq(calls.n, 2);
  });

  await t('persistent 404: gives up after the configured retries (1 + 2 = 3 requests)', async function () {
    const calls = mockFetch([async function () { return http(404); }]);
    const e = await rejects(fetchJson('u', fast));
    assertEq(e.message, 'API request failed (404)');
    assertEq(calls.n, 3);
  });

  await t('no retries configured (writes): a 404 fails after exactly one request', async function () {
    const calls = mockFetch([async function () { return http(404); }]);
    await rejects(fetchJson('u', { timeoutMs: 1000 }));
    assertEq(calls.n, 1);
  });

  await t('app-level { error } on HTTP 200 is surfaced immediately, never retried', async function () {
    const calls = mockFetch([async function () { return ok({ error: 'Email x is not registered in Employee Master.' }); }]);
    const e = await rejects(fetchJson('u', fast));
    assertEq(e.message, 'Email x is not registered in Employee Master.');
    assertEq(calls.n, 1);
  });

  await t('unreadable (non-JSON) 200 response is treated as transient and retried', async function () {
    const calls = mockFetch([
      async function () { return { ok: true, status: 200, json: async function () { throw new SyntaxError('Unexpected token <'); } }; },
      async function () { return ok({ a: 3 }); }
    ]);
    assertEq(await fetchJson('u', fast), { a: 3 });
    assertEq(calls.n, 2);
  });

  await t('network failure (fetch TypeError) is retried, then reported as a network error', async function () {
    const calls = mockFetch([async function () { throw new TypeError('Failed to fetch'); }]);
    const e = await rejects(fetchJson('u', fast));
    assertEq(e.message, 'Network error — check your connection');
    assertEq(calls.n, 3);
  });

  await t('timeout: reported as "Server busy" and NOT retried (an aborted request keeps running server-side)', async function () {
    const calls = mockFetch([function (init) {
      return new Promise(function (_, reject) {
        init.signal.addEventListener('abort', function () { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }]);
    const e = await rejects(fetchJson('u', { timeoutMs: 20, retryDelaysMs: [1, 1] }));
    assertEq(e.message, 'Server busy — please wait a moment and try again.');
    assertEq(calls.n, 1);
  });

  console.log('done');
})();

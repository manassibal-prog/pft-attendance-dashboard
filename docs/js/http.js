// Transport for the Apps Script JSON API. Under load a web-app deployment
// intermittently answers with a 404 (or a non-JSON error page) after a long
// wait, and the identical request succeeds moments later — so callers can
// opt in to retrying exactly those failures. A JSON { error } body is the app
// speaking (e.g. "not registered"), never retried.

function transientError_(message) {
  const e = new Error(message);
  e.transient = true;
  return e;
}

async function fetchJsonOnce_(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, timeoutMs);
  try {
    const res = await fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' });
    if (!res.ok) throw transientError_('API request failed (' + res.status + ')');
    let json;
    try { json = await res.json(); } catch (_) { throw transientError_('API returned an unreadable response'); }
    if (json && json.error) throw new Error(json.error);
    return json;
  } catch (e) {
    if (e.name === 'AbortError') {
      const timedOut = new Error('Server busy — please wait a moment and try again.');
      timedOut.timedOut = true;
      throw timedOut;
    }
    if (e instanceof TypeError) throw transientError_('Network error — check your connection');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// retryDelaysMs: one entry per retry (omit/[] for no retries). Timeouts are
// not retried by default — the server is already slow, and an aborted request
// keeps running there, so a second one just adds load. retryOnTimeout is for
// requests the server de-duplicates (a write carrying a requestId): there,
// "no answer" is exactly the case a retry exists for, and it can't double-apply.
export async function fetchJson(url, opts) {
  const retryDelaysMs = opts.retryDelaysMs || [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchJsonOnce_(url, opts.timeoutMs);
    } catch (e) {
      const retryable = e.transient || (opts.retryOnTimeout && e.timedOut);
      if (!retryable || attempt >= retryDelaysMs.length) throw e;
      await new Promise(function (resolve) { setTimeout(resolve, retryDelaysMs[attempt]); });
    }
  }
}

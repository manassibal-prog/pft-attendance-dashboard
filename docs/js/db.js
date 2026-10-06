import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { FIREBASE_CONFIG, CONFIG } from './config.js';
import { fetchJson } from './http.js';

// Firebase Auth is used for Google Sign-In only — all data reads/writes go
// through the Apps Script JSON API below, same split as wiom-l2.
const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);

const _READ_ACTIONS = new Set(['getCurrentUser', 'checkLocation', 'getDayState', 'getTeamRoster', 'getTeamStatus', 'getRecentLog', 'getDayEndReport']);
// Aborting a request doesn't cancel it on Apps Script's side — it keeps
// running and holding one of the project's concurrent-execution slots — so
// a short client timeout under load only piles up orphaned work. Reads get
// long enough to ride out a slow response instead.
const _READ_TIMEOUT_MS = 60000;
const _WRITE_TIMEOUT_MS = 60000;
// Reads are idempotent, so transient failures (404/5xx/unreadable body) are
// retried. A write is retried only if it carries a requestId: the server
// treats a repeat of the same requestId as "already done" (recordEvent), so
// a lost reply can be retried safely. Writes without one are never retried.
const _READ_RETRY_DELAYS_MS = [1500, 4000];
const _WRITE_RETRY_DELAYS_MS = [1500, 4000];
const _inflight = {};

// GET (not POST) — Apps Script's redirect-on-execute can drop a POST body,
// but a GET's query string survives the redirect intact.
export async function api(params) {
  const isRead = _READ_ACTIONS.has(params.action);
  const dedupeKey = isRead ? JSON.stringify(params) : null;
  if (dedupeKey && _inflight[dedupeKey]) return _inflight[dedupeKey];

  const urlParams = new URLSearchParams({ key: CONFIG.API_KEY });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) urlParams.set(k, String(v));
  });
  const url = CONFIG.API_URL + '?' + urlParams.toString();

  const idempotentWrite = !isRead && !!params.requestId;
  const promise = fetchJson(url, {
    timeoutMs: isRead ? _READ_TIMEOUT_MS : _WRITE_TIMEOUT_MS,
    retryDelaysMs: isRead ? _READ_RETRY_DELAYS_MS : (idempotentWrite ? _WRITE_RETRY_DELAYS_MS : []),
    retryOnTimeout: idempotentWrite
  }).finally(() => {
    if (dedupeKey) delete _inflight[dedupeKey];
  });

  if (dedupeKey) _inflight[dedupeKey] = promise;
  return promise;
}

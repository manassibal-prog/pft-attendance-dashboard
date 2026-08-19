import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { FIREBASE_CONFIG, CONFIG } from './config.js';

// Firebase Auth is used for Google Sign-In only — all data reads/writes go
// through the Apps Script JSON API below, same split as wiom-l2.
const app = initializeApp(FIREBASE_CONFIG);
export const auth = getAuth(app);

const _READ_ACTIONS = new Set(['getCurrentUser', 'checkLocation', 'getDayState', 'getTeamRoster', 'getMyMonthRoster', 'getTeamStatus', 'getRecentLog']);
const _READ_TIMEOUT_MS = 30000;
const _WRITE_TIMEOUT_MS = 60000;
const _inflight = {};

// GET (not POST) — Apps Script's redirect-on-execute can drop a POST body,
// but a GET's query string survives the redirect intact.
export async function api(params) {
  const isRead = _READ_ACTIONS.has(params.action);
  const dedupeKey = isRead ? JSON.stringify(params) : null;
  if (dedupeKey && _inflight[dedupeKey]) return _inflight[dedupeKey];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), isRead ? _READ_TIMEOUT_MS : _WRITE_TIMEOUT_MS);
  const urlParams = new URLSearchParams({ key: CONFIG.API_KEY });
  Object.entries(params).forEach(([k, v]) => {
    if (v !== null && v !== undefined) urlParams.set(k, String(v));
  });
  const url = CONFIG.API_URL + '?' + urlParams.toString();

  const promise = fetch(url, { method: 'GET', signal: controller.signal, cache: 'no-store' })
    .then(res => {
      if (!res.ok) throw new Error('API request failed (' + res.status + ')');
      return res.json();
    })
    .then(json => {
      if (json && json.error) throw new Error(json.error);
      return json;
    })
    .catch(e => {
      if (e.name === 'AbortError') throw new Error('Server busy — please wait a moment and try again.');
      throw e;
    })
    .finally(() => {
      clearTimeout(timer);
      if (dedupeKey) delete _inflight[dedupeKey];
    });

  if (dedupeKey) _inflight[dedupeKey] = promise;
  return promise;
}

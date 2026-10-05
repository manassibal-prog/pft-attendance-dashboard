import { onAuthReady, signIn, signOutUser } from './auth.js';
import { api } from './db.js';
import { CONFIG } from './config.js';
import { cacheGet, cacheSet, cacheClearAll, localDay } from './cache.js';

const ALLOWED_DOMAINS_TEXT = CONFIG.ALLOWED_DOMAINS.map(function (d) { return '@' + d; }).join(' or ');

// Advisors mark attendance from a laptop/desktop only — phones and tablets
// are turned away here (onUser) before the punch UI ever renders, and
// recordEvent is checked again server-side (Code.gs) so someone can't just
// disable JS or hand-craft the request. Like the email param elsewhere in
// this app, the device signal is self-reported by the client and not
// cryptographically provable — this stops the casual "just punch in from my
// phone" case, not a determined spoof. iPadOS reports a desktop Safari user
// agent by default, which is why this also checks for a coarse (touch)
// primary pointer rather than relying on the user agent string alone.
const MOBILE_UA_RE = /Android|iPhone|iPad|iPod|Mobile|Tablet/i;
function isMobileOrTablet_() {
  const uaMatch = MOBILE_UA_RE.test(navigator.userAgent);
  const coarsePointer = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  return uaMatch || coarsePointer;
}

// Applied immediately (before first render) so the page never flashes the
// wrong theme on load.
document.documentElement.setAttribute('data-theme', localStorage.getItem('pft-theme') || 'dark');

let CURRENT = null; // { email, name } from Firebase
let EMP = null;
let IS_MANAGER = false;
let LAST_LOC = null;
let LOC_INFO = null;
function freshState_() {
  return { phase: 'not_started', breakType: null, punchIn: null, punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, breakStartedAt: null, rosterCode: '', requiresGeofence: true };
}
let STATE = freshState_();
// STATE above is only a placeholder until getDayState answers (or a saved
// copy from earlier today is painted). The advisor screen paints before that
// (cached sign-in), so tiles stay disabled until STATE_LOADED rather than
// offering "Punch In" on a guess.
let STATE_LOADED = false;
let STATE_LOAD_ERROR = null;
// True from the moment a punch/break tap is sent until the server answers.
// The screen already shows the expected result; further taps wait so two
// requests can't reach the server out of order.
let ACTION_IN_FLIGHT = false;
let ACTIVE_TAB = 'me';
let TEAM = null;
let TEAM_ERROR = null;
let TEAM_ROSTER = null;
let TEAM_ROSTER_OFFSET = 0;
// Whether TEAM_ROSTER came from the server this session (vs a saved copy
// painted first); until it has, every poll keeps trying to fetch a fresh one.
let TEAM_ROSTER_FRESH = false;
// TEAM is a saved copy until the first live poll lands.
let TEAM_STALE = false;
let RECENT_LOG = null;
let teamPollHandle = null;
const TEAM_POLL_MS = 20000;
let teamPollGen = 0;
let teamPollBusy = false;
let teamPollLastAt = 0;
let DAY_REPORT = null;
let DAY_REPORT_DATE = todayYyyyMmDd_();
let breakTimerHandle = null;

function todayYyyyMmDd_() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const BREAK_LABEL = { LUNCH: 'Lunch Break', TEA: 'Tea Break', BIO: 'Bio Break' };
const EVENT_DOT = { PUNCH_IN: 'ed-in', PUNCH_OUT: 'ed-out', LUNCH_START: 'ed-start', TEA_START: 'ed-start', BIO_START: 'ed-start', LUNCH_END: 'ed-end', TEA_END: 'ed-end', BIO_END: 'ed-end' };
const LIVE_STATUSES = ['Working', 'Lunch Break', 'Tea Break', 'Bio Break'];

// Team Status row order: Working first, then Present, then anyone on a
// break, then everything else (Late, Half Day, WO, Holiday, Not Started,
// roster codes, …) in whatever order the server returned it — sort() is
// stable, so ties don't get reshuffled on every 20s poll.
const STATUS_SORT_RANK = { Working: 0, Present: 1, 'Lunch Break': 2, 'Tea Break': 2, 'Bio Break': 2 };
function statusSortRank_(status) {
  return Object.prototype.hasOwnProperty.call(STATUS_SORT_RANK, status) ? STATUS_SORT_RANK[status] : 3;
}
function sortByStatus_(employees) {
  return employees.slice().sort(function (a, b) { return statusSortRank_(a.status) - statusSortRank_(b.status); });
}

// Day End Report row order: Present, then Late, then WO, then L, then
// everything else (Half Day, UP, Holiday, Absent, Not Started, …).
const DAY_END_SORT_RANK = { Present: 0, Late: 1, WO: 2, L: 3 };
function dayEndSortRank_(status) {
  return Object.prototype.hasOwnProperty.call(DAY_END_SORT_RANK, status) ? DAY_END_SORT_RANK[status] : 4;
}
function sortByDayEndStatus_(employees) {
  return employees.slice().sort(function (a, b) { return dayEndSortRank_(a.status) - dayEndSortRank_(b.status); });
}

function rosterCodeClass(code) {
  const c = String(code || '').trim();
  if (c === 'P') return 'rc-P';
  if (c === 'WFH') return 'rc-WFH';
  if (c === 'L' || c === 'UP') return 'rc-L';
  if (c === 'HD') return 'rc-HD';
  if (c === 'WO' || c === 'Holiday' || !c || c === '—') return 'rc-WO';
  return 'rc-empty';
}

// Multi-employee weekly grid: one row per advisor, one column per day.
// Shared by both roles — advisors see the whole team's roster here too,
// same as managers (Roster itself stays read-only from this app either way).
function renderTeamRosterTable(roster) {
  let html = '<div class="roster-scroll"><table class="roster-table"><thead><tr><th class="name-col">Advisor</th>';
  roster.days.forEach(function (d) { html += '<th class="' + (d.isToday ? 'today' : '') + '">' + d.label + '</th>'; });
  html += '</tr></thead><tbody>';
  roster.rows.forEach(function (r) {
    html += '<tr><td class="name-col">' + r.name + '</td>';
    r.codes.forEach(function (code, i) {
      html += '<td class="' + (roster.days[i].isToday ? 'today' : '') + '"><span class="rc ' + rosterCodeClass(code) + '">' + code + '</span></td>';
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';

  html += '<div class="legend">';
  [['P', 'Present'], ['WFH', 'Work From Home'], ['WO', 'Week Off'], ['L', 'Leave'], ['UP', 'Unpaid Leave'], ['HD', 'Half Day'], ['Holiday', 'Holiday']].forEach(function (item) {
    html += '<div class="legend-item"><span class="rc ' + rosterCodeClass(item[0]) + '">' + item[0] + '</span>' + item[1] + '</div>';
  });
  html += '</div>';
  return html;
}

function fmtTime(v) { return v ? new Date(v).toLocaleTimeString() : '—'; }
function fmtHours(v) { return (v === '' || v === null || v === undefined) ? '—' : v + 'h'; }

// Shared by both roles — full-width card, navigable by week (Prev/Next/Today).
function renderRosterCard() {
  let html = '<div class="card"><h1>Team Roster</h1>';
  html += '<div class="roster-nav">';
  html += '<button class="roster-nav-btn" id="rosterPrev">‹ Prev</button>';
  html += '<div class="roster-range">' + (TEAM_ROSTER ? TEAM_ROSTER.rangeLabel : 'Loading…') + '</div>';
  html += '<div class="roster-nav-right"><button class="roster-nav-btn" id="rosterToday">Today</button><button class="roster-nav-btn" id="rosterNext">Next ›</button></div>';
  html += '</div>';
  html += TEAM_ROSTER ? renderTeamRosterTable(TEAM_ROSTER) : '<div class="loading">Loading…</div>';
  html += '</div>';
  return html;
}

function wireRosterNav() {
  const prevBtn = document.getElementById('rosterPrev');
  const nextBtn = document.getElementById('rosterNext');
  const todayBtn = document.getElementById('rosterToday');
  if (prevBtn) prevBtn.addEventListener('click', function () { TEAM_ROSTER_OFFSET -= 1; loadTeamRoster(); });
  if (nextBtn) nextBtn.addEventListener('click', function () { TEAM_ROSTER_OFFSET += 1; loadTeamRoster(); });
  if (todayBtn) todayBtn.addEventListener('click', function () { TEAM_ROSTER_OFFSET = 0; loadTeamRoster(); });
}

function renderActive() { if (ACTIVE_TAB === 'team') renderTeam(); else renderMe(); }

// ---------- Theme toggle + live clock (both visible regardless of auth state) ----------
function currentTheme() { return localStorage.getItem('pft-theme') || 'dark'; }
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('pft-theme', theme);
}
function renderThemeToggle() {
  const theme = currentTheme();
  return '<button id="themeToggle" class="theme-toggle" type="button">' + (theme === 'dark' ? '☀️ Light' : '🌙 Dark') + '</button>';
}
function wireThemeToggle() {
  const btn = document.getElementById('themeToggle');
  if (!btn) return;
  btn.addEventListener('click', function () {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    btn.textContent = next === 'dark' ? '☀️ Light' : '🌙 Dark';
  });
}

function renderClock() {
  const el = document.getElementById('appbarCenter');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) + ' · ' + now.toLocaleTimeString();
}
function startClock() { renderClock(); setInterval(renderClock, 1000); }

// ---------- Sign-in screen ----------
function renderSignIn(errorMsg) {
  const right = document.getElementById('appbarRight');
  if (right) right.innerHTML = renderThemeToggle();
  wireThemeToggle();
  document.getElementById('app').innerHTML =
    '<div class="narrow"><div class="card" style="text-align:center;padding:44px 24px;">' +
    '<div class="brand-mark" style="width:56px;height:56px;font-size:28px;margin:0 auto 18px;">W</div>' +
    '<h1 style="margin-bottom:6px;">PFT Attendance</h1>' +
    '<div class="sub">Wiom &middot; Partner Follow-up Team</div>' +
    (errorMsg ? '<div class="status err" style="margin:16px 0;">' + errorMsg + '</div>' : '') +
    '<button id="signInBtn" class="btn-in" style="margin-top:20px;">Sign in with Google</button>' +
    '<div class="sub" style="margin-top:14px;">Only ' + ALLOWED_DOMAINS_TEXT + ' accounts are allowed</div>' +
    '</div></div>';
  document.getElementById('signInBtn').addEventListener('click', function () {
    signIn().catch(function (err) { renderSignIn(err.message); });
  });
}

// ---------- Boot / identity ----------
function boot() {
  startClock();
  onAuthReady(function (user, errorCode) {
    stopTeamPolling_();
    userLoadSeq++;
    resetSessionData_();
    if (!user) {
      clearCachedUsers_();
      cacheClearAll();
      renderSignIn(errorCode === 'unauthorized_domain' ? 'Only ' + ALLOWED_DOMAINS_TEXT + ' accounts are allowed.' : null);
      return;
    }
    CURRENT = user;
    loadCurrentUser();
  });
}

// Everything loaded for one signed-in person; cleared on every auth change so
// a sign-out → sign-in as someone else in the same tab starts clean.
function resetSessionData_() {
  TEAM = null; TEAM_STALE = false; TEAM_ERROR = null; RECENT_LOG = null;
  TEAM_ROSTER = null; TEAM_ROSTER_FRESH = false; DAY_REPORT = null;
  STATE = freshState_(); STATE_LOADED = false; STATE_LOAD_ERROR = null;
  ACTION_IN_FLIGHT = false;
}

// Paints the last-seen data before the live requests answer. Only fills what
// isn't loaded yet, so a second onUser (cached → fresh sign-in) can't put a
// saved copy over data that has since arrived.
function hydrateFromCache_() {
  const email = CURRENT.email;
  if (IS_MANAGER) {
    if (!TEAM) { const t = cacheGet(email, 'team'); if (t) { TEAM = t; TEAM_STALE = true; } }
    if (!RECENT_LOG) RECENT_LOG = cacheGet(email, 'recent');
    if (!DAY_REPORT) DAY_REPORT = cacheGet(email, 'dayreport:' + DAY_REPORT_DATE, reportCacheValid_(DAY_REPORT_DATE));
  } else if (!STATE_LOADED) {
    const s = cacheGet(email, 'daystate');
    if (s) { STATE = s; STATE_LOADED = true; STATE_LOAD_ERROR = null; }
  }
  if (!TEAM_ROSTER) TEAM_ROSTER = cacheGet(email, 'roster:' + TEAM_ROSTER_OFFSET);
}

// A saved Day End Report is trustworthy to paint if it's today's report saved
// today (still filling in, refreshed right after), or any report saved after
// its own day ended (final). A past date saved mid-day is incomplete.
function reportCacheValid_(date) {
  return function (entry) { return (date === localDay() && entry.day === localDay()) || entry.day > date; };
}

// Stale-while-revalidate sign-in. A returning user's last successful
// getCurrentUser answer is painted immediately and re-checked in the
// background, so the app opens at once even when the Apps Script endpoint
// takes tens of seconds (or fails) to answer. The cache only shapes the first
// paint — the server still authorises every action on every request — and it
// is wiped on sign-out. Errors are never cached.
const USER_CACHE_PREFIX = 'pft-user:';
const USER_CACHE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
let userLoadSeq = 0; // bumped on every sign-in/out so a late reply can't paint over a newer state

function userCacheKey_(email) { return USER_CACHE_PREFIX + String(email).trim().toLowerCase(); }
function readCachedUser_(email) {
  try {
    const v = JSON.parse(localStorage.getItem(userCacheKey_(email)));
    if (!v || !v.res || !v.res.emp || !(Date.now() - v.at < USER_CACHE_MAX_AGE_MS)) return null;
    return v.res;
  } catch (_) { return null; }
}
function writeCachedUser_(email, res) {
  try { localStorage.setItem(userCacheKey_(email), JSON.stringify({ at: Date.now(), res: res })); } catch (_) { /* storage blocked/full: just no cache */ }
}
function clearCachedUser_(email) {
  try { localStorage.removeItem(userCacheKey_(email)); } catch (_) {}
}
function clearCachedUsers_() {
  try {
    Object.keys(localStorage).filter(function (k) { return k.indexOf(USER_CACHE_PREFIX) === 0; })
      .forEach(function (k) { localStorage.removeItem(k); });
  } catch (_) {}
}
function sameUser_(a, b) {
  return JSON.stringify([a.emp, !!a.isManager]) === JSON.stringify([b.emp, !!b.isManager]);
}

function loadCurrentUser() {
  const seq = ++userLoadSeq;
  const email = CURRENT.email;
  const cached = readCachedUser_(email);
  if (cached) onUser(cached);
  else document.getElementById('app').innerHTML = '<div class="loading">Loading…</div>';

  api({ action: 'getCurrentUser', email: email })
    .then(function (res) {
      if (seq !== userLoadSeq) return;
      if (res.error) clearCachedUser_(email); else writeCachedUser_(email, res);
      if (cached && !res.error && sameUser_(cached, res)) return; // already showing exactly this
      onUser(res);
    })
    .catch(function (err) {
      if (seq !== userLoadSeq) return;
      if (cached) return; // keep the cached screen; each part of it reports its own failures
      onFatal(err);
    });
}

function onFatal(err) {
  document.getElementById('app').innerHTML =
    '<div class="card"><h1>Something went wrong</h1><div class="status err">' + err.message + '</div>' +
    '<button id="retryBtn" class="btn-in" style="margin-top:14px;">Try again</button></div>';
  document.getElementById('retryBtn').addEventListener('click', loadCurrentUser);
}

function renderMobileBlocked() {
  document.getElementById('app').innerHTML =
    '<div class="narrow"><div class="card" style="text-align:center;padding:44px 24px;">' +
    '<div class="brand-mark" style="width:56px;height:56px;font-size:28px;margin:0 auto 18px;">W</div>' +
    '<h1 style="margin-bottom:6px;">Use a laptop to continue</h1>' +
    '<div class="sub">Attendance can only be marked from a laptop or desktop browser &mdash; not a phone or tablet.</div>' +
    '</div></div>';
}

function onUser(res) {
  // onUser can now run twice for one sign-in (cached answer, then the fresh
  // one); if the role changed between them, the old role's poller must go.
  stopTeamPolling_();
  if (res.error) {
    document.getElementById('appbarRight').innerHTML = renderThemeToggle();
    wireThemeToggle();
    document.getElementById('app').innerHTML =
      '<div class="card"><h1>Access denied</h1><div class="status err">' + res.error + '</div>' +
      '<button id="signOutBtn" style="margin-top:14px;">Sign out</button></div>';
    document.getElementById('signOutBtn').addEventListener('click', function () { signOutUser(); });
    return;
  }
  EMP = res.emp;
  IS_MANAGER = !!res.isManager;
  document.getElementById('appbarRight').innerHTML =
    '<div class="appbar-right-top">' +
      '<span class="who-name">' + EMP.name + '</span>' +
      '<span class="role-pill ' + (IS_MANAGER ? 'manager">Manager' : 'advisor">Advisor') + '</span>' +
      '<a href="#" id="signOutLink" style="color:var(--text-muted);font-size:12px;margin-left:4px;">Sign out</a>' +
    '</div>' +
    renderThemeToggle();
  document.getElementById('signOutLink').addEventListener('click', function (e) { e.preventDefault(); signOutUser(); });
  wireThemeToggle();
  if (!IS_MANAGER && isMobileOrTablet_()) {
    renderMobileBlocked();
    return;
  }
  hydrateFromCache_();
  renderShell();
  if (!IS_MANAGER) {
    refreshDayState();
    requestLocation();
    loadTeamRoster();
  }
}

// afterMsg: shown once the fresh state has loaded. failMsg: shown instead if
// that re-check itself fails (defaults to afterMsg, or the raw error).
function refreshDayState(afterMsg, failMsg) {
  api({ action: 'getDayState', email: CURRENT.email }).then(function (s) {
    // A tap is mid-flight: this answer predates it and would flicker the
    // screen back; the tap's own response is the newer truth.
    if (ACTION_IN_FLIGHT) return;
    STATE = s;
    STATE_LOADED = true;
    STATE_LOAD_ERROR = null;
    cacheSet(CURRENT.email, 'daystate', STATE);
    renderMe();
    if (afterMsg) {
      const msg = document.getElementById('msg');
      if (msg) msg.innerHTML = afterMsg;
    }
  }).catch(function (err) {
    if (STATE_LOADED) {
      // A real status is already on screen; a failed re-check shouldn't blank it.
      const msg = document.getElementById('msg');
      if (msg) msg.innerHTML = failMsg || afterMsg || '<div class="status err">' + err.message + '</div>';
      return;
    }
    STATE_LOAD_ERROR = err.message;
    renderMe();
  });
}

function requestLocation() {
  if (!navigator.geolocation) {
    LOC_INFO = { error: 'Your browser does not support location access.' };
    renderMe();
    return;
  }
  navigator.geolocation.getCurrentPosition(function (pos) {
    LAST_LOC = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    api({ action: 'checkLocation', lat: LAST_LOC.lat, lng: LAST_LOC.lng }).then(function (info) { LOC_INFO = info; renderMe(); });
  }, function () {
    LOC_INFO = { error: 'Location permission denied or unavailable. Enable location access and reload this page.' };
    renderMe();
  }, { enableHighAccuracy: true, timeout: 15000 });
}

// Each role gets exactly one view — advisors their own attendance, managers
// the team overview — with no tab switcher between them. Advisors can't
// reach the team view even by URL/console tricks, since the server rejects
// getTeamStatus/getRecentLog/getTeamRoster for non-managers regardless of
// what the UI shows; managers simply have no punch flow to switch to.
function renderShell() {
  document.getElementById('app').innerHTML = '<div id="tabBody"></div>';
  if (IS_MANAGER) {
    ACTIVE_TAB = 'team';
    renderTeam();
    startTeamPolling_();
  } else {
    ACTIVE_TAB = 'me';
    renderMe();
  }
}

function renderMe() {
  if (ACTIVE_TAB !== 'me') return;
  const body = document.getElementById('tabBody');
  if (!body) return;

  let html = renderRosterCard();

  html += '<div class="section-heading">Today’s Summary</div>';

  const requiresGeofence = STATE.requiresGeofence !== false;

  const phaseText = !STATE_LOADED ? (STATE_LOAD_ERROR ? 'Couldn’t load today’s status' : 'Loading today’s status…') : {
    not_started: STATE.rosterCode ? 'Not punched in &middot; Roster: ' + STATE.rosterCode : 'Not punched in',
    working: 'Working',
    on_break: STATE.breakType ? BREAK_LABEL[STATE.breakType] : 'On Break',
    completed: 'Day complete'
  }[STATE.phase];
  const phaseClass = !STATE_LOADED ? 'phase-idle' : { not_started: 'phase-idle', working: 'phase-working', on_break: 'phase-break', completed: 'phase-done' }[STATE.phase];

  // The server re-checks the geofence on every punch, so this is only a
  // convenience gate: block as soon as we know we're outside (or can't get a
  // location), but once there's a GPS fix don't make the person wait on the
  // checkLocation round-trip before the tiles come alive.
  const locOk = LOC_INFO ? (!LOC_INFO.error && LOC_INFO.within) : !!LAST_LOC;
  const inRange = !requiresGeofence || locOk;
  const canAct = STATE_LOADED && inRange && !ACTION_IN_FLIGHT;

  html += '<div class="card">';
  html += '<div class="phasebar ' + phaseClass + '">' + phaseText + '</div>';
  html += '<div class="stat-grid">';
  html += renderStatTile('PUNCH_IN', canAct);
  html += renderStatTile('LUNCH', canAct);
  html += renderStatTile('TEA', canAct);
  html += renderStatTile('BIO', canAct);
  html += renderStatTile('PUNCH_OUT', canAct);
  html += '<div class="total-break-bar"><span class="stat-label" style="text-transform:none;font-size:13px;">Total Break Time</span>' +
    '<span class="stat-value" id="tile-TOTAL-BREAK">' + renderTotalBreakValue_() + '</span></div>';
  html += '</div>';

  if (ACTION_IN_FLIGHT) {
    html += '<div class="status info">Saving your punch… keep this page open until it says Recorded.</div>';
  } else if (!STATE_LOADED) {
    if (STATE_LOAD_ERROR) html += '<div class="status err">' + STATE_LOAD_ERROR + '</div><button id="stateRetryBtn" class="btn-in" style="margin-top:14px;">Try again</button>';
  } else if (STATE.phase === 'completed') {
    html += '<div class="status ok">You have completed attendance for today.</div>';
  } else if (!inRange) {
    html += '<div class="status err">You must be within office range to punch in/out or take a break.</div>';
  }
  html += '<div id="msg"></div></div>';

  body.innerHTML = html;
  wireRosterNav();
  const stateRetryBtn = document.getElementById('stateRetryBtn');
  if (stateRetryBtn) stateRetryBtn.addEventListener('click', function () { STATE_LOAD_ERROR = null; renderMe(); refreshDayState(); });
  document.querySelectorAll('[data-type]').forEach(function (el) {
    el.addEventListener('click', function () { onAction(el.getAttribute('data-type')); });
  });
  startBreakTimer_();
}

// Tiles double as controls: Punch In / Punch Out / each break tile is
// tappable exactly when that action is valid right now (mirrors
// validTransition_ server-side), and a running break pulses to show it's
// live. Not clickable -> plain display tile, same look as before.
function tileTypeFor_(key) {
  const phase = STATE.phase;
  if (key === 'PUNCH_IN') return (!STATE.punchIn && phase === 'not_started') ? 'PUNCH_IN' : null;
  if (key === 'PUNCH_OUT') return (phase === 'working') ? 'PUNCH_OUT' : null;
  if (phase === 'on_break' && STATE.breakType === key) return key + '_END';
  if (phase === 'working') return key + '_START';
  return null;
}

function renderStatTile(key, canAct) {
  const isBreak = key === 'LUNCH' || key === 'TEA' || key === 'BIO';
  const active = isBreak && STATE.phase === 'on_break' && STATE.breakType === key;
  const value = key === 'PUNCH_IN' ? fmtTime(STATE.punchIn)
    : key === 'PUNCH_OUT' ? fmtTime(STATE.punchOut)
    : active ? fmtMmSs_(elapsedSecondsSince_(STATE.breakStartedAt))
    : Math.round((STATE.breakTotals && STATE.breakTotals[key]) || 0) + ' min';
  const label = key === 'PUNCH_IN' ? 'Punch In' : key === 'PUNCH_OUT' ? 'Punch Out' : BREAK_LABEL[key];
  const colorClass = key === 'PUNCH_IN' ? 't-green' : key === 'PUNCH_OUT' ? 't-blue' : 't-amber';
  const posClass = key === 'PUNCH_IN' ? 'tile-punchin' : key === 'PUNCH_OUT' ? 'tile-punchout' : 'tile-' + key.toLowerCase();
  const actionType = tileTypeFor_(key);
  const clickable = !!actionType && canAct;

  let cls = 'stat-tile ' + colorClass + ' ' + posClass;
  if (active) cls += ' stat-tile-active';
  if (clickable) cls += ' stat-tile-clickable';
  const attr = clickable ? ' data-type="' + actionType + '"' : '';
  const valueId = isBreak ? ' id="tile-' + key + '"' : '';

  return '<div class="' + cls + '"' + attr + '><div class="stat-value"' + valueId + '>' + value + '</div><div class="stat-label">' + label + '</div></div>';
}

// ---------- Live break timer ----------
function elapsedSecondsSince_(isoTimestamp) {
  if (!isoTimestamp) return 0;
  return Math.max(0, (Date.now() - new Date(isoTimestamp).getTime()) / 1000);
}
function fmtMmSs_(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = Math.floor(totalSeconds % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
function totalBreakSeconds_() {
  const baseMin = ['LUNCH', 'TEA', 'BIO'].reduce(function (sum, k) { return sum + ((STATE.breakTotals && STATE.breakTotals[k]) || 0); }, 0);
  const liveSec = STATE.phase === 'on_break' ? elapsedSecondsSince_(STATE.breakStartedAt) : 0;
  return baseMin * 60 + liveSec;
}
function renderTotalBreakValue_() {
  return STATE.phase === 'on_break' ? fmtMmSs_(totalBreakSeconds_()) : Math.round(totalBreakSeconds_() / 60) + ' min';
}
function tickBreakTimer_() {
  if (STATE.phase !== 'on_break' || !STATE.breakStartedAt) return;
  const activeEl = document.getElementById('tile-' + STATE.breakType);
  if (activeEl) activeEl.textContent = fmtMmSs_(elapsedSecondsSince_(STATE.breakStartedAt));
  const totalEl = document.getElementById('tile-TOTAL-BREAK');
  if (totalEl) totalEl.textContent = renderTotalBreakValue_();
}
function startBreakTimer_() {
  if (breakTimerHandle) { clearInterval(breakTimerHandle); breakTimerHandle = null; }
  if (STATE.phase === 'on_break' && STATE.breakStartedAt) {
    breakTimerHandle = setInterval(tickBreakTimer_, 1000);
  }
}

// What getDayState would return right after `type` succeeds — mirrors
// computeDayState_ in Code.gs for a single event. Only ever shown until the
// server's own answer replaces it.
function predictState_(s, type, now) {
  const next = Object.assign({}, s, { breakTotals: Object.assign({}, s.breakTotals) });
  const iso = now.toISOString();
  if (type === 'PUNCH_IN') {
    next.phase = 'working'; next.punchIn = iso;
  } else if (type === 'PUNCH_OUT') {
    next.phase = 'completed'; next.punchOut = iso;
  } else if (/_START$/.test(type)) {
    next.phase = 'on_break'; next.breakType = type.split('_')[0]; next.breakStartedAt = iso;
  } else if (/_END$/.test(type)) {
    const bt = type.split('_')[0];
    if (s.breakStartedAt) next.breakTotals[bt] = (next.breakTotals[bt] || 0) + (now - new Date(s.breakStartedAt)) / 60000;
    next.phase = 'working'; next.breakType = null; next.breakStartedAt = null;
  }
  return next;
}

// Optimistic: the tap shows its result at once and the request confirms it in
// the background (the endpoint can take tens of seconds). If the server says
// no, or the answer never arrives, the screen goes back to what it was and
// then re-reads the truth from the server — a timed-out write may well have
// gone through, so "never arrived" is not "didn't happen".
function onAction(type) {
  if (ACTION_IN_FLIGHT) return;
  const before = STATE;
  ACTION_IN_FLIGHT = true;
  STATE = predictState_(before, type, new Date());
  renderMe();
  api({ action: 'recordEvent', email: CURRENT.email, type: type, lat: LAST_LOC ? LAST_LOC.lat : '', lng: LAST_LOC ? LAST_LOC.lng : '', device: isMobileOrTablet_() ? 'mobile' : 'desktop' })
    .then(function (res) {
      ACTION_IN_FLIGHT = false;
      if (res.success) {
        STATE = Object.assign({}, res.state, { rosterCode: res.rosterCode, requiresGeofence: res.requiresGeofence });
        cacheSet(CURRENT.email, 'daystate', STATE);
        renderMe();
        const msg = document.getElementById('msg');
        if (msg) msg.innerHTML = '<div class="status ok">Recorded at ' + res.time + '.</div>';
      } else {
        // Rejected (outside the geofence, wrong order, …): nothing was
        // recorded. Undo the guess, then trust the server over our local state.
        STATE = before;
        renderMe();
        refreshDayState('<div class="status err">' + res.message + '</div>');
      }
    })
    .catch(function (err) {
      ACTION_IN_FLIGHT = false;
      STATE = before;
      renderMe();
      refreshDayState(
        '<div class="status err">' + err.message + ' &mdash; showing your latest status from the server.</div>',
        '<div class="status err">' + err.message + ' &mdash; we couldn’t confirm whether that was recorded. Check your connection and refresh the page.</div>'
      );
    });
}

// Leaving mid-save could cancel the request, and the screen has already told
// the person it worked — so make them confirm.
window.addEventListener('beforeunload', function (e) {
  if (!ACTION_IN_FLIGHT) return;
  e.preventDefault();
  e.returnValue = '';
});

function renderTeam() {
  if (ACTIVE_TAB !== 'team') return;
  const body = document.getElementById('tabBody');
  if (!body) return;

  // 1. Team roster grid — full width, navigable by week.
  let html = renderRosterCard();

  // 2. Day summary heading + live status.
  html += '<div class="section-heading">Today’s Summary</div>';
  html += '<div class="card"><h1><span class="live-dot"></span>Team Status</h1>';
  if (!TEAM && TEAM_ERROR) {
    // No data at all yet (e.g. first load failed) — this is the only case
    // that gets an error where data would be, since there's nothing else
    // to show. A failed refresh once TEAM already has something stays
    // silent below instead, rather than replacing good data with an error.
    html += '<div class="status err">' + TEAM_ERROR + '</div>';
  } else if (!TEAM) {
    html += '<div class="loading">Loading…</div>';
  } else {
    html += '<div class="sub">Live &middot; updates every 20s &middot; as of ' + new Date(TEAM.asOf).toLocaleTimeString() +
      (TEAM_ERROR ? ' &middot; <span style="color:var(--red);">last refresh failed, showing previous data</span>'
        : TEAM_STALE ? ' &middot; saved copy, refreshing…' : '') + '</div>';
    TEAM.employees.forEach(function (e) {
      const cls = 'st-' + String(e.status || '').replace(/\s+/g, '');
      const since = (LIVE_STATUSES.indexOf(e.status) > -1 && e.statusSince) ? ' &middot; since ' + fmtTime(e.statusSince) : '';
      html += '<div class="team-row"><div><div class="team-name">' + e.name + '</div><div class="team-sub">' + (e.department || '') +
        (e.punchIn ? ' &middot; in ' + fmtTime(e.punchIn) : '') + (e.punchOut ? ' &middot; out ' + fmtTime(e.punchOut) : '') + since + '</div></div>' +
        '<span class="status-pill ' + cls + '">' + (e.status || '—') + '</span></div>';
    });
  }
  html += '</div>';

  // 3. Day End Report — login/logout, total login time, active/working time,
  // break time, filterable to any past date.
  html += '<div class="card"><h1>Day End Report</h1>';
  html += '<div class="report-datebar"><label class="sub" for="reportDate" style="margin:0;">Date</label>' +
    '<input type="date" id="reportDate" value="' + DAY_REPORT_DATE + '" max="' + todayYyyyMmDd_() + '">' +
    (DAY_REPORT_DATE !== todayYyyyMmDd_() ? '<button class="roster-nav-btn" id="reportToday" type="button">Today</button>' : '') +
    '</div>';
  if (!DAY_REPORT) {
    html += '<div class="loading">Loading…</div>';
  } else {
    html += '<div class="data-table-wrap"><table class="data-table"><thead><tr>' +
      '<th>Advisor</th><th>Status</th><th>Login Time</th><th>Logout Time</th><th>Total Login Time</th><th>Active/Working Time</th><th>Total Break Time</th>' +
      '</tr></thead><tbody>';
    DAY_REPORT.employees.forEach(function (e) {
      html += '<tr><td class="dt-name">' + e.name + '</td><td>' + (e.status || '—') + '</td><td>' + fmtTime(e.punchIn) + '</td><td>' + fmtTime(e.punchOut) + '</td>' +
        '<td>' + fmtHours(e.gross) + '</td><td>' + fmtHours(e.netHours) + '</td><td>' + Math.round(e.totalBreak || 0) + ' min</td></tr>';
    });
    html += '</tbody></table></div>';
  }
  html += '</div>';

  // 4. Recent activity.
  html += '<div class="card"><h1>Recent Activity</h1><div class="sub">Last ' + (RECENT_LOG ? RECENT_LOG.length : 0) + ' punch/break events</div>';
  if (!RECENT_LOG) {
    html += '<div class="loading">Loading…</div>';
  } else if (!RECENT_LOG.length) {
    html += '<div class="sub">No activity yet today.</div>';
  } else {
    RECENT_LOG.forEach(function (e) {
      html += '<div class="team-row"><div><div class="team-name"><span class="event-dot ' + (EVENT_DOT[e.type] || 'ed-start') + '"></span>' + e.name + '</div><div class="team-sub">' + e.label + '</div></div>' +
        '<div class="team-sub">' + fmtTime(e.timestamp) + '</div></div>';
    });
  }
  html += '</div>';

  body.innerHTML = html;
  wireRosterNav();
  const dateInput = document.getElementById('reportDate');
  if (dateInput) dateInput.addEventListener('change', function () { DAY_REPORT_DATE = dateInput.value; loadDayEndReport(); });
  const reportTodayBtn = document.getElementById('reportToday');
  if (reportTodayBtn) reportTodayBtn.addEventListener('click', function () { DAY_REPORT_DATE = todayYyyyMmDd_(); loadDayEndReport(); });
}

// Shows this week's saved copy straight away if there is one (or a blank
// "Loading…" if not), then replaces it with the live answer.
function loadTeamRoster() {
  const offset = TEAM_ROSTER_OFFSET;
  const email = CURRENT.email;
  TEAM_ROSTER = cacheGet(email, 'roster:' + offset);
  TEAM_ROSTER_FRESH = false;
  renderActive();
  return api({ action: 'getTeamRoster', email: email, weekOffset: offset })
    .then(function (r) {
      cacheSet(email, 'roster:' + offset, r);
      if (offset !== TEAM_ROSTER_OFFSET) return; // they've paged to another week since
      TEAM_ROSTER = r;
      TEAM_ROSTER_FRESH = true;
      renderActive();
    })
    .catch(function () { /* non-fatal — rest of the tab still shows */ });
}

// silent: a background poll refreshing today's report keeps the rows already
// on screen until fresh ones arrive, instead of flashing back to "Loading…"
// every cycle (which also hid the report entirely whenever a poll was slow).
// Date changes still blank it, since the old rows belong to another day.
function loadDayEndReport(silent) {
  const email = CURRENT.email;
  if (!silent) {
    DAY_REPORT = cacheGet(email, 'dayreport:' + DAY_REPORT_DATE, reportCacheValid_(DAY_REPORT_DATE));
    renderTeam();
  }
  return api({ action: 'getDayEndReport', email: email, date: DAY_REPORT_DATE })
    .then(function (r) {
      const report = Object.assign({}, r, { employees: sortByDayEndStatus_(r.employees) });
      cacheSet(email, 'dayreport:' + r.date, report);
      if (r.date !== DAY_REPORT_DATE) return; // reply for a date the user has since navigated away from
      DAY_REPORT = report;
      renderTeam();
    })
    .catch(function () { /* non-fatal — rest of the tab still shows */ });
}

// Resolves once every request in this cycle has settled (none of them reject),
// so the poller below can wait for the cycle to finish before scheduling the next.
function loadTeam() {
  const jobs = [];
  const email = CURRENT.email;
  jobs.push(api({ action: 'getTeamStatus', email: email })
    .then(function (t) {
      TEAM = Object.assign({}, t, { employees: sortByStatus_(t.employees) });
      TEAM_STALE = false;
      TEAM_ERROR = null;
      cacheSet(email, 'team', TEAM);
      renderTeam();
    })
    .catch(function (err) {
      // A failed poll (transient Apps Script hiccup, timeout, etc.) only
      // ever affects the Team Status card's own content — never wipe the
      // roster grid / Day End Report / Recent Activity that are already
      // showing, and never blank the whole tab over one bad poll out of
      // every 20s.
      TEAM_ERROR = err.message;
      renderTeam();
    }));
  jobs.push(api({ action: 'getRecentLog', email: email, limit: 30 })
    .then(function (log) { RECENT_LOG = log; cacheSet(email, 'recent', log); renderTeam(); })
    .catch(function () { /* non-fatal — Team Status card still shows */ }));
  // Roster rarely changes within a session — fetch once per tab visit, not
  // on every 20s poll like the live status/log above (a saved copy painted
  // first doesn't count as fetched). Nav clicks (loadTeamRoster) fetch on
  // demand separately.
  if (!TEAM_ROSTER_FRESH) loadTeamRoster();
  // Same for the Day End Report: refresh on every poll only while looking at
  // today (still filling in); a past date is already final, no need to re-fetch.
  if (!DAY_REPORT || DAY_REPORT_DATE === todayYyyyMmDd_()) jobs.push(loadDayEndReport(!!DAY_REPORT));
  return Promise.all(jobs);
}

// Manager auto-refresh. Each cycle starts only after the previous one has
// fully finished, plus TEAM_POLL_MS — a plain setInterval kept firing new
// requests while slow ones were still running, and Apps Script keeps
// executing a request even after the browser gives up on it, so under load
// that snowballed. Hidden tabs skip their cycle entirely (an unattended
// background tab was a steady drain on a shared backend for no one's benefit).
function stopTeamPolling_() {
  teamPollGen++;
  teamPollBusy = false;
  if (teamPollHandle) { clearTimeout(teamPollHandle); teamPollHandle = null; }
}

function startTeamPolling_() {
  stopTeamPolling_();
  teamPollTick_(teamPollGen);
}

function teamPollTick_(gen) {
  if (gen !== teamPollGen) return;
  if (teamPollHandle) { clearTimeout(teamPollHandle); teamPollHandle = null; }
  if (document.hidden || teamPollBusy) {
    teamPollHandle = setTimeout(function () { teamPollTick_(gen); }, TEAM_POLL_MS);
    return;
  }
  teamPollBusy = true;
  teamPollLastAt = Date.now();
  loadTeam().then(function () {}, function () {}).then(function () {
    if (gen !== teamPollGen) return;
    teamPollBusy = false;
    teamPollHandle = setTimeout(function () { teamPollTick_(gen); }, TEAM_POLL_MS);
  });
}

// Coming back to a tab that sat hidden: refresh now rather than showing
// data up to a full cycle stale.
document.addEventListener('visibilitychange', function () {
  if (!document.hidden && teamPollHandle && Date.now() - teamPollLastAt > TEAM_POLL_MS) teamPollTick_(teamPollGen);
});

boot();

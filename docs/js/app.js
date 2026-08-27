import { onAuthReady, signIn, signOutUser } from './auth.js';
import { api } from './db.js';
import { CONFIG } from './config.js';

const ALLOWED_DOMAINS_TEXT = CONFIG.ALLOWED_DOMAINS.map(function (d) { return '@' + d; }).join(' or ');

// Applied immediately (before first render) so the page never flashes the
// wrong theme on load.
document.documentElement.setAttribute('data-theme', localStorage.getItem('pft-theme') || 'dark');

let CURRENT = null; // { email, name } from Firebase
let EMP = null;
let IS_MANAGER = false;
let LAST_LOC = null;
let LOC_INFO = null;
let STATE = { phase: 'not_started', breakType: null, punchIn: null, punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, rosterCode: '', requiresGeofence: true };
let ACTIVE_TAB = 'me';
let TEAM = null;
let TEAM_ERROR = null;
let TEAM_ROSTER = null;
let TEAM_ROSTER_OFFSET = 0;
let RECENT_LOG = null;
let teamPollHandle = null;
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
    if (teamPollHandle) { clearInterval(teamPollHandle); teamPollHandle = null; }
    if (!user) {
      renderSignIn(errorCode === 'unauthorized_domain' ? 'Only ' + ALLOWED_DOMAINS_TEXT + ' accounts are allowed.' : null);
      return;
    }
    CURRENT = user;
    loadCurrentUser();
  });
}

function loadCurrentUser() {
  document.getElementById('app').innerHTML = '<div class="loading">Loading…</div>';
  api({ action: 'getCurrentUser', email: CURRENT.email }).then(onUser).catch(onFatal);
}

function onFatal(err) {
  document.getElementById('app').innerHTML =
    '<div class="card"><h1>Something went wrong</h1><div class="status err">' + err.message + '</div></div>';
}

function onUser(res) {
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
  renderShell();
  if (!IS_MANAGER) {
    refreshDayState();
    requestLocation();
    loadTeamRoster();
  }
}

function refreshDayState(afterMsg) {
  api({ action: 'getDayState', email: CURRENT.email }).then(function (s) {
    STATE = s;
    renderMe();
    if (afterMsg) {
      const msg = document.getElementById('msg');
      if (msg) msg.innerHTML = afterMsg;
    }
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
    loadTeam();
    teamPollHandle = setInterval(loadTeam, 20000);
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

  const phaseText = {
    not_started: STATE.rosterCode ? 'Not punched in &middot; Roster: ' + STATE.rosterCode : 'Not punched in',
    working: 'Working',
    on_break: STATE.breakType ? BREAK_LABEL[STATE.breakType] : 'On Break',
    completed: 'Day complete'
  }[STATE.phase];
  const phaseClass = { not_started: 'phase-idle', working: 'phase-working', on_break: 'phase-break', completed: 'phase-done' }[STATE.phase];

  const canAct = !requiresGeofence || (LOC_INFO && !LOC_INFO.error && LOC_INFO.within);

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

  if (STATE.phase === 'completed') {
    html += '<div class="status ok">You have completed attendance for today.</div>';
  } else if (!canAct) {
    html += '<div class="status err">You must be within office range to punch in/out or take a break.</div>';
  }
  html += '<div id="msg"></div></div>';

  body.innerHTML = html;
  wireRosterNav();
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

function onAction(type) {
  document.querySelectorAll('[data-type]').forEach(function (el) { el.classList.add('pending'); });
  api({ action: 'recordEvent', email: CURRENT.email, type: type, lat: LAST_LOC ? LAST_LOC.lat : '', lng: LAST_LOC ? LAST_LOC.lng : '' })
    .then(function (res) {
      if (res.success) {
        STATE = Object.assign({}, res.state, { rosterCode: res.rosterCode, requiresGeofence: res.requiresGeofence });
        renderMe();
        const msg = document.getElementById('msg');
        if (msg) msg.innerHTML = '<div class="status ok">Recorded at ' + res.time + '.</div>';
      } else {
        // A rejection here means our local STATE disagreed with the server
        // about what's valid right now — trust the server, not our stale
        // guess, so the screen can't get stuck out of sync with it.
        refreshDayState('<div class="status err">' + res.message + '</div>');
      }
    })
    .catch(function (err) {
      // Timed out / network error: the write may well have gone through on
      // the server even though this response never arrived — always
      // reconcile with getDayState rather than assume nothing happened.
      refreshDayState('<div class="status err">' + err.message + '</div>');
    });
}

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
      (TEAM_ERROR ? ' &middot; <span style="color:var(--red);">last refresh failed, showing previous data</span>' : '') + '</div>';
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

function loadTeamRoster() {
  TEAM_ROSTER = null;
  renderActive();
  api({ action: 'getTeamRoster', email: CURRENT.email, weekOffset: TEAM_ROSTER_OFFSET })
    .then(function (r) { TEAM_ROSTER = r; renderActive(); })
    .catch(function () { /* non-fatal — rest of the tab still shows */ });
}

function loadDayEndReport() {
  DAY_REPORT = null;
  renderTeam();
  api({ action: 'getDayEndReport', email: CURRENT.email, date: DAY_REPORT_DATE })
    .then(function (r) { DAY_REPORT = r; renderTeam(); })
    .catch(function () { /* non-fatal — rest of the tab still shows */ });
}

function loadTeam() {
  api({ action: 'getTeamStatus', email: CURRENT.email })
    .then(function (t) { TEAM = t; TEAM_ERROR = null; renderTeam(); })
    .catch(function (err) {
      // A failed poll (transient Apps Script hiccup, timeout, etc.) only
      // ever affects the Team Status card's own content — never wipe the
      // roster grid / Day End Report / Recent Activity that are already
      // showing, and never blank the whole tab over one bad poll out of
      // every 20s.
      TEAM_ERROR = err.message;
      renderTeam();
    });
  api({ action: 'getRecentLog', email: CURRENT.email, limit: 30 })
    .then(function (log) { RECENT_LOG = log; renderTeam(); })
    .catch(function () { /* non-fatal — Team Status card still shows */ });
  // Roster rarely changes within a session — fetch once per tab visit, not
  // on every 20s poll like the live status/log above. Nav clicks (loadTeamRoster)
  // fetch on demand separately.
  if (!TEAM_ROSTER) loadTeamRoster();
  // Same for the Day End Report: refresh on every poll only while looking at
  // today (still filling in); a past date is already final, no need to re-fetch.
  if (!DAY_REPORT || DAY_REPORT_DATE === todayYyyyMmDd_()) loadDayEndReport();
}

boot();

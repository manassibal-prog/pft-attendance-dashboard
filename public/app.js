let FIREBASE_CONFIG = null;
let AUTH = null;
let CURRENT_USER = null;
let EMP = null;
let LAST_LOC = null;
let LOC_INFO = null;
let STATE = { phase: 'not_started', breakType: null, punchIn: null, punchOut: null, breakTotals: { LUNCH: 0, TEA: 0, BIO: 0 }, rosterCode: '', requiresGeofence: true };
let ACTIVE_TAB = 'me';
let TEAM = null;
let teamPollHandle = null;

const BREAK_LABEL = { LUNCH: 'Lunch Break', TEA: 'Tea Break', BIO: 'Bio Break' };

async function boot() {
  const res = await fetch('/api/config');
  FIREBASE_CONFIG = await res.json();
  firebase.initializeApp(FIREBASE_CONFIG);
  AUTH = firebase.auth();
  AUTH.onAuthStateChanged(onAuthChanged);
}

function onAuthChanged(user) {
  CURRENT_USER = user;
  if (!user) {
    renderSignIn();
    return;
  }
  loadMe();
}

async function apiFetch(url, opts) {
  const token = await CURRENT_USER.getIdToken();
  const headers = Object.assign({ Authorization: 'Bearer ' + token }, (opts && opts.headers) || {});
  const res = await fetch(url, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || data.message || ('Request failed: ' + res.status));
    err.data = data;
    throw err;
  }
  return data;
}

function signIn() {
  const provider = new firebase.auth.GoogleAuthProvider();
  provider.setCustomParameters({ hd: FIREBASE_CONFIG.allowedDomain || 'wiom.in' });
  AUTH.signInWithPopup(provider).catch((err) => {
    document.getElementById('app').innerHTML =
      '<div class="card"><h1>Sign-in failed</h1><div class="status err">' + err.message + '</div></div>';
  });
}

function signOut() {
  if (teamPollHandle) clearInterval(teamPollHandle);
  AUTH.signOut();
}

function renderSignIn() {
  document.getElementById('app').innerHTML =
    '<div class="card"><h1>PFT Team Attendance</h1>' +
    '<div class="sub">Sign in with your official @wiom.in Google account.</div>' +
    '<button class="btn-google" id="signInBtn">Sign in with Google</button></div>';
  document.getElementById('signInBtn').addEventListener('click', signIn);
}

async function loadMe() {
  document.getElementById('app').innerHTML = '<div class="loading">Loading your profile…</div>';
  try {
    const res = await apiFetch('/api/me');
    EMP = res.emp;
    renderShell();
    refreshDayState();
    requestLocation();
    setInterval(() => { const el = document.getElementById('clock'); if (el) el.textContent = new Date().toLocaleTimeString(); }, 1000);
  } catch (err) {
    document.getElementById('app').innerHTML =
      '<div class="card"><h1>Access denied</h1><div class="status err">' + err.message + '</div>' +
      '<button class="btn-out" id="soBtn">Sign out</button></div>';
    document.getElementById('soBtn').addEventListener('click', signOut);
  }
}

async function refreshDayState() {
  try {
    const s = await apiFetch('/api/day-state');
    STATE = s;
    renderMe();
  } catch (err) {
    // non-fatal; keep last known state
  }
}

function requestLocation() {
  if (!navigator.geolocation) {
    LOC_INFO = { error: 'Your browser does not support location access.' };
    renderMe();
    return;
  }
  navigator.geolocation.getCurrentPosition((pos) => {
    LAST_LOC = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    apiFetch('/api/location-check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(LAST_LOC) })
      .then((info) => { LOC_INFO = info; renderMe(); })
      .catch((err) => { LOC_INFO = { error: err.message }; renderMe(); });
  }, () => {
    LOC_INFO = { error: 'Location permission denied or unavailable. Enable location access and reload this page.' };
    renderMe();
  }, { enableHighAccuracy: true, timeout: 15000 });
}

function fmtTime(v) {
  if (!v) return '—';
  return new Date(v).toLocaleTimeString();
}

function renderShell() {
  document.getElementById('app').innerHTML =
    '<div class="tabs">' +
    '<div class="tab" id="tabMe">My Attendance</div>' +
    '<div class="tab" id="tabTeam">Team Status</div>' +
    '</div><div id="tabBody"></div>';
  document.getElementById('tabMe').addEventListener('click', () => switchTab('me'));
  document.getElementById('tabTeam').addEventListener('click', () => switchTab('team'));
  switchTab('me');
}

function switchTab(tab) {
  ACTIVE_TAB = tab;
  document.getElementById('tabMe').classList.toggle('active', tab === 'me');
  document.getElementById('tabTeam').classList.toggle('active', tab === 'team');
  if (teamPollHandle) { clearInterval(teamPollHandle); teamPollHandle = null; }
  if (tab === 'me') {
    renderMe();
  } else {
    renderTeam();
    loadTeam();
    teamPollHandle = setInterval(loadTeam, 20000);
  }
}

function renderMe() {
  if (ACTIVE_TAB !== 'me') return;
  const body = document.getElementById('tabBody');
  if (!body) return;

  let html = '<div class="card"><h1>' + EMP.name + '</h1><div class="sub">' + EMP.email + ' &middot; ' + (EMP.empId || '') + '</div>';
  html += '<div id="clock" class="clock">' + new Date().toLocaleTimeString() + '</div>';
  html += '<div class="row"><span class="label">Date</span><span>' + new Date().toLocaleDateString() + '</span></div>';

  const requiresGeofence = STATE.requiresGeofence !== false;
  if (!requiresGeofence) {
    html += '<div class="status info">Today is marked WFH in Roster — location check is not required.</div>';
  } else if (LOC_INFO && LOC_INFO.error) {
    html += '<div class="status err">' + LOC_INFO.error + '</div>';
  } else if (LOC_INFO) {
    html += '<div class="row"><span class="label">Distance from office</span><span>' + LOC_INFO.distance + ' m</span></div>';
    html += '<div class="row"><span class="label">Geofence</span><span class="badge ' + (LOC_INFO.within ? 'badge-ok">Within Range' : 'badge-bad">Out of Range') + '</span></div>';
  } else {
    html += '<div class="status info">Getting your location…</div>';
  }
  html += '<a href="#" class="refresh" id="refreshLoc">Refresh location</a>';
  html += '</div>';

  const phaseText = {
    not_started: STATE.rosterCode ? 'Not punched in (Roster: ' + STATE.rosterCode + ')' : 'Not punched in',
    working: 'Working',
    on_break: STATE.breakType ? BREAK_LABEL[STATE.breakType] : 'On Break',
    completed: 'Day complete',
  }[STATE.phase];
  const phaseClass = { not_started: 'phase-idle', working: 'phase-working', on_break: 'phase-break', completed: 'phase-done' }[STATE.phase];

  html += '<div class="card">';
  html += '<div class="phasebar ' + phaseClass + '">' + phaseText + '</div>';
  html += '<div class="row"><span class="label">Punch In</span><span>' + fmtTime(STATE.punchIn) + '</span></div>';
  html += '<div class="row"><span class="label">Punch Out</span><span>' + fmtTime(STATE.punchOut) + '</span></div>';
  html += '<div class="row"><span class="label">Lunch Break</span><span>' + Math.round((STATE.breakTotals && STATE.breakTotals.LUNCH) || 0) + ' min</span></div>';
  html += '<div class="row"><span class="label">Tea Break</span><span>' + Math.round((STATE.breakTotals && STATE.breakTotals.TEA) || 0) + ' min</span></div>';
  html += '<div class="row"><span class="label">Bio Break</span><span>' + Math.round((STATE.breakTotals && STATE.breakTotals.BIO) || 0) + ' min</span></div>';

  const canAct = !requiresGeofence || (LOC_INFO && !LOC_INFO.error && LOC_INFO.within);
  const dis = canAct ? '' : 'disabled';

  if (STATE.phase === 'not_started') {
    html += '<button class="btn-in" data-type="PUNCH_IN" ' + dis + '>Punch In</button>';
  } else if (STATE.phase === 'working') {
    html += '<div class="grid2">';
    html += '<button class="btn-break" data-type="LUNCH_START" ' + dis + '>Start Lunch Break</button>';
    html += '<button class="btn-break" data-type="TEA_START" ' + dis + '>Start Tea Break</button>';
    html += '</div>';
    html += '<button class="btn-break" data-type="BIO_START" ' + dis + '>Start Bio Break</button>';
    html += '<button class="btn-out" data-type="PUNCH_OUT" ' + dis + '>Punch Out</button>';
  } else if (STATE.phase === 'on_break') {
    html += '<button class="btn-end" data-type="' + STATE.breakType + '_END" ' + dis + '>End ' + BREAK_LABEL[STATE.breakType] + '</button>';
  } else if (STATE.phase === 'completed') {
    html += '<div class="status ok">You have completed attendance for today.</div>';
  }
  if (!canAct && STATE.phase !== 'completed') {
    html += '<div class="status err">You must be within office range to punch in/out or take a break.</div>';
  }
  html += '<div id="msg"></div>';
  html += '<button class="btn-google" id="soBtn2" style="margin-top:16px;">Sign out</button>';
  html += '</div>';

  body.innerHTML = html;
  document.getElementById('refreshLoc').addEventListener('click', (e) => { e.preventDefault(); LOC_INFO = null; renderMe(); requestLocation(); });
  document.getElementById('soBtn2').addEventListener('click', signOut);
  document.querySelectorAll('button[data-type]').forEach((btn) => {
    btn.addEventListener('click', () => onAction(btn.getAttribute('data-type'), btn));
  });
}

async function onAction(type, btn) {
  document.querySelectorAll('button[data-type]').forEach((b) => { b.disabled = true; });
  btn.textContent = 'Please wait…';
  try {
    const res = await apiFetch('/api/punch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, lat: LAST_LOC ? LAST_LOC.lat : null, lng: LAST_LOC ? LAST_LOC.lng : null }),
    });
    STATE = Object.assign({}, res.state, { rosterCode: res.rosterCode, requiresGeofence: res.requiresGeofence });
    document.getElementById('msg') && (document.getElementById('msg').innerHTML = '<div class="status ok">Recorded at ' + new Date(res.time).toLocaleTimeString() + '.</div>');
    renderMe();
  } catch (err) {
    renderMe();
    const msgEl = document.getElementById('msg');
    if (msgEl) msgEl.innerHTML = '<div class="status err">' + err.message + '</div>';
  }
}

function renderTeam() {
  if (ACTIVE_TAB !== 'team') return;
  const body = document.getElementById('tabBody');
  if (!body) return;
  if (!TEAM) {
    body.innerHTML = '<div class="loading">Loading team status…</div>';
    return;
  }
  let html = '<div class="card"><h1>Team Status</h1><div class="sub">Live · updates every 20s · as of ' + new Date(TEAM.asOf).toLocaleTimeString() + '</div>';
  TEAM.employees.forEach((e) => {
    const cls = 'st-' + String(e.status || '').replace(/\s+/g, '');
    html += '<div class="team-row"><div><div class="team-name">' + e.name + '</div><div class="team-sub">' + (e.department || '') +
      (e.punchIn ? ' · in ' + fmtTime(e.punchIn) : '') + (e.punchOut ? ' · out ' + fmtTime(e.punchOut) : '') + '</div></div>' +
      '<span class="status-pill ' + cls + '">' + (e.status || '—') + '</span></div>';
  });
  html += '</div>';
  body.innerHTML = html;
}

async function loadTeam() {
  try {
    TEAM = await apiFetch('/api/team-status');
    renderTeam();
  } catch (err) {
    const body = document.getElementById('tabBody');
    if (body && ACTIVE_TAB === 'team') body.innerHTML = '<div class="card status err">' + err.message + '</div>';
  }
}

boot();

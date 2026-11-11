// "Available Paid Leaves": the number under each person's name in rows 1-2 of the
// Roster tab, shown to that person (and only that person) on their Leave Requests
// card. Backend: the real getMyLeave / availableLeavesFromTop_ from Code.gs
// against an in-memory Roster sheet. Frontend: the real renderLeaveBalance_ /
// loadLeave_ / hydrate code sliced out of app.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function t(label, fn) {
  return Promise.resolve().then(fn).then(
    function () { console.log('PASS', label); },
    function (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
  );
}
function assertEq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error((msg || '') + ' expected ' + JSON.stringify(b) + ' got ' + JSON.stringify(a)); }

// ---------- backend ----------
function makeSheet(rows) {
  const width = function () { return Math.max.apply(null, rows.map(function (r) { return r.length; }).concat([1])); };
  return {
    rows: rows,
    getDataRange: function () { return { getValues: function () { return rows.map(function (r) { const c = r.slice(); while (c.length < width()) c.push(''); return c; }); } }; },
    appendRow: function (r) { rows.push(r.slice()); },
    getLastRow: function () { return rows.length; },
    getLastColumn: function () { return width(); },
    setFrozenRows: function () {},
    getRange: function (r, c, nr, nc) {
      return {
        getValues: function () {
          const out = [];
          for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) { const v = (rows[r - 1 + i] || [])[c - 1 + j]; row.push(v === undefined ? '' : v); } out.push(row); }
          return out;
        },
        setValue: function (v) { while (rows.length < r) rows.push([]); while (rows[r - 1].length < c) rows[r - 1].push(''); rows[r - 1][c - 1] = v; },
        setValues: function (vs) { vs.forEach(function (vr, i) { while (rows.length < r + i) rows.push([]); vr.forEach(function (v, j) { while (rows[r - 1 + i].length < c + j) rows[r - 1 + i].push(''); rows[r - 1 + i][c - 1 + j] = v; }); }); },
        setFontWeight: function () {}, setNumberFormat: function () {}, setDataValidation: function () {}
      };
    }
  };
}

// Mirrors the real tab: label + names across row 1 (names from column K), the "Q4" label and the numbers in row 2.
function rosterTop() {
  const names = ['Available leaves', '', '', '', '', '', '', '', '', 'Amar', 'Pintoo', 'Noor', 'Hitesh', 'Sandeep', 'Deeksha', 'Kriti', 'Dhananjay', 'Anas', 'Nirmal', 'Tushar'];
  const nums = ['', 'Q4', '', '', '', '', '', '', '', 1, 0, 1, 1, 2, 0, 1, 0, 3, 3, 3];
  return [names, nums];
}

function makeBackend(opts) {
  opts = opts || {};
  const sheets = {
    'Employee Master': makeSheet([
      ['Emp ID', 'Employee Name', 'Official Email', 'Department', 'Designation', 'Shift Start', 'Shift End', 'Weekly Off Day', 'Status'],
      ['E1', 'Amar', 'amar@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E2', 'Pintoo', 'pintoo@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active'],
      ['E3', 'Nobody Listed', 'nl@wiom.in', 'PFT', 'Advisor', '10:00', '19:00', 'Sunday', 'Active']
    ])
  };
  if (!opts.noRoster) sheets['Roster'] = makeSheet(opts.top || rosterTop());
  const sandbox = {
    console,
    SpreadsheetApp: { getActiveSpreadsheet: function () { return { getSheetByName: function (n) { if (opts.rosterThrows && n === 'Roster') throw new Error('boom'); return sheets[n] || null; }, insertSheet: function (n) { sheets[n] = makeSheet([]); return sheets[n]; } }; } },
    Session: { getScriptTimeZone: function () { return 'Asia/Kolkata'; } },
    LockService: { getScriptLock: function () { return { waitLock: function () {}, releaseLock: function () {} }; } },
    Utilities: { formatDate: function () { return ''; } },
    HtmlService: {}, ContentService: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8'), sandbox);
  return { A: vm.runInContext('ACTIONS', sandbox), fn: vm.runInContext('availableLeavesFromTop_', sandbox), sheets: sheets };
}

// ---------- frontend ----------
const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
function slice(from, to) {
  const a = appSrc.indexOf(from), b = appSrc.indexOf(to, a);
  if (a < 0 || b < a) throw new Error('could not locate ' + from + ' .. ' + to);
  return appSrc.slice(a, b);
}
const uiSrc = slice('function esc_(v)', 'function ymd_(d)') + slice('// "Available Paid Leaves:', 'function renderLeaveCard_() {') + slice('function loadLeave_()', 'function submitLeave_()');
function makeUi(reply) {
  const env = { cache: {}, renders: 0 };
  const sandbox = {
    LEAVE: null, LEAVE_BAL: null, LEAVE_ERROR: null,
    CURRENT: { email: 'amar@wiom.in' },
    sortLeave_: function (l) { return l; },
    renderMe: function () { env.renders++; },
    cacheSet: function (e, n, v) { env.cache[e + '|' + n] = JSON.parse(JSON.stringify(v)); },
    api: function () { return Promise.resolve(reply); }
  };
  vm.createContext(sandbox);
  vm.runInContext(uiSrc, sandbox);
  env.sb = sandbox;
  return env;
}

(async function () {
  // ----- backend -----
  await t("each person gets their own number from row 2, under their name in row 1, with the period label", () => {
    const b = makeBackend();
    assertEq(b.A.getMyLeave({ email: 'amar@wiom.in' }).balance, { available: 1, period: 'Q4' });
    assertEq(b.A.getMyLeave({ email: 'pintoo@wiom.in' }).balance, { available: 0, period: 'Q4' });
  });

  await t("a person never receives anyone else's number (nor the whole table)", () => {
    const b = makeBackend();
    const res = b.A.getMyLeave({ email: 'amar@wiom.in' });
    const text = JSON.stringify(res);
    assertEq(Object.keys(res.balance).sort(), ['available', 'period']);
    ['Pintoo', 'Noor', 'Tushar', 'Available leaves'].forEach((x) => assertEq(text.indexOf(x), -1, x));
    // the email asked about decides the answer — Amar's request can't be steered to Pintoo's column
    assertEq(b.A.getMyLeave({ email: 'amar@wiom.in', name: 'Pintoo', empId: 'E2' }).balance.available, 1);
  });

  await t('names match regardless of case and stray spaces', () => {
    const b = makeBackend({ top: [['x', '  AMAR '], ['', 5]] });
    assertEq(b.fn([['x', '  AMAR '], ['', 5]], 'amar'), { available: 5, period: '' });
  });

  await t('a header with a first name only matches a full employee name — but only when unambiguous', () => {
    const top = [['', 'Amar', 'Pintoo'], ['Q4', 2, 4]];
    const b = makeBackend();
    assertEq(b.fn(top, 'Amar Singh'), { available: 2, period: 'Q4' });
    assertEq(b.fn([['', 'Amar', 'Amar'], ['Q4', 2, 4]], 'Amar Singh'), null, 'two columns both say Amar: refuse to guess');
  });

  await t('someone not listed gets no balance (null), and the rest of the leave screen still works', () => {
    const b = makeBackend();
    const res = b.A.getMyLeave({ email: 'nl@wiom.in' });
    assertEq(res.balance, null);
    assertEq(res.requests, []);
  });

  await t('an empty or non-numeric cell gives no balance rather than a made-up 0', () => {
    const b = makeBackend();
    [['', null], ['n/a', null], [true, null], ['2', { available: 2, period: '' }], [1.5, { available: 1.5, period: '' }]].forEach(([cell, want]) => {
      assertEq(b.fn([['Amar'], [cell]], 'Amar'), want, JSON.stringify(cell));
    });
  });

  await t('Roster tab missing, unreadable or too short: leave still loads, balance is null', () => {
    assertEq(makeBackend({ noRoster: true }).A.getMyLeave({ email: 'amar@wiom.in' }).balance, null);
    assertEq(makeBackend({ rosterThrows: true }).A.getMyLeave({ email: 'amar@wiom.in' }).balance, null);
    assertEq(makeBackend({ top: [['Amar']] }).A.getMyLeave({ email: 'amar@wiom.in' }).balance, null);
  });

  await t('only the top two rows are read, not the whole Roster tab', () => {
    const b = makeBackend();
    let wholeSheet = 0;
    const sh = b.sheets['Roster'];
    const orig = sh.getDataRange;
    sh.getDataRange = function () { wholeSheet++; return orig.apply(this, arguments); };
    b.A.getMyLeave({ email: 'amar@wiom.in' });
    assertEq(wholeSheet, 0);
  });

  // ----- frontend -----
  await t('the card shows "Available Paid Leaves", the number and the period', () => {
    const env = makeUi({});
    env.sb.LEAVE_BAL = { available: 1, period: 'Q4' };
    const html = env.sb.renderLeaveBalance_();
    assertEq(html.indexOf('Available Paid Leaves') > -1 && html.indexOf('>1<') > -1 && html.indexOf('Q4') > -1, true, html);
    assertEq(html.indexOf('leave-bal-zero'), -1);
  });

  await t('zero is shown (and flagged), not hidden', () => {
    const env = makeUi({});
    env.sb.LEAVE_BAL = { available: 0, period: '' };
    const html = env.sb.renderLeaveBalance_();
    assertEq(html.indexOf('>0<') > -1 && html.indexOf('leave-bal-zero') > -1, true, html);
  });

  await t('no balance known: nothing is drawn (no "undefined", no empty box)', () => {
    const env = makeUi({});
    [null, undefined, {}, { available: null }, { available: 'x' }].forEach((v) => { env.sb.LEAVE_BAL = v; assertEq(env.sb.renderLeaveBalance_(), '', JSON.stringify(v)); });
  });

  await t('loading leave stores the balance on screen and in the saved copy', async () => {
    const env = makeUi({ requests: [], balance: { available: 3, period: 'Q4' } });
    await env.sb.loadLeave_();
    assertEq(env.sb.LEAVE_BAL, { available: 3, period: 'Q4' });
    assertEq(env.cache['amar@wiom.in|leavebal'], { available: 3, period: 'Q4' });
  });

  await t('an older server reply with no balance field leaves nothing on screen', async () => {
    const env = makeUi({ requests: [] });
    await env.sb.loadLeave_();
    assertEq(env.sb.LEAVE_BAL, null);
  });

  await t('a failed load keeps the last known balance', async () => {
    const env = makeUi({});
    env.sb.api = function () { return Promise.reject(new Error('offline')); };
    env.sb.LEAVE_BAL = { available: 2, period: 'Q4' };
    env.sb.LEAVE = [];
    await env.sb.loadLeave_();
    assertEq(env.sb.LEAVE_BAL, { available: 2, period: 'Q4' });
  });

  await t('wiring: reset, saved-copy hydrate, and the card heading all know about the balance', () => {
    assertEq(/function resetSessionData_\(\) \{[\s\S]*?LEAVE_BAL = null/.test(appSrc), true, 'reset on sign-out / user change');
    assertEq(appSrc.indexOf("cacheGet(email, 'leavebal')") > -1, true, 'hydrate');
    assertEq(/<h1>Leave Requests<\/h1>[\s\S]{0,300}renderLeaveBalance_\(\)/.test(appSrc), true, 'shown inside the Leave Requests card');
  });

  console.log('done');
})();

// The "Base data" link at the foot of the page is for team leads only.
// setBaseDataFooter_ and its calls in onUser are read from the real docs/js/app.js.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const appSrc = fs.readFileSync(path.join(__dirname, '..', 'docs', 'js', 'app.js'), 'utf8');
const a = appSrc.indexOf('function setBaseDataFooter_(show) {');
const b = appSrc.indexOf('function renderMobileBlocked() {');
if (a < 0 || b < a) throw new Error('could not locate setBaseDataFooter_');
const onUser = appSrc.slice(appSrc.indexOf('function onUser(res) {'), appSrc.indexOf('function refreshDayState'));

function t(label, fn) {
  try { fn(); console.log('PASS', label); }
  catch (e) { console.log('FAIL', label, '-', e.message); process.exitCode = 1; }
}
function assertEq(x, y, msg) { if (JSON.stringify(x) !== JSON.stringify(y)) throw new Error((msg || '') + ' expected ' + JSON.stringify(y) + ' got ' + JSON.stringify(x)); }

function footerEnv(url) {
  const foot = { hidden: true }, link = { href: '' };
  const sb = {
    CONFIG: { BASE_DATA_URL: url },
    document: { getElementById: function (id) { return id === 'pageFoot' ? foot : id === 'baseDataLink' ? link : null; } }
  };
  vm.createContext(sb);
  vm.runInContext(appSrc.slice(a, b), sb);
  return { sb: sb, foot: foot, link: link };
}

t('shown, with the link, when told to show', () => {
  const e = footerEnv('https://example.test/sheet');
  e.sb.setBaseDataFooter_(true);
  assertEq([e.foot.hidden, e.link.href], [false, 'https://example.test/sheet']);
});
t('hidden when told to hide', () => {
  const e = footerEnv('https://example.test/sheet');
  e.sb.setBaseDataFooter_(true);
  e.sb.setBaseDataFooter_(false);
  assertEq(e.foot.hidden, true);
});
t('never shown without a configured address', () => {
  const e = footerEnv('');
  e.sb.setBaseDataFooter_(true);
  assertEq(e.foot.hidden, true);
});
t('onUser shows it only to team leads: it is passed IS_MANAGER, not a constant true', () => {
  assertEq(/setBaseDataFooter_\(IS_MANAGER\);/.test(onUser), true);
  assertEq(/setBaseDataFooter_\(true\)/.test(onUser), false, 'no unconditional show left');
});
t('it stays hidden on the sign-in screen, the access-denied screen and the blocked-device screen', () => {
  assertEq((onUser.match(/setBaseDataFooter_\(false\)/g) || []).length, 2, 'access denied + blocked device');
  assertEq(/if \(!user\) \{\s*setBaseDataFooter_\(false\);/.test(appSrc), true, 'signed out');
});

console.log('done');

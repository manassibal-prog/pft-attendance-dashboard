// Saved copies of the last server answers (roster, team status, today's
// state…) so a screen can paint instantly from what this browser saw last,
// while the real request refreshes it in the background. Snapshots are keyed
// per signed-in email, only valid on the calendar day they were saved (a
// yesterday's "Working" is worse than a blank), and wiped on sign-out.
// localStorage can be blocked or full — every call degrades to "no cache".

const PREFIX = 'pft-cache:';

function key_(email, name) { return PREFIX + String(email).trim().toLowerCase() + ':' + name; }

export function localDay() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

// isValid(entry) overrides the default "saved today" rule; entry is { at, day, v }.
export function cacheGet(email, name, isValid) {
  try {
    const entry = JSON.parse(localStorage.getItem(key_(email, name)));
    if (!entry || entry.v === undefined || entry.v === null) return null;
    const ok = isValid ? isValid(entry) : entry.day === localDay();
    return ok ? entry.v : null;
  } catch (_) { return null; }
}

export function cacheSet(email, name, value) {
  try { localStorage.setItem(key_(email, name), JSON.stringify({ at: Date.now(), day: localDay(), v: value })); } catch (_) { /* no cache, fine */ }
}

export function cacheClearAll() {
  try {
    const doomed = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(PREFIX) === 0) doomed.push(k);
    }
    doomed.forEach(function (k) { localStorage.removeItem(k); });
  } catch (_) {}
}

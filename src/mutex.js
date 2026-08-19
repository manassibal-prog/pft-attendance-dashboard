// Per-key mutex so concurrent punch requests for the SAME employee can't
// race each other into duplicate Daily Attendance Log rows, without making
// unrelated employees' punches queue behind each other (mirrors Apps
// Script's LockService.getScriptLock(), scoped down to what actually needs
// exclusivity).
const tails = new Map();

function withLock(key, fn) {
  const prev = tails.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  tails.set(key, run.catch(() => {}));
  return run;
}

module.exports = { withLock };

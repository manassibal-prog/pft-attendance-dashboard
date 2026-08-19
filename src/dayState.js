// Pure state-machine logic for the punch-in/out + breaks flow.
// No I/O here so it can be unit-tested without touching Sheets/Firebase.

const BREAK_TYPES = ['LUNCH', 'TEA', 'BIO'];

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Replays today's successful events (ascending, {type, timestamp: Date}) into a phase.
function computeDayState(events) {
  let phase = 'not_started';
  let breakType = null;
  let punchIn = null;
  let punchOut = null;
  const breakStart = { LUNCH: null, TEA: null, BIO: null };
  const breakTotals = { LUNCH: 0, TEA: 0, BIO: 0 };

  events.forEach((e) => {
    if (e.type === 'PUNCH_IN') {
      punchIn = e.timestamp;
      phase = 'working';
    } else if (e.type === 'PUNCH_OUT') {
      punchOut = e.timestamp;
      phase = 'completed';
    } else if (e.type.endsWith('_START')) {
      const bt = e.type.split('_')[0];
      breakStart[bt] = e.timestamp;
      phase = 'on_break';
      breakType = bt;
    } else if (e.type.endsWith('_END')) {
      const bt = e.type.split('_')[0];
      if (breakStart[bt]) breakTotals[bt] += (e.timestamp - breakStart[bt]) / 60000;
      phase = 'working';
      breakType = null;
    }
  });

  return { phase, breakType, punchIn, punchOut, breakTotals };
}

function validTransition(phase, breakType, type) {
  if (type === 'PUNCH_IN') return phase === 'not_started';
  if (type === 'PUNCH_OUT') return phase === 'working';
  if (type === 'LUNCH_START' || type === 'TEA_START' || type === 'BIO_START') return phase === 'working';
  if (type === 'LUNCH_END') return phase === 'on_break' && breakType === 'LUNCH';
  if (type === 'TEA_END') return phase === 'on_break' && breakType === 'TEA';
  if (type === 'BIO_END') return phase === 'on_break' && breakType === 'BIO';
  return false;
}

function labelForBreak(bt) {
  return bt ? bt.charAt(0) + bt.slice(1).toLowerCase() + ' Break' : 'break';
}

function transitionErrorMessage(state, type) {
  if (type === 'PUNCH_IN') return 'You have already punched in today.';
  if (type === 'PUNCH_OUT') {
    if (state.phase === 'on_break') return 'End your ' + labelForBreak(state.breakType) + ' before punching out.';
    if (state.phase === 'not_started') return 'You need to punch in first.';
    if (state.phase === 'completed') return 'You have already punched out today.';
  }
  if (type.endsWith('_START')) {
    if (state.phase === 'on_break') return 'You are already on a ' + labelForBreak(state.breakType) + '. End it before starting another break.';
    if (state.phase === 'not_started') return 'You need to punch in before taking a break.';
    if (state.phase === 'completed') return 'You have already punched out today.';
  }
  if (type.endsWith('_END')) return 'You are not currently on that break.';
  return 'That action is not available right now.';
}

function parseShiftTime(shiftStart, referenceDate) {
  let h, m;
  if (typeof shiftStart === 'string' && shiftStart.indexOf(':') > -1) {
    const parts = shiftStart.split(':');
    h = Number(parts[0]);
    m = Number(parts[1]);
  } else {
    return null;
  }
  if (Number.isNaN(h) || Number.isNaN(m)) return null;
  const d = new Date(referenceDate);
  d.setHours(h, m, 0, 0);
  return d;
}

// Derives the Daily Attendance Log row values for one employee/day from their
// day state + today's Roster code. Mirrors the Apps Script version, plus
// Roster-driven status fallback for days with no punch yet.
function deriveSummary(state, rosterCode, shiftStart, graceMinutes) {
  const totalBreak = state.breakTotals.LUNCH + state.breakTotals.TEA + state.breakTotals.BIO;
  let gross = '';
  let net = '';
  let lateBy = 0;
  let status = rosterCode || 'Not Started';

  if (state.punchIn) {
    const shiftStartDate = parseShiftTime(shiftStart, state.punchIn);
    if (shiftStartDate) {
      // Gate by the grace period immediately so this number reads the same
      // whether the day is still in progress or already punched out — it
      // used to show raw (ungated) minutes late all day, then silently
      // drop to 0 the moment they punched out, for the same punch-in time.
      const rawLate = Math.max(0, Math.round((state.punchIn - shiftStartDate) / 60000));
      lateBy = rawLate > graceMinutes ? rawLate : 0;
    }
    status = 'Working';
  }
  if (state.phase === 'on_break') status = labelForBreak(state.breakType);
  if (state.punchIn && state.punchOut) {
    gross = Math.round(((state.punchOut - state.punchIn) / 3600000) * 100) / 100;
    net = Math.round((gross - totalBreak / 60) * 100) / 100;
    status = net < 4 ? 'Half Day' : lateBy > 0 ? 'Late' : 'Present';
  }

  return {
    punchIn: state.punchIn,
    punchOut: state.punchOut,
    lunch: Math.round(state.breakTotals.LUNCH),
    tea: Math.round(state.breakTotals.TEA),
    bio: Math.round(state.breakTotals.BIO),
    totalBreak: Math.round(totalBreak),
    gross,
    net,
    lateBy,
    status,
  };
}

module.exports = {
  BREAK_TYPES,
  haversineMeters,
  computeDayState,
  validTransition,
  labelForBreak,
  transitionErrorMessage,
  parseShiftTime,
  deriveSummary,
};

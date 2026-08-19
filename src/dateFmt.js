// Sheets cell values round-trip through this module as an explicit
// "DD/MMM/YYYY[ HH:mm:ss]" text format (matching the style already used in
// the Roster tab), written with valueInputOption=RAW so Sheets never
// re-parses it. This avoids depending on the spreadsheet's locale — a plain
// "08/09/2026" written via USER_ENTERED is genuinely ambiguous (8-Sep or
// Aug-9?) between JS's Date parser and Sheets' own locale-dependent parser,
// and a mismatch there would silently corrupt attendance dates.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function zone() {
  return process.env.TIMEZONE || 'Asia/Kolkata';
}

// Deliberately requests numeric month, not Intl's 'short' month name — ICU
// abbreviations vary by environment (e.g. en-GB gives "Sept", not "Sep", for
// September on some Node builds), which would silently break parsing.
function partsInZone(date) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const parts = {};
  fmt.formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  parts.monthName = MONTHS[Number(parts.month) - 1];
  return parts;
}

function toDateOnlyString(date) {
  const p = partsInZone(date);
  return `${p.day}/${p.monthName}/${p.year}`;
}

function toDateTimeString(date) {
  const p = partsInZone(date);
  return `${p.day}/${p.monthName}/${p.year} ${p.hour}:${p.minute}:${p.second}`;
}

// Offset (minutes, positive = ahead of UTC) of `zone()` at the instant `date`.
function getZoneOffsetMinutes(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone(), hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  dtf.formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const asUTC = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(hour), Number(parts.minute), Number(parts.second));
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Parses "DD/MMM/YYYY" or "DD/MMM/YYYY HH:mm:ss" as wall-clock time in
// `zone()`, returning the correct UTC instant (Date object).
function parseDateTimeString(str) {
  if (!str) return null;
  const m = String(str).trim().match(/^(\d{2})\/([A-Za-z]{3})\/(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = MONTHS.indexOf(m[2]);
  const year = Number(m[3]);
  if (month < 0) return null;
  const hour = m[4] ? Number(m[4]) : 0;
  const minute = m[5] ? Number(m[5]) : 0;
  const second = m[6] ? Number(m[6]) : 0;

  const utcGuess = new Date(Date.UTC(year, month, day, hour, minute, second));
  const offsetMinutes = getZoneOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60000);
}

function ymd(date) {
  const p = partsInZone(date);
  return `${p.year}-${p.month}-${p.day}`;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Weekday name in `zone()` — deliberately not date.getDay(), which reads the
// server process's local timezone (UTC on most hosts), and would give the
// wrong day near midnight IST.
function weekdayInZone(date) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone(), weekday: 'long' });
  return fmt.format(date);
}

module.exports = { zone, toDateOnlyString, toDateTimeString, parseDateTimeString, ymd, weekdayInZone, WEEKDAYS };

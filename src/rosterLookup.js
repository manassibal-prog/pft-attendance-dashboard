// Parses the "Roster" tab's stacked monthly blocks (2-row header: weekday +
// "dd/MMM/yyyy" date, employee rows below keyed by Name, date columns from
// column K onward) and finds today's code for a given employee.
// Read-only — never writes to Roster; it's the admin-maintained planning tab.

function formatDdMmmYyyy(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dd = String(date.getDate()).padStart(2, '0');
  return `${dd}/${months[date.getMonth()]}/${date.getFullYear()}`;
}

// Sheets API values.get (default FORMATTED_VALUE render) always returns
// cells as strings/numbers/booleans, never Date objects — so this only
// needs to handle strings.
function cellToDateString(cell) {
  return typeof cell === 'string' ? cell.trim() : '';
}

// grid: 2D array from Sheets values.get (rows of arrays, ragged is fine).
function findTodayColumn(grid, todayStr) {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r] || [];
    for (let c = 0; c < row.length; c++) {
      if (cellToDateString(row[c]) === todayStr) {
        return { headerRow: r, col: c };
      }
    }
  }
  return null;
}

// From the date-header row, walk down collecting employee rows (Name in
// column 1 / index 1) until a blank name or another block's header appears.
function findEmployeeRow(grid, headerRow, employeeName) {
  const target = String(employeeName).trim().toLowerCase();
  for (let r = headerRow + 1; r < grid.length; r++) {
    const row = grid[r] || [];
    const name = row[1]; // column B
    if (!name || String(name).trim() === '') break;
    if (String(name).trim().toLowerCase() === 'name') break; // ran into next block's header
    if (String(name).trim().toLowerCase() === target) return r;
  }
  return null;
}

// Returns the roster code string (e.g. 'P','WO','L','Holiday','WFH','UP') for
// the employee today, or '' if not found / not yet filled in.
function getTodayRosterCode(rosterGrid, employeeName, now) {
  const todayStr = formatDdMmmYyyy(now || new Date());
  const found = findTodayColumn(rosterGrid, todayStr);
  if (!found) return '';
  const empRow = findEmployeeRow(rosterGrid, found.headerRow, employeeName);
  if (empRow === null) return '';
  const row = rosterGrid[empRow] || [];
  const code = row[found.col];
  return code ? String(code).trim() : '';
}

module.exports = { formatDdMmmYyyy, findTodayColumn, findEmployeeRow, getTodayRosterCode };

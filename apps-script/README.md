# PFT Attendance — Apps Script version (recommended)

Punch in/out + Lunch/Tea/Bio breaks + live Team Status, bound directly to the
team's Google Sheet. No separate hosting, no Firebase project, no service
account — identity and data access both come free from being an Apps Script
project attached to the Sheet itself.

This supersedes the Node/Railway/Firebase app in the repo root, which is
parked for now after hitting deployment friction unrelated to the app code.

## What it does

- **Punch In → any number of Lunch/Tea/Bio breaks (each closed before another
  starts) → Punch Out.** Invalid sequences are rejected server-side.
- **Geofenced** against the office coordinates in the Settings tab — except
  on days Roster marks that employee `WFH`, where the check is skipped.
- **Roster-aware**: reads today's code for each employee straight from the
  Roster tab (read-only — this never writes to Roster). `WO` / `L` / `Holiday`
  days still leave Punch In available; `UP` = unpaid leave.
- **Manager vs Advisor views**: anyone whose Employee Master **Designation**
  contains "Team Leader" or "Manager" (case-insensitive) gets a **Team
  Status** tab — live-polling (every 20s) status for everyone plus a Recent
  Activity log of the last 30 punch/break events. Everyone else sees only
  their own attendance, no tab bar. Enforced server-side, not just hidden in
  the UI — `getTeamStatus`/`getRecentLog` reject non-managers outright.
- Identity comes from `Session.getActiveUser().getEmail()` — the Google
  account the visitor is actually signed into — never trusted from the client.

## Setup (~10 minutes)

1. Open the Sheet → **Extensions → Apps Script**.
2. Replace the default `Code.gs` content with [`Code.gs`](Code.gs) from this folder.
3. **File → New → HTML**, name it exactly `Index` (becomes `Index.html`), paste in [`Index.html`](Index.html).
4. Save. Run **initializeSheets** once from the function dropdown → grant the
   permissions it asks for. Creates any missing tabs (Employee Master,
   Settings, Daily Attendance Log, Punch Events Log, Monthly Summary) with headers.
5. In the **Settings** tab, fill in real Office Latitude/Longitude/Radius
   (Google Maps → right-click your office → click the coordinates to copy).
6. In **Employee Master**, make sure every active team member has their
   **Official Email** (@wiom.in), Shift Start, and Weekly Off Day filled in —
   this is how the app matches a Google sign-in to a person.
7. **Deploy → New deployment → Web app.** Execute as **"User accessing the
   web app"**; Who has access: **"Anyone within wiom.in"**. Deploy, authorize,
   copy the URL.
8. Test yourself first: open the URL on your phone, allow location, Punch In
   → a break → Punch Out, confirm Daily Attendance Log updates, check Team
   Status shows you.
9. Share the URL with the team.

## Updating later

Edit `Code.gs` / `Index.html` here, commit to GitHub for history, then sync
to the live project with [clasp](https://github.com/google/clasp) (Google's
official CLI) instead of copy-pasting into the Apps Script editor:

```bash
cd apps-script
npx @google/clasp push
npx @google/clasp deploy --deploymentId AKfycbz1HM_Ud45vJh_6LjWkwKHOore8igJIj95k98a9pihWsLwXo-BF69MoYoZHDGTgtO5b --description "what changed"
```

`push` alone only updates the editor's HEAD copy — the live `/exec` URL is
pinned to a specific deployment *version*, so the `deploy` step (targeting
the deployment ID above, which is the one behind the current live URL) is
what actually makes a change visible without changing the URL.

One-time setup this required (already done for this project, documented in
case it needs redoing): enable the "Google Apps Script API" toggle at
https://script.google.com/home/usersettings, `npx @google/clasp login`, then
`apps-script/.clasp.json` links this folder to script ID
`1hUben5Cct8dtwoItbFb9vll00XZP2ML_jMBPZ7f4pk_MGdRY_SuffIoh`.
`.claspignore` keeps `test.js`/`README.md` (Node-only files that would break
if pushed as Apps Script source) out of what gets synced.

## Testing changes before pasting them in

Apps Script can't run outside Google's environment, but `Code.gs`'s pure
logic (state machine, roster block parsing, lateBy grace-gating) is
extracted and run against known cases in a sandboxed Node context:

```bash
node apps-script/test.js
```

Run this after editing `Code.gs`, before pasting the update into the Apps
Script editor.

## Tuning

- Half-day threshold (net hours < 4) and late grace (Settings tab, default
  15 min) live in `updateDailySummary_` / the sheet.
- Team Status poll interval: `teamPollHandle` in `Index.html` (default 20s).
- Roster block format (2-row header, date columns from column K) is parsed
  in `rosterCodeFromGrid_` / `findTodayColumn_` / `findEmployeeRow_` in `Code.gs`.

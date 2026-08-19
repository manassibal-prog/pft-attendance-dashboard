# PFT Attendance — Apps Script backend

Headless JSON API bound directly to the team's Google Sheet. It no longer
serves any HTML — the frontend lives in [`../docs`](../docs) as a static
site on GitHub Pages, which is the URL the team actually visits.

This split exists to avoid Apps Script's own per-visitor OAuth consent
screen: a Web App deployed as "Execute as: User accessing" makes every new
visitor authorize the script individually (an "Unverified app" warning most
people find alarming). Deployed instead as **"Execute as: Me" / "Anyone"**,
this API needs no Google authorization at all to call — identity comes from
Firebase Google Sign-In on the frontend (same pattern as the team's other
dashboard, `wiom-l2`), and every request is checked server-side against a
shared API key, the `@wiom.in` domain, and Employee Master.

## What it does

- **Punch In → any number of Lunch/Tea/Bio breaks (each closed before another
  starts) → Punch Out.** Invalid sequences are rejected server-side.
- **Geofenced** against the office coordinates in the Settings tab — except
  on days Roster marks that employee `WFH`, where the check is skipped.
- **Roster-aware**: reads today's code for each employee straight from the
  Roster tab (read-only — this never writes to Roster). `WO` / `L` / `Holiday`
  days still leave Punch In available; `UP` = unpaid leave.
- **Manager vs Advisor**: anyone whose Employee Master **Designation**
  contains "Team Leader" or "Manager" (case-insensitive) can call the
  manager-only actions (`getTeamStatus`, `getRecentLog`, `getTeamRoster`) —
  enforced server-side, not just hidden in the UI.
- Identity is the `email` param sent with every request (set by the frontend
  from the signed-in Firebase user) — verified against `@wiom.in` and
  Employee Master before anything is trusted.

## API shape

Every action is a `GET` to the deployed `/exec` URL (GET, not POST — Apps
Script's redirect-on-execute can drop a POST body but keeps a GET's query
string intact):

```
GET /exec?key=<API_KEY>&action=<actionName>&email=<caller>&...params
```

Actions: `getCurrentUser`, `checkLocation`, `getDayState`, `recordEvent`,
`getTeamRoster`, `getMyMonthRoster`, `getTeamStatus`, `getRecentLog`. See the
`ACTIONS` map in [`Code.gs`](Code.gs) for parameters and return shapes.
Responses are always JSON; errors come back as `{ "error": "..." }` rather
than an HTTP error status.

## Setup (~10 minutes)

1. Open the Sheet → **Extensions → Apps Script**.
2. Replace the default `Code.gs` content with [`Code.gs`](Code.gs) from this folder.
3. Save. Run **initializeSheets** once from the function dropdown → grant the
   permissions it asks for. Creates any missing tabs (Employee Master,
   Settings, Daily Attendance Log, Punch Events Log, Monthly Summary) with headers.
4. In the **Settings** tab, fill in real Office Latitude/Longitude/Radius
   (Google Maps → right-click your office → click the coordinates to copy).
5. In **Employee Master**, make sure every active team member has their
   **Official Email** (@wiom.in), Shift Start, and Weekly Off Day filled in —
   this is how the app matches a Google sign-in to a person.
6. **Deploy → New deployment → Web app.** Execute as **"Me"**; Who has
   access: **"Anyone"**. Deploy, copy the `/exec` URL into
   [`../docs/js/config.js`](../docs/js/config.js)'s `API_URL`.
7. Turn on GitHub Pages for this repo (Settings → Pages → Source: Deploy
   from branch → `main` → `/docs`), share that Pages URL with the team.
8. Test yourself first: open the Pages URL, sign in with Google, allow
   location, Punch In → a break → Punch Out, confirm Daily Attendance Log
   updates.

## Updating later

Edit `Code.gs` here, commit to GitHub for history, then sync to the live
project with [clasp](https://github.com/google/clasp) (Google's official
CLI) instead of copy-pasting into the Apps Script editor:

```bash
cd apps-script
npx @google/clasp push
npx @google/clasp deploy --deploymentId AKfycbz1HM_Ud45vJh_6LjWkwKHOore8igJIj95k98a9pihWsLwXo-BF69MoYoZHDGTgtO5b --description "what changed"
```

`push` alone only updates the editor's HEAD copy — the live `/exec` URL is
pinned to a specific deployment *version*, so the `deploy` step (targeting
the deployment ID above, which is the one behind the current live URL) is
what actually makes a change visible without changing the URL. Frontend
changes (`../docs`) just need a normal `git push` — GitHub Pages redeploys
automatically.

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

Run this after editing `Code.gs`, before pushing.

## Tuning

- Half-day threshold (net hours < 4) and late grace (Settings tab, default
  15 min) live in `updateDailySummary_` / the sheet.
- Team Status poll interval: `teamPollHandle` in `../docs/js/app.js` (default 20s).
- Roster block format (2-row header, date columns from column K) is parsed
  in `rosterCodeFromGrid_` / `findTodayColumn_` / `findEmployeeRow_` in `Code.gs`.
- API key / Firebase config: `../docs/js/config.js`.

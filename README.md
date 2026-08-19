# PFT Attendance Dashboard

> **Status: parked.** After hitting deployment friction with Railway/Firebase
> unrelated to the app code, the team went with a GitHub Pages + Apps Script
> version instead — static frontend in [`docs/`](docs/) (Firebase Google
> Sign-In for identity), backend in [`apps-script/`](apps-script/) (a
> headless JSON API bound to the Sheet). Everything below describes this
> Node app, kept here for reference in case a hosted version is worth
> revisiting later.

Live, geofenced punch in/out + Lunch/Tea/Bio break tracker for the team, with
a real-time team status view. Identity comes from Firebase Auth (Google
Sign-In, restricted to `@wiom.in`); all attendance data reads/writes the
team's existing Google Sheet — Roster stays the admin-maintained planning
tab, Daily Attendance Log / Punch Events Log / Monthly Summary are written by
this app.

## How it behaves

- **Punch In → any number of Lunch/Tea/Bio breaks (each fully closed before
  another starts) → Punch Out.** Invalid sequences (e.g. punching out mid-break)
  are rejected server-side, not just hidden in the UI.
- **Geofenced**: punch/break actions are blocked outside the radius set in the
  Settings tab — **except** on days Roster marks that employee `WFH`, where the
  geofence check is skipped entirely.
- **Roster-aware**: on `WO` / `L` (Leave) / `Holiday` days the Punch In button
  stays available (in case they come in anyway) rather than being disabled.
  `UP` = unpaid leave.
- **Status** on Daily Attendance Log shows the live phase during the day
  ("Working", "Lunch Break", …), falls back to the Roster code before punch-in,
  and finalizes to Present / Late / Half Day at punch-out (net hours < 4 →
  Half Day; punch-in later than shift start + grace period → Late).
- Identity is re-derived from the verified Firebase ID token on **every**
  request — nothing the client sends is trusted for who's punching.

## Project layout

```
server.js            Express app + all API routes
src/dayState.js       Pure state-machine logic (punch/break transitions, hours, status)
src/rosterLookup.js   Parses the Roster tab's stacked monthly blocks
src/sheetsService.js  Google Sheets API reads/writes
src/auth.js           Firebase ID token verification middleware
src/mutex.js          Serializes concurrent punch requests
public/               Frontend (plain HTML/CSS/JS, no build step)
test/                 Node smoke tests for the logic above (npm test)
```

## One-time setup

### 1. Google Cloud service account (Sheets access)

1. In [Google Cloud Console](https://console.cloud.google.com), create/select a
   project → enable the **Google Sheets API**.
2. IAM & Admin → Service Accounts → Create service account → skip role grant
   (not needed) → Keys → Add key → JSON. Download it.
3. Open the Google Sheet → Share → paste the service account's `client_email`
   (looks like `xxx@yyy.iam.gserviceaccount.com`) → give it **Editor** access.
4. You'll paste the downloaded JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` below.

### 2. Firebase project (sign-in)

1. In the [Firebase console](https://console.firebase.google.com), create a
   project (or reuse an existing one on the same Google Cloud project as
   above — simplest).
2. Authentication → Sign-in method → enable **Google**.
3. Authentication → Settings → Authorized domains → add your Railway domain
   once you have it (e.g. `your-app.up.railway.app`) — sign-in will fail from
   an unauthorized domain.
4. Project settings → General → Your apps → Add app → Web. Copy the config
   (`apiKey`, `authDomain`, `projectId`) into the env vars below.
5. Project settings → Service accounts → Generate new private key. This is
   a **different** JSON from step 1 — it authenticates the *server* to verify
   sign-in tokens, not to access Sheets.

### 3. Environment variables

Copy `.env.example` to `.env` for local dev, or set the same keys as
**Variables** in Railway. Base64-encoding the two JSON keys avoids private-key
newline issues in most env-var UIs:

```bash
base64 -w0 service-account.json      # Linux/macOS
[Convert]::ToBase64String([IO.File]::ReadAllBytes("service-account.json"))   # PowerShell
```

### 4. Run locally

```bash
npm install
npm test        # logic smoke tests, no credentials needed
npm start        # http://localhost:3000
```

### 5. Deploy

1. Push this repo to GitHub.
2. In [Railway](https://railway.app): New Project → Deploy from GitHub repo →
   select it. Railway auto-detects Node (`npm start`).
3. Add all the variables from `.env.example` under the service's Variables tab.
4. Deploy. Once you have the Railway URL, add it to Firebase's Authorized
   domains (step 2.3 above) or sign-in will fail.
5. Open the URL, sign in with an `@wiom.in` Google account, and test Punch
   In → a break → Punch Out yourself before rolling out to the team.

## Notes / things you can tune

- Half-day threshold (net hours < 4) and late grace (15 min, from the
  Settings tab) live in `src/dayState.js` / the sheet respectively.
- Team Status polls every 20s (`public/app.js`, `teamPollHandle`) — Sheet
  reads aren't push-based, so this is "live" on a short delay, not instant.
- Roster lookup is read-only by design — this app never writes to the Roster
  tab, so your existing planning workflow there is untouched.

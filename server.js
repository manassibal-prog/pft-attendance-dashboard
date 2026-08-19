require('dotenv').config();
const path = require('path');
const express = require('express');
const { requireAuth } = require('./src/auth');
const { withLock } = require('./src/mutex');
const {
  getSettings, findEmployeeByEmail, listActiveEmployees, getTodayRosterCodeFor,
  getRosterGrid, rosterCodeFromGrid, getTodayEvents, appendEvent, upsertDailySummary, getTodayLogRows,
} = require('./src/sheetsService');
const { haversineMeters, computeDayState, validTransition, transitionErrorMessage } = require('./src/dayState');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Public Firebase config for the frontend SDK to initialize with. These
// values are meant to be public (they identify the project, not a secret).
app.get('/api/config', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    allowedDomain: process.env.ALLOWED_DOMAIN || 'wiom.in',
  });
});

app.get('/health', (req, res) => res.json({ ok: true }));

async function loadEmployeeOr403(email, res) {
  const emp = await findEmployeeByEmail(email);
  if (!emp) {
    res.status(403).json({ error: `Email ${email} is not registered in Employee Master. Contact your admin.` });
    return null;
  }
  if (String(emp.status).trim().toLowerCase() !== 'active') {
    res.status(403).json({ error: `Your record is marked "${emp.status}". Contact your admin.` });
    return null;
  }
  return emp;
}

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const emp = await loadEmployeeOr403(req.userEmail, res);
    if (!emp) return;
    const settings = await getSettings();
    res.json({ emp, officeName: settings.officeName, radius: settings.radius });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/location-check', requireAuth, async (req, res) => {
  try {
    const { lat, lng } = req.body;
    const settings = await getSettings();
    const distance = Math.round(haversineMeters(lat, lng, settings.lat, settings.lng));
    res.json({ distance, radius: settings.radius, within: distance <= settings.radius, officeName: settings.officeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/day-state', requireAuth, async (req, res) => {
  try {
    const emp = await loadEmployeeOr403(req.userEmail, res);
    if (!emp) return;
    const now = new Date();
    const events = await getTodayEvents(emp.empId, now);
    const state = computeDayState(events);
    const rosterCode = await getTodayRosterCodeFor(emp.name, now, emp.weeklyOff);
    res.json({ ...state, rosterCode, requiresGeofence: rosterCode.toUpperCase() !== 'WFH' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/punch', requireAuth, async (req, res) => {
  try {
    const emp = await loadEmployeeOr403(req.userEmail, res);
    if (!emp) return;
    const { type, lat, lng } = req.body;

    await withLock(emp.empId, async () => {
      const now = new Date();

      const todayEvents = await getTodayEvents(emp.empId, now);
      const state = computeDayState(todayEvents);

      if (!validTransition(state.phase, state.breakType, type)) {
        await appendEvent(now, emp.empId, emp.name, emp.email, type, lat, lng, '', '', 'Blocked - invalid order');
        return res.status(409).json({ success: false, message: transitionErrorMessage(state, type) });
      }

      const settings = await getSettings();
      const rosterCode = await getTodayRosterCodeFor(emp.name, now, emp.weeklyOff);
      const requiresGeofence = rosterCode.toUpperCase() !== 'WFH';
      const distance = Math.round(haversineMeters(lat, lng, settings.lat, settings.lng));
      const within = distance <= settings.radius;

      if (requiresGeofence && !within) {
        await appendEvent(now, emp.empId, emp.name, emp.email, type, lat, lng, distance, 'No', 'Blocked - outside geofence');
        return res.status(409).json({
          success: false,
          message: `You are ${distance}m from ${settings.officeName} (allowed: ${settings.radius}m). Move closer and try again.`,
        });
      }

      await appendEvent(now, emp.empId, emp.name, emp.email, type, lat, lng, distance, within ? 'Yes' : 'No (WFH)', 'Success');

      const newState = computeDayState(todayEvents.concat([{ type, timestamp: now }]));
      await upsertDailySummary(emp, now, newState, rosterCode, settings);

      res.json({ success: true, time: now.toISOString(), distance, state: newState, rosterCode, requiresGeofence: rosterCode.toUpperCase() !== 'WFH' });
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/team-status', requireAuth, async (req, res) => {
  try {
    const emp = await loadEmployeeOr403(req.userEmail, res);
    if (!emp) return;
    const now = new Date();
    const [employees, todayRows, rosterGrid] = await Promise.all([listActiveEmployees(), getTodayLogRows(now), getRosterGrid()]);

    const results = employees.map((e) => {
      const row = todayRows[e.empId];
      if (row) {
        return {
          empId: e.empId, name: e.name, department: e.department,
          punchIn: row.punchIn ? row.punchIn.toISOString() : null,
          punchOut: row.punchOut ? row.punchOut.toISOString() : null,
          lunch: row.lunch, tea: row.tea, bio: row.bio,
          netHours: row.netHours, lateBy: row.lateBy, status: row.status,
        };
      }
      const rosterCode = rosterCodeFromGrid(rosterGrid, e.name, now, e.weeklyOff);
      return {
        empId: e.empId, name: e.name, department: e.department,
        punchIn: null, punchOut: null, lunch: 0, tea: 0, bio: 0,
        netHours: '', lateBy: 0, status: rosterCode || 'Not Started',
      };
    });

    res.json({ employees: results, asOf: now.toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on :${PORT}`));

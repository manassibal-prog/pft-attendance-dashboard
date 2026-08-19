const admin = require('firebase-admin');

let initialized = false;
function ensureInit() {
  if (initialized) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not set.');
  const creds = JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  initialized = true;
}

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'wiom.in').toLowerCase();

// Express middleware: verifies the Firebase ID token in the Authorization
// header and attaches req.userEmail. Never trusts anything else from the
// client as identity.
async function requireAuth(req, res, next) {
  try {
    ensureInit();
    const header = req.headers.authorization || '';
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ error: 'Missing sign-in token.' });

    const decoded = await admin.auth().verifyIdToken(match[1]);
    if (!decoded.email || !decoded.email_verified) {
      return res.status(403).json({ error: 'Your Google account email is not verified.' });
    }
    if (!decoded.email.toLowerCase().endsWith('@' + ALLOWED_DOMAIN)) {
      return res.status(403).json({ error: `Only @${ALLOWED_DOMAIN} accounts can use this app.` });
    }
    req.userEmail = decoded.email;
    next();
  } catch (err) {
    res.status(401).json({ error: 'Sign-in verification failed: ' + err.message });
  }
}

module.exports = { requireAuth, ALLOWED_DOMAIN };

import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { auth } from './db.js';
import { CONFIG } from './config.js';

const provider = new GoogleAuthProvider();
// No "hd" restriction here — Google's account-picker only supports locking
// to a single domain, but two are allowed (see config.js). Domain
// membership is enforced right below instead, and again server-side.

export async function signIn() {
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutUser() {
  await signOut(auth);
}

function isAllowedDomainEmail_(email) {
  const lower = String(email || '').toLowerCase();
  return CONFIG.ALLOWED_DOMAINS.some(function (d) { return lower.endsWith('@' + d.toLowerCase()); });
}

// callback(user, errorCode) — user is null on sign-out or domain rejection,
// with errorCode set to 'unauthorized_domain' in the latter case.
export function onAuthReady(callback) {
  return onAuthStateChanged(auth, function (firebaseUser) {
    if (!firebaseUser) { callback(null); return; }
    const email = firebaseUser.email || '';
    if (!isAllowedDomainEmail_(email)) {
      signOut(auth);
      callback(null, 'unauthorized_domain');
      return;
    }
    callback({ email: email, name: firebaseUser.displayName || email });
  });
}

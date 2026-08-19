import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { auth } from './db.js';
import { CONFIG } from './config.js';

const provider = new GoogleAuthProvider();
provider.setCustomParameters({ hd: CONFIG.ALLOWED_DOMAIN });

export async function signIn() {
  const result = await signInWithPopup(auth, provider);
  return result.user;
}

export async function signOutUser() {
  await signOut(auth);
}

// callback(user, errorCode) — user is null on sign-out or domain rejection,
// with errorCode set to 'unauthorized_domain' in the latter case.
export function onAuthReady(callback) {
  return onAuthStateChanged(auth, function (firebaseUser) {
    if (!firebaseUser) { callback(null); return; }
    const email = firebaseUser.email || '';
    if (!email.toLowerCase().endsWith('@' + CONFIG.ALLOWED_DOMAIN)) {
      signOut(auth);
      callback(null, 'unauthorized_domain');
      return;
    }
    callback({ email: email, name: firebaseUser.displayName || email });
  });
}

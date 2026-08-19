// Reusing wiom-l2's Firebase project — these identifiers are public (they
// ship inside client JS by design; Firebase's actual security boundary is
// Auth rules + the authorized-domains list, not secrecy of this config) and
// manassibal-prog.github.io is already an authorized domain there, so no
// new Firebase project or console setup was needed for this dashboard.
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDRtG3giqbCFwYX0bD0bC1HSfRAEk-znyQ",
  authDomain: "wiom-l2-platform.firebaseapp.com",
  projectId: "wiom-l2-platform",
  storageBucket: "wiom-l2-platform.firebasestorage.app",
  messagingSenderId: "135966014874",
  appId: "1:135966014874:web:72445c322e3b150e3ace23"
};

export const CONFIG = {
  ALLOWED_DOMAIN: "wiom.in",
  // Apps Script Web App URL — deployed as "Execute as: Me" / "Anyone", so it
  // never shows the visitor a Google consent screen. Access control is the
  // API_KEY below plus the @wiom.in + Employee Master check done server-side.
  API_URL: "https://script.google.com/macros/s/AKfycbz1HM_Ud45vJh_6LjWkwKHOore8igJIj95k98a9pihWsLwXo-BF69MoYoZHDGTgtO5b/exec",
  API_KEY: "wiom-pft-roster-2026"
};

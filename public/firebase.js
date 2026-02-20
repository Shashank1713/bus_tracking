window.firebaseClient = {
  auth: null,
  isReady: false
};

window.loadFirebase = async function loadFirebase() {
  if (window.firebaseClient.isReady) {
    return window.firebaseClient.auth;
  }

  const res = await fetch("/api/config/firebase");
  if (!res.ok) {
    throw new Error("Firebase config is unavailable");
  }

  const config = await res.json();
  if (!firebase.apps.length) {
    firebase.initializeApp(config);
  }

  window.firebaseClient.auth = firebase.auth();
  window.firebaseClient.isReady = true;
  return window.firebaseClient.auth;
};

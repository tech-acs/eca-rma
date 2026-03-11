(function () {
  // If browser reports offline at startup, navigate to a remote URL so
  // the browser shows its native network error page instead of app UI.
  const OFFLINE_REDIRECT_URL = "https://geoservices.un.org/";
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      window.location.replace(OFFLINE_REDIRECT_URL);
    }
  } catch (e) {
    // No-op: keep default behavior if detection is unavailable.
  }
})();

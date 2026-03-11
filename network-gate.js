(function () {
  // Keep the current URL as-is when offline; do not force any redirect.
  try {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return;
    }
  } catch (e) {
    // No-op: keep default behavior if detection is unavailable.
  }
})();

// Carries a referral code from a share link (e.g. the Refer a Friend
// invite email's button, or a member's copied link:
// https://www.portcityleashclub.com/?code=PCLC-XXXXXX) through to the
// request forms, so the friend never has to type it.
//
// Loaded with `defer` on the homepage and both request forms. A ?code= in
// the URL wins and is remembered for the rest of the tab's session; with
// no ?code=, the remembered one is used. membership-request.html and
// service-request.html read window._carriedReferralCode once their
// validateReferralCode callable is ready and pre-fill the field from it.
// Storage can be unavailable (private windows, blocked site data), so
// every access is guarded and the URL value still works on its own page.
(function () {
  var KEY = 'pclcReferralCode';
  // Generated PCLC- codes and admin-named event codes — anything else in
  // the URL is ignored rather than pasted into the form.
  var CODE_PATTERN = /^[A-Z0-9-]{4,24}$/;
  var code = null;
  try {
    var fromUrl = new URLSearchParams(window.location.search).get('code');
    if (fromUrl) {
      var cleaned = fromUrl.trim().toUpperCase();
      if (CODE_PATTERN.test(cleaned)) {
        code = cleaned;
        try { window.sessionStorage.setItem(KEY, cleaned); } catch (e) { /* storage blocked */ }
      }
    }
  } catch (e) { /* no URLSearchParams */ }
  if (!code) {
    try {
      var stored = window.sessionStorage.getItem(KEY);
      if (stored && CODE_PATTERN.test(stored)) code = stored;
    } catch (e) { /* storage blocked */ }
  }
  window._carriedReferralCode = code;
})();

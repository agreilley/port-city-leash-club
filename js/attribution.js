// attribution.js — first-touch marketing attribution for Port City Leash Club.
//
// Captures utm_source/utm_medium/utm_campaign/utm_content, document.referrer,
// and the landing page on a visitor's FIRST touch anywhere on the site, and
// persists it in localStorage for 90 days. sessionStorage would only catch
// someone who clicks an ad and signs up in that same browsing session — the
// real pattern here is a Meta ad landing on index.html (not the signup form),
// the visitor reading and leaving, then returning days later on
// membership-request.html to actually sign up. A valid (non-expired) blob is
// never overwritten by a later visit; only the true first touch is kept.
//
// Values here are attacker-controlled — any anonymous visitor can arrive with
// an arbitrary ?utm_campaign=<script>... — so this sanitizes with a strict
// character ALLOWLIST before ever writing to localStorage, not just at
// render time. firestore.rules' validAttrString() re-enforces the same
// allowlist server-side; that's the actual security boundary, this is
// defense in depth.
(function () {
  var STORAGE_KEY = 'pclc_attribution';
  var MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  // Mirrors validAttrString()'s regex in firestore.rules — keep the two in
  // lockstep if either changes.
  var SAFE_CHARS = /[^a-zA-Z0-9 _.:/?&=-]/g;

  function sanitize(value, maxLen) {
    if (!value) return null;
    var cleaned = String(value).replace(SAFE_CHARS, '').slice(0, maxLen);
    return cleaned || null;
  }

  function readStored() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var blob = JSON.parse(raw);
      if (!blob || typeof blob.capturedAt !== 'number') return null;
      return blob;
    } catch (e) {
      return null;
    }
  }

  function capture() {
    var existing = readStored();
    var isValid = existing && (Date.now() - existing.capturedAt) < MAX_AGE_MS;
    if (isValid) return; // first touch already recorded and still fresh — never overwrite it

    var params = new URLSearchParams(window.location.search);
    var blob = {
      utmSource: sanitize(params.get('utm_source'), 200),
      utmMedium: sanitize(params.get('utm_medium'), 200),
      utmCampaign: sanitize(params.get('utm_campaign'), 200),
      utmContent: sanitize(params.get('utm_content'), 200),
      referrer: sanitize(document.referrer, 500),
      landingPage: sanitize(window.location.pathname + window.location.search, 300),
      capturedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(blob));
    } catch (e) {
      // localStorage disabled/full (private browsing, quota) — fail silent,
      // same "never let tracking break the page" posture as meta-pixel.js.
    }
  }

  capture();

  // Read helper for the two form pages to call at submit time. Returns null
  // if nothing was ever captured (localStorage disabled/blocked, or this
  // visitor's first touch predates this feature) — callers should send
  // attribution: null in that case, not omit the field.
  window.pclcReadAttribution = function () {
    var blob = readStored();
    if (!blob) return null;
    return {
      utmSource: blob.utmSource || null,
      utmMedium: blob.utmMedium || null,
      utmCampaign: blob.utmCampaign || null,
      utmContent: blob.utmContent || null,
      referrer: blob.referrer || null,
      landingPage: blob.landingPage || null,
      capturedAt: blob.capturedAt,
    };
  };
})();

// ga4.js — GA4 loader + funnel event instrumentation for Port City Leash Club.
//
// Single source of truth for the Measurement ID: loaded via one identical
// <script src="/js/ga4.js" defer> tag on the same 8 public marketing/form
// pages as js/meta-pixel.js and js/attribution.js — never on portal-*,
// walker/*, admin/*, or dev/* pages.
//
// Wires the funnel generically (feature-detected by element presence, not
// by page), so pages need at most one extra call — form_submit, which has
// to fire at an async operation's success point this file can't observe on
// its own — rather than any page carrying its own GA4 config:
//   - section_view  {section: "membership_tiers"} — IntersectionObserver on
//     #membership, fires once. Only index.html has that element.
//   - cta_click     {cta_location: <data-cta value>} — delegated click
//     listener, any anchor whose href contains "/membership-request",
//     wherever one exists. Attached on every page so a future CTA added
//     elsewhere is covered without touching this file again.
//   - form_start    (no params) — delegated focusin on #membershipForm,
//     fires once per page load. Deliberately NOT GA4 Enhanced Measurement's
//     auto-collected form_start/form_submit: every submit handler in this
//     codebase uses event.preventDefault() + an async Firestore write,
//     which Enhanced Measurement's form_submit cannot see — form_start is
//     kept custom too so both halves of the funnel share one triggering
//     model instead of two different ones.
//   - form_submit   (no params) — NOT wired here. membership-request.html
//     calls window.pclcTrackGA('form_submit') itself, at the same success
//     point window.pclcTrack('Lead') already fires from.
//
// Expected data-cta values (index.html) — an anchor added later without one
// of these is silently uncounted, so keep this list in sync with the markup:
//   nav, hero, tier_membership, zone_check_success
//
// stay_in_touch_form (the email-capture form's submit button) is NOT in
// this list — it's a <button>, not an anchor to /membership-request, so the
// delegated listener below never sees it. index.html's own submit handler
// fires cta_click for it manually at the success point instead.
//
// No PII in any event parameter, ever — every param here is a fixed string
// describing a UI location, never user input.
(function () {
  var MEASUREMENT_ID = 'G-PS9J4ZDHKE';

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);

  var loader = document.createElement('script');
  loader.async = true;
  loader.src = 'https://www.googletagmanager.com/gtag/js?id=' + MEASUREMENT_ID;
  document.head.appendChild(loader);

  // Generic helper for events tied to an async success point gtag.js can't
  // observe on its own (currently just form_submit). Wrapped the same way
  // meta-pixel.js wraps fbq — a tracking failure must never break a submit.
  window.pclcTrackGA = function (eventName, params) {
    try {
      gtag('event', eventName, params || {});
    } catch (e) { /* never let tracking break a form submit */ }
  };

  // section_view — membership tier section reached (index.html only; the
  // element is simply absent everywhere else, so this is a no-op elsewhere).
  var membershipSection = document.getElementById('membership');
  if (membershipSection && 'IntersectionObserver' in window) {
    var sectionObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          window.pclcTrackGA('section_view', { section: 'membership_tiers' });
          observer.disconnect();
        }
      });
    }, { threshold: 0.5 });
    sectionObserver.observe(membershipSection);
  }

  // cta_click — any anchor linking to the signup form, labeled by its own
  // data-cta attribute so the click location is unambiguous.
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('a[href*="/membership-request"]');
    if (!link) return;
    window.pclcTrackGA('cta_click', { cta_location: link.getAttribute('data-cta') || 'unlabeled' });
  });

  // form_start — first interaction with the signup form, once per page load.
  var membershipForm = document.getElementById('membershipForm');
  if (membershipForm) {
    var started = false;
    membershipForm.addEventListener('focusin', function () {
      if (started) return;
      started = true;
      window.pclcTrackGA('form_start');
    });
  }
})();

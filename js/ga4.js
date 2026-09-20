// ga4.js — GA4 loader + funnel event instrumentation for Port City Leash Club.
//
// Single source of truth for the Measurement ID: loaded via one identical
// <script src="/js/ga4.js" defer> tag on 11 public marketing/form pages
// (index, pet-sitting, service-request, membership-request,
// request-received, contact, careers, faq, walker-screening,
// puppies-and-pilates, welcomehome) — never on portal-*, walker/*, admin/*,
// or dev/* pages. js/meta-pixel.js now loads on this same 11-page set too;
// js/attribution.js loads on all of them except request-received.html.
//
// Wires the funnel generically (feature-detected by element presence, not
// by page), so pages need at most a couple of extra calls — form_submit and
// generate_lead, which have to fire at an async operation's success point
// this file can't observe on its own — rather than any page carrying its
// own GA4 config:
//   - section_view  {section: "membership_tiers"} — IntersectionObserver on
//     #membership, fires once. Only index.html has that element.
//   - cta_click     {cta_location: <data-cta value>} — delegated click
//     listener, any anchor whose href contains "/membership-request",
//     wherever one exists. Attached on every page so a future CTA added
//     elsewhere is covered without touching this file again. pet-sitting.html
//     runs its own equivalent delegated listener for /service-request links
//     (its CTAs don't point at /membership-request), which also fires a Meta
//     ViewContent for the two Reserve cards specifically — see that file.
//   - form_start    (no params) — delegated focusin on #membershipForm,
//     fires once per page load. Deliberately NOT GA4 Enhanced Measurement's
//     auto-collected form_start/form_submit: every submit handler in this
//     codebase uses event.preventDefault() + an async Firestore write,
//     which Enhanced Measurement's form_submit cannot see — form_start is
//     kept custom too so both halves of the funnel share one triggering
//     model instead of two different ones.
//   - form_submit   {form_type: "service_request"|"membership_request"} —
//     NOT wired here. service-request.html and membership-request.html each
//     call window.pclcTrackGA('form_submit', {form_type}) themselves, at the
//     same success point window.pclcTrack('Lead', {lead_type}) already
//     fires from.
//   - generate_lead {lead_type: "20_off_code"} — NOT wired here either.
//     index.html's $20-offer form calls this itself, at the same success
//     point as the cta_click below and window.pclcTrack('Lead') in
//     meta-pixel.js.
//
// Expected data-cta values (index.html) — an anchor added later without one
// of these is silently uncounted, so keep this list in sync with the markup:
//   nav, hero, tier_membership, zone_check_success
//
// stay_in_touch_form (the email-capture form's submit button) is NOT in
// this list — it's a <button>, not an anchor to /membership-request, so the
// delegated listener below never sees it. index.html's own submit handler
// fires cta_click (and generate_lead) for it manually at the success point
// instead.
//
// No PII in any event parameter, ever — every param here is a fixed string
// describing a UI location or lead/form type, never user input.
(function () {
  var MEASUREMENT_ID = 'G-PS9J4ZDHKE';
  var ADS_ID = 'AW-18417285970';

  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  window.gtag = gtag;

  gtag('js', new Date());
  gtag('config', MEASUREMENT_ID);
  gtag('config', ADS_ID);

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

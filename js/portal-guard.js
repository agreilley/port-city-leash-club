// portal-guard.js — shared "signed in, but not a member" guard for portal pages.
//
// Usage (right after the existing `if (!user) { ... }` sign-in check inside
// onAuthStateChanged):
//   import { requireMemberDoc, showPortalLoadTimeout } from '/js/portal-guard.js';
//   memberData = await requireMemberDoc(db, user.uid);
//   clearTimeout(authTimeoutId); // AFTER the call above settles, not before
//   if (!memberData) return;
//
// Access control has TWO parts, deliberately split across two files:
//   1. js/portal-guard.css, loaded via <link rel="stylesheet"> in each
//      page's own <head> — NOT injected from here. Gates five classes
//      (.sidebar, .main-content, and js/portal-nav.js's .pn-topbar/
//      .pn-drawer/.pn-overlay — see that CSS file's own header for why all
//      five) keyed off document.body's data-portal-access attribute. It
//      has to be a real <link>, not JS-injected: a <script type="module">
//      is deferred by spec and can't execute until the page is parsed, so
//      the browser can and does paint the page's own default-visible
//      chrome BEFORE any module script — including this one — ever runs.
//      A render-blocking stylesheet is the only thing that closes that
//      race; this file used to inject the same rule via JS and every
//      visitor briefly saw full portal chrome before it applied.
//   2. This file: the actual membership check, and everything that sets
//      data-portal-access in response to it —
//        (unset)   -> chrome hidden (via #1), a loading placeholder shown.
//                     Default state, fails closed — nothing needs the
//                     guard to have run yet.
//        "granted" -> chrome shown, placeholder/denial hidden.
//        anything else (denied) -> chrome stays hidden, a dedicated
//                     message shown in its place.
// Every guarded page needs both: the <link> in its <head>, unchanged from
// this file's own concerns, plus the usage below.
//
// Two distinct denial states, not one: a missing members/{uid} doc really
// does mean no portal access (renderNotAMember — explanation, hello@
// contact, Sign Out). A THROWN read (permission/network failure) or the
// page's own load timing out proves nothing about membership one way or
// the other — both go to renderLoadError instead (try again, no sign-out,
// no claim about access). Conflating those was the previous version's bug:
// a real member on a flaky connection would have been told they lack
// access, which is false.
//
// The load-error/timeout message deliberately does NOT reuse status.js's
// showError() for its own container: showError() mounts inside the first
// <form> on the page when present (getContainer() in status.js), and on
// several pages (portal-account.html, portal-pause-membership.html, …)
// that form lives inside .main-content — exactly what the stylesheet above
// hides by default. A member stuck loading would see nothing at all. This
// file's overlay is always appended directly to <body>, a sibling of
// .sidebar/.main-content, never a descendant, so it's never caught by that
// rule regardless of what any given page's markup looks like.

import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth, signOut } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';

const NOT_A_MEMBER_MSG = "This account doesn't have portal access yet.";
// Same wording the old per-page authTimeoutId already showed via showError —
// kept verbatim so what a member sees on a stall doesn't change, only where
// it renders and what it's paired with.
const LOAD_TIMEOUT_MSG = "This page didn't finish loading. Please try again.";
const LOAD_ERROR_MSG = "We couldn't confirm your account. Please try again.";

const STYLE_ID = 'pcl-portal-guard-styles';
const OVERLAY_ID = 'pcl-portal-guard-overlay';

// Chrome-hiding rule lives ONLY in portal-guard.css now (see the header
// comment above) — not duplicated here. Everything below styles content
// this file creates itself (the overlay and what's inside it), which never
// exists before this script runs anyway, so none of it needs to be
// render-blocking the way the chrome-hiding rule does.
const CSS = `
#${OVERLAY_ID} {
  display: flex;
  min-height: 100vh;
  align-items: center;
  justify-content: center;
  padding: 24px;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
body[data-portal-access="granted"] #${OVERLAY_ID} { display: none; }
.pcl-guard-loading {
  font-size: 14px;
  color: #7A7A7A;
}
.pcl-guard-card {
  background: #fff;
  border-radius: 16px;
  padding: 40px 32px;
  max-width: 440px;
  width: 100%;
  text-align: center;
  box-shadow: 0 20px 60px rgba(0,0,0,0.12);
}
.pcl-guard-card h1 {
  font-family: 'Cormorant Garamond', serif;
  font-weight: 400;
  font-size: 26px;
  color: #0D1B2A;
  margin-bottom: 12px;
}
.pcl-guard-card p {
  font-size: 14px;
  line-height: 1.6;
  color: #4A4A4A;
  margin: 0 0 24px;
}
.pcl-guard-card a {
  color: #C17B6F;
  font-weight: 500;
  text-decoration: none;
}
.pcl-guard-card a:hover { text-decoration: underline; }
.pcl-guard-btn {
  display: inline-block;
  padding: 12px 28px;
  border-radius: 6px;
  border: none;
  font-family: 'DM Sans', sans-serif;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
}
.pcl-guard-btn--primary { background: #C17B6F; color: #fff; }
.pcl-guard-btn--primary:hover { background: #AD6B60; }
.pcl-guard-btn--secondary { background: transparent; color: #0D1B2A; border: 1px solid rgba(13,27,42,0.2); }
.pcl-guard-btn--secondary:hover { background: rgba(13,27,42,0.04); }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// Injected once, at module load, so the overlay's own styling is ready
// before renderLoading() below first runs. No race to protect against
// here the way portal-guard.css has — nothing on the page depends on this
// CSS existing before this script does, since the overlay element itself
// doesn't exist until this script creates it either.
injectStyles();

function getOverlay() {
  let el = document.getElementById(OVERLAY_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_ID;
    document.body.appendChild(el);
  }
  return el;
}

function renderLoading() {
  getOverlay().innerHTML = '<div class="pcl-guard-loading">Loading your account…</div>';
}

// Shown immediately, same reasoning as injectStyles() above: nothing should
// wait for requireMemberDoc() to be called before the loading state exists,
// since the chrome is already hidden by then regardless.
renderLoading();

function memberAppAuth() {
  // Every portal page's page-load script calls initializeAuth() on the
  // 'member-app' Firebase app before requireMemberDoc() can ever run
  // (requireMemberDoc is only ever called from inside an onAuthStateChanged
  // callback, which itself requires that auth instance to already exist) —
  // so getAuth() here always retrieves that same already-configured
  // instance. initializeAuth() can only run once per app; this never
  // creates a second one.
  const app = getApps().find((a) => a.name === 'member-app');
  return getAuth(app);
}

function signOutOfPortal() {
  signOut(memberAppAuth()).then(() => {
    window.location.href = 'portal-login.html';
  });
}

function renderNotAMember() {
  document.body.dataset.portalAccess = 'denied';
  getOverlay().innerHTML = `
    <div class="pcl-guard-card">
      <h1>No portal access yet</h1>
      <p>${NOT_A_MEMBER_MSG}<br>If that seems wrong, email us at
        <a href="mailto:hello@portcityleashclub.com">hello@portcityleashclub.com</a>
        and we'll help sort it out.</p>
      <button type="button" class="pcl-guard-btn pcl-guard-btn--secondary">Sign Out</button>
    </div>
  `;
  getOverlay().querySelector('button').addEventListener('click', signOutOfPortal);
}

function renderLoadError(message) {
  document.body.dataset.portalAccess = 'denied';
  getOverlay().innerHTML = `
    <div class="pcl-guard-card">
      <h1>Couldn't load your account</h1>
      <p>${message}</p>
      <button type="button" class="pcl-guard-btn pcl-guard-btn--primary">Retry</button>
    </div>
  `;
  getOverlay().querySelector('button').addEventListener('click', () => location.reload());
}

export async function requireMemberDoc(db, uid) {
  renderLoading();
  let snap;
  try {
    snap = await getDoc(doc(db, 'members', uid));
  } catch (e) {
    console.error('requireMemberDoc: read failed for members/' + uid + ':', e.message);
    renderLoadError(LOAD_ERROR_MSG);
    return null;
  }
  if (!snap.exists()) {
    console.warn('requireMemberDoc: no members/' + uid + ' doc — showing not-a-member message.');
    renderNotAMember();
    return null;
  }
  document.body.dataset.portalAccess = 'granted';
  return { id: snap.id, ...snap.data() };
}

// Called by each page's own pre-existing 10-second load timeout when
// requireMemberDoc() hasn't settled in time (a hung members/{uid} read on a
// flaky connection — the same budget that used to only cover "Firebase
// Auth never resolves," now also covering this). Deliberately the exact
// same treatment as a thrown read error above, never the not-a-member
// denial: a stall proves nothing about whether the account is a member.
export function showPortalLoadTimeout() {
  renderLoadError(LOAD_TIMEOUT_MSG);
}

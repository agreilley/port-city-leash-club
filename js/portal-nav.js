// js/portal-nav.js — shared left-drawer navigation for the member portal.
//
// Usage: add one line to any portal-*.html page —
//   <script type="module" src="/js/portal-nav.js"></script>
// — anywhere in <body>. On load this injects its own <style>, builds the
// drawer/overlay/mobile topbar, and wires everything up. No exports, no
// per-page setup: the alternative was 11 hand-typed copies of the bottom
// nav, which is exactly how its item order drifted between pages before
// this existed. One canonical source, structurally.
//
// Scope: this ONLY replaces the old fixed bottom nav (mobile-width-only
// behavior). The existing desktop-width <div class="sidebar"> on each page
// is untouched — it already hides at the same 768px breakpoint this
// module's own drawer/topbar CSS uses to appear, so the handoff between
// them has no gap and no overlap.
//
// Firebase-free by design: sign-out calls the page's own already-defined
// window.signOutMember() rather than touching Auth directly (every portal
// page defines it identically, except portal-dashboard.html's version,
// which additionally no-ops during admin preview mode — this module treats
// it as an opaque callable either way).
//
// Runs entirely synchronously at module-evaluation time (no top-level
// await before the DOM is injected) — this is deliberate: portal-dashboard.
// html's admin-preview-mode code disables every nav link, including this
// drawer's, by querying '.pn-drawer .pn-item' from inside its
// onAuthStateChanged callback. That callback is always async (at minimum a
// microtask), and this module's synchronous injection always completes
// before any promise callback can run — so by the time that code executes,
// this drawer's markup is guaranteed to already exist.

const NAV_ITEMS = [
  {
    label: 'Home',
    href: 'portal-dashboard.html',
    match: ['portal-dashboard'],
    icon: '<rect x="2" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="2" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="2" y="12" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/><rect x="12" y="12" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/>',
  },
  {
    label: 'Care History',
    href: 'portal-walk-history.html',
    match: ['portal-walk-history', 'portal-extend-walk', 'portal-reschedule'],
    icon: '<path d="M4 11h14M4 6h14M4 16h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  },
  {
    label: 'Care',
    href: 'portal-extras.html',
    match: ['portal-extras', 'portal-request-extras'],
    icon: '<path d="M11 4v14M4 11h14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  },
  {
    label: 'Refer',
    href: 'portal-referrals.html',
    match: ['portal-referrals'],
    icon: '<path d="M11 3l2.2 4.46 4.92.72-3.56 3.47.84 4.9L11 14.98l-4.4 2.31.84-4.9-3.56-3.47 4.92-.72L11 3z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  },
  {
    label: 'Profile',
    href: 'portal-pet-profile.html',
    match: ['portal-pet-profile'],
    icon: '<circle cx="11" cy="8" r="4" stroke="currentColor" stroke-width="1.5"/><path d="M3 20c0-4.418 3.582-7 8-7s8 2.582 8 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  },
  {
    label: 'Account',
    href: 'portal-account.html',
    match: ['portal-account', 'portal-pause-membership'],
    icon: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  },
];

const LOGOUT_ICON = '<path d="M8.5 3H4.5a1 1 0 00-1 1v14a1 1 0 001 1h4M14 15l4-4-4-4M18 11H7.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
const HAMBURGER_ICON = '<path d="M2 5h16M2 10h16M2 15h16" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>';

const STYLE_ID = 'pn-styles';
// Matches the breakpoint each page's own CSS already uses to hide its
// desktop .sidebar — same handoff point, no gap, no overlap.
const BREAKPOINT = 768;

const CSS = `
.pn-topbar {
  display: none;
}
.pn-drawer {
  display: none;
}
@media (max-width: ${BREAKPOINT}px) {
  .pn-topbar {
    display: flex;
    align-items: center;
    gap: 12px;
    position: sticky;
    top: 0;
    left: 0;
    right: 0;
    height: 52px;
    padding: 0 16px;
    background: #FAFAF8;
    border-bottom: 1px solid rgba(13,27,42,0.08);
    z-index: 250;
  }
  .pn-hamburger {
    background: none;
    border: none;
    padding: 6px;
    margin: -6px;
    cursor: pointer;
    color: #0D1B2A;
    display: flex;
  }
  .pn-topbar-title {
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.02em;
    color: #0D1B2A;
  }

  .pn-overlay {
    display: block;
    position: fixed;
    inset: 0;
    background: rgba(13,27,42,0.4);
    z-index: 290;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s ease;
  }
  .pn-overlay.open { opacity: 1; pointer-events: auto; }

  .pn-drawer {
    display: flex;
    flex-direction: column;
    position: fixed;
    top: 0;
    bottom: 0;
    left: 0;
    width: 260px;
    max-width: 82vw;
    background: #0D1B2A;
    z-index: 300;
    transform: translateX(-100%);
    transition: transform 0.25s ease;
    box-shadow: 8px 0 24px rgba(0,0,0,0.15);
    padding: 20px 0;
    overflow-y: auto;
  }
  .pn-drawer.open { transform: translateX(0); }

  .pn-drawer-header {
    padding: 0 20px 20px;
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: white;
  }
  .pn-item {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 13px 20px;
    color: rgba(255,255,255,0.6);
    text-decoration: none;
    font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    font-weight: 500;
    background: none;
    border: none;
    width: 100%;
    text-align: left;
    cursor: pointer;
  }
  .pn-item svg { flex-shrink: 0; opacity: 0.75; }
  .pn-item.active { color: #C17B6F; background: rgba(255,255,255,0.06); }
  .pn-item.active svg { opacity: 1; }

  .pn-divider {
    height: 1px;
    background: rgba(255,255,255,0.1);
    margin: 8px 0;
  }
  .pn-logout { margin-top: auto; }
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function isActive(matchList) {
  const path = location.pathname;
  return matchList.some(m => path.includes(m));
}

function buildDrawer() {
  const overlay = document.createElement('div');
  overlay.className = 'pn-overlay';
  overlay.id = 'pnOverlay';
  // Purely a click-to-dismiss backdrop with no content of its own — never
  // meant to be discoverable via assistive tech navigation (closing is via
  // Escape or activating a real link/button), so this stays permanently
  // hidden from the accessibility tree rather than toggling.
  overlay.setAttribute('aria-hidden', 'true');

  const drawer = document.createElement('nav');
  drawer.className = 'pn-drawer';
  drawer.id = 'pnDrawer';
  drawer.setAttribute('aria-label', 'Member portal navigation');

  const itemsHtml = NAV_ITEMS.map(item => {
    const active = isActive(item.match);
    return `<a class="pn-item${active ? ' active' : ''}" href="${item.href}"${active ? ' aria-current="page"' : ''}>`
      + `<svg width="20" height="20" viewBox="0 0 22 22" fill="none">${item.icon}</svg>`
      + `<span>${item.label}</span></a>`;
  }).join('');

  drawer.innerHTML = `
    <div class="pn-drawer-header">The Leash Club</div>
    ${itemsHtml}
    <div class="pn-divider"></div>
    <button type="button" class="pn-item pn-logout" id="pnLogout">
      <svg width="20" height="20" viewBox="0 0 22 22" fill="none">${LOGOUT_ICON}</svg>
      <span>Log Out</span>
    </button>
  `;

  const topbar = document.createElement('div');
  topbar.className = 'pn-topbar';
  topbar.id = 'pnTopbar';
  topbar.innerHTML = `
    <button type="button" class="pn-hamburger" id="pnHamburger" aria-expanded="false" aria-controls="pnDrawer" aria-label="Open menu">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none">${HAMBURGER_ICON}</svg>
    </button>
    <span class="pn-topbar-title">The Leash Club</span>
  `;

  document.body.prepend(topbar);
  document.body.prepend(overlay);
  document.body.prepend(drawer);
  // prepend() with three separate calls above places each as the new first
  // child in turn, so DOM order ends up drawer, overlay, topbar — order
  // doesn't matter here since all three are position: fixed/sticky.

  return { drawer, overlay, topbar, hamburger: topbar.querySelector('#pnHamburger'), logoutBtn: drawer.querySelector('#pnLogout') };
}

function wireDrawer({ drawer, overlay, hamburger, logoutBtn }) {
  function onKeydown(e) {
    if (e.key === 'Escape') closeDrawer();
  }

  function openDrawer() {
    drawer.classList.add('open');
    overlay.classList.add('open');
    hamburger.setAttribute('aria-expanded', 'true');
    document.addEventListener('keydown', onKeydown);
    const firstItem = drawer.querySelector('.pn-item');
    if (firstItem) firstItem.focus();
  }

  function closeDrawer() {
    drawer.classList.remove('open');
    overlay.classList.remove('open');
    hamburger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown);
    hamburger.focus();
  }

  hamburger.addEventListener('click', () => {
    if (drawer.classList.contains('open')) closeDrawer();
    else openDrawer();
  });
  overlay.addEventListener('click', closeDrawer);

  logoutBtn.addEventListener('click', async () => {
    if (typeof window.signOutMember === 'function') {
      window.signOutMember();
      return;
    }
    // Every portal page defines window.signOutMember in its own auth-guard
    // script — this should be unreachable, but a silent no-op on a Log Out
    // click would be worse than a visible error, so it gets one.
    const { showError } = await import('/js/status.js');
    showError("Couldn't sign out. Please refresh the page and try again.", { onRetry: () => location.reload() });
  });
}

injectStyles();
wireDrawer(buildDrawer());

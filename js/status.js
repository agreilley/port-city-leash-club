// status.js — shared post-submit status banner for the Leash Club site.
//
// Usage (from any page that already loads Firebase as an ES module):
//   import { showSuccess, showError, clearStatus } from '/js/status.js';
//   showSuccess("Request submitted — we'll confirm within 24 hours.");
//   showError("Couldn't submit your request. Please try again.");
//   showError("Couldn't load this page.", { onRetry: () => location.reload() });
//   clearStatus();
//
// Treatment: an inline banner in normal flow at the top of the form/card
// (NOT a fixed corner toast). Success is a sand card with a seafoam accent and
// a ✓ that auto-dismisses ~6s AFTER it has actually scrolled into view; error
// is the same card with a coral accent and a × that persists until dismissed
// (or replaced by the next show*/clearStatus call). No red fill, no animation.
//
// Self-contained: injects its own <style> once and creates its own container if
// the page hasn't provided one. Does not depend on any page's .notification CSS.

const STYLE_ID = 'pcl-status-styles';
const CONTAINER_SELECTOR = '[data-status-container]';
const AUTO_DISMISS_MS = 6000;
const VISIBLE_THRESHOLD = 0.5; // banner must be ≥50% visible before the timer starts

// Single-banner state — there is only ever one banner, so success/error replace
// each other cleanly with no stacking.
let banner = null;
let dismissTimer = null;
let visibilityObserver = null;

const CSS = `
.pcl-status {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin: 0 0 20px;
  padding: 14px 16px;
  background: #F4F0EA;
  border: 1px solid rgba(13, 27, 42, 0.08);
  border-left: 4px solid #8FA8A2;
  border-radius: 6px;
  font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  font-size: 14px;
  line-height: 1.5;
  color: #0D1B2A;
  outline: none;
}
.pcl-status:focus-visible,
.pcl-status:focus {
  box-shadow: 0 0 0 2px rgba(143, 168, 162, 0.45);
}
.pcl-status--success { border-left-color: #8FA8A2; }
.pcl-status--error   { border-left-color: #C17B6F; }

.pcl-status__icon {
  flex-shrink: 0;
  color: #8FA8A2;
  font-weight: 700;
  line-height: 1.5;
}
.pcl-status__msg { flex: 1 1 auto; }

/* Any heading rendered inside the banner uses the display serif; the message
   body stays DM Sans (set on .pcl-status above). */
.pcl-status h1,
.pcl-status h2,
.pcl-status h3,
.pcl-status .pcl-status__title {
  font-family: 'Cormorant Garamond', serif;
  font-weight: 400;
}

.pcl-status__retry {
  flex-shrink: 0;
  margin-left: 8px;
  padding: 5px 14px;
  background: #C17B6F;
  border: none;
  border-radius: 4px;
  color: #fff;
  font-family: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.pcl-status__retry:hover { background: #AD6B60; }

.pcl-status__dismiss {
  flex-shrink: 0;
  margin-left: 8px;
  padding: 0;
  background: none;
  border: none;
  color: #0D1B2A;
  opacity: 0.5;
  font-family: inherit;
  font-size: 18px;
  line-height: 1;
  cursor: pointer;
}
.pcl-status__dismiss:hover { opacity: 1; }
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// Return the mount point. Prefer a page-provided [data-status-container]; else
// create one and place it at the top of the first form (falling back to <main>,
// then <body>) so the banner reads as part of the form/card in normal flow.
function getContainer() {
  let container = document.querySelector(CONTAINER_SELECTOR);
  if (container) return container;

  container = document.createElement('div');
  container.setAttribute('data-status-container', '');

  const form = document.querySelector('form');
  if (form && form.parentNode) {
    form.parentNode.insertBefore(container, form);
  } else {
    (document.querySelector('main') || document.body).prepend(container);
  }
  return container;
}

function cancelTimers() {
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  if (visibilityObserver) {
    visibilityObserver.disconnect();
    visibilityObserver = null;
  }
}

// Start the ~6s auto-dismiss countdown, but only once the banner has actually
// scrolled into view — so a success message on a long page can't expire unseen.
function armAutoDismissWhenVisible(el) {
  if (typeof IntersectionObserver === 'undefined') {
    dismissTimer = setTimeout(clearStatus, AUTO_DISMISS_MS);
    return;
  }
  visibilityObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        if (visibilityObserver) {
          visibilityObserver.disconnect();
          visibilityObserver = null;
        }
        dismissTimer = setTimeout(clearStatus, AUTO_DISMISS_MS);
        break;
      }
    }
  }, { threshold: VISIBLE_THRESHOLD });
  visibilityObserver.observe(el);
}

// Remove any existing banner and cancel its timers. Public as clearStatus().
export function clearStatus() {
  cancelTimers();
  if (banner && banner.parentNode) {
    banner.parentNode.removeChild(banner);
  }
  banner = null;
}

function render(type, message, options = {}) {
  injectStyles();
  // Tear down whatever is showing first — guarantees a single banner (no stacking)
  // and a fresh live region so screen readers reliably re-announce.
  clearStatus();

  const el = document.createElement('div');
  el.className = `pcl-status pcl-status--${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.tabIndex = -1;

  if (type === 'success') {
    const icon = document.createElement('span');
    icon.className = 'pcl-status__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '✓';
    el.appendChild(icon);
  }

  const msg = document.createElement('span');
  msg.className = 'pcl-status__msg';
  msg.textContent = message == null ? '' : String(message); // textContent — never inject markup
  el.appendChild(msg);

  if (type === 'error') {
    if (options.onRetry) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'pcl-status__retry';
      retry.textContent = 'Retry';
      retry.addEventListener('click', options.onRetry);
      el.appendChild(retry);
    }
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'pcl-status__dismiss';
    dismiss.setAttribute('aria-label', 'Dismiss');
    dismiss.textContent = '×'; // ×
    dismiss.addEventListener('click', clearStatus);
    el.appendChild(dismiss);
  }

  getContainer().appendChild(el);
  banner = el;

  // Bring it to the reader and hand it focus without a second scroll jump.
  el.scrollIntoView({ block: 'center' });
  el.focus({ preventScroll: true });

  if (type === 'success') {
    armAutoDismissWhenVisible(el);
  }
}

export function showSuccess(message) {
  render('success', message);
}

export function showError(message, options) {
  render('error', message, options);
}

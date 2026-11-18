// Discounts and credits on a portal booking estimate (portal-request-extras.html,
// portal-extend-walk.html). Preview only: the charge itself always recomputes.
//
// - Friends & Family: applied on the page with pricing.js's applyTravelDiscount,
//   the same call the admin review makes, read from the member's own
//   members/{uid}/private/billing doc (members may read it, see firestore.rules).
// - Gift card visits, account credit, and a new member's referral discount:
//   previewMyChargeCredits (functions/index.js), the same math the charge uses.
import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

const cfg = { apiKey:"AIzaSyCMP5mj12VkvaOeJ6CXFujycPjwFrD85RM", authDomain:"port-city-leash-club-827ab.firebaseapp.com", projectId:"port-city-leash-club-827ab", storageBucket:"port-city-leash-club-827ab.firebasestorage.app", messagingSenderId:"649385306352", appId:"1:649385306352:web:8e8a6fcbe8a7eff29dfa35" };

// The active Friends & Family percent from a billing doc, or 0. Same rule as
// admin/dashboard.html's getActiveTravelDiscountPercent.
export function activeTravelDiscountPercent(billing) {
  if (!billing || !(billing.travelDiscountPercent > 0) || billing.travelDiscountActive !== true) return 0;
  return billing.travelDiscountPercent;
}

export function money(n) {
  const rounded = Math.round(n * 100) / 100;
  return '$' + (Number.isInteger(rounded) ? rounded : rounded.toFixed(2));
}

// Debounced credit lookups. Only the latest request's answer is shown, so a
// slow reply to an old estimate can't overwrite a newer one.
export function createCreditPreview({ onResult }) {
  let timer = null;
  let seq = 0;
  let callable = null;
  const empty = { giftCredit: 0, giftVisitsUsed: 0, creditApplied: 0, referralDiscountApplied: 0 };
  return {
    request(amountInDollars, booking = null) {
      clearTimeout(timer);
      const mine = ++seq;
      if (!(amountInDollars > 0)) { onResult(empty, amountInDollars); return; }
      timer = setTimeout(async () => {
        try {
          if (!callable) {
            const app = getApps().find(a => a.name === 'member-app') || initializeApp(cfg, 'member-app');
            callable = httpsCallable(getFunctions(app), 'previewMyChargeCredits');
          }
          const res = await callable({ amountInDollars, booking });
          if (mine === seq) onResult({ ...empty, ...(res.data || {}) }, amountInDollars);
        } catch (e) {
          console.error('Could not preview credits:', e);
          if (mine === seq) onResult(empty, amountInDollars);
        }
      }, 400);
    },
  };
}

// Summary lines for the credits, plus the total after them.
export function creditLines(credits, amountInDollars) {
  const rows = [];
  if (credits.giftCredit > 0) {
    const v = credits.giftVisitsUsed;
    rows.push([`Gift card${v > 0 ? ` · ${v} visit${v === 1 ? '' : 's'}` : ''}`, credits.giftCredit]);
  }
  if (credits.creditApplied > 0) rows.push(['Account credit', credits.creditApplied]);
  if (credits.referralDiscountApplied > 0) rows.push(['Referral discount', credits.referralDiscountApplied]);
  const off = rows.reduce((s, [, amt]) => s + amt, 0);
  const total = Math.max(0, Math.round((amountInDollars - off) * 100) / 100);
  return { rows, off, total };
}

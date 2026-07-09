// firebase-payments.js
// Shared utility — included on membership-request.html and service-request.html
// Handles saving a card on file (zero charge) via Stripe Elements + Cloud Functions.
//
// SETUP NEEDED (see TODO.md / payments checklist):
//   1. Replace STRIPE_PUBLISHABLE_KEY below with your real Stripe publishable key
//      (starts with pk_test_... while testing, pk_live_... once live).
//   2. Deploy the Cloud Functions in /functions before this will actually work.

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFunctions, httpsCallable } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-functions.js';

const firebaseConfig = {
  apiKey: "AIzaSyB4tKsUrk8-K8J74O7xHJE66A2bvEav-ME",
  authDomain: "port-city-leash-club-e391d.firebaseapp.com",
  projectId: "port-city-leash-club-e391d",
  storageBucket: "port-city-leash-club-e391d.firebasestorage.app",
  messagingSenderId: "649385306352",
  appId: "1:649385306352:web:8e8a6fcbe8a7eff29dfa35"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const functions = getFunctions(app);

// ─── PASTE YOUR STRIPE PUBLISHABLE KEY HERE ────────────────────────────────
const STRIPE_PUBLISHABLE_KEY = 'pk_test_REPLACE_ME';
// ─────────────────────────────────────────────────────────────────────────

let stripe, elements, cardElement;

export function mountCardField(elementId) {
  if (typeof Stripe === 'undefined') {
    console.error('Stripe.js did not load — check the <script src="https://js.stripe.com/v3/"> tag is on the page.');
    return;
  }
  stripe = Stripe(STRIPE_PUBLISHABLE_KEY);
  elements = stripe.elements();
  cardElement = elements.create('card', {
    style: {
      base: {
        fontFamily: "'DM Sans', sans-serif",
        fontSize: '15px',
        color: '#1A1A1A',
        '::placeholder': { color: '#B0B0B0' },
      },
    },
  });
  cardElement.mount('#' + elementId);

  cardElement.on('change', (event) => {
    const errorEl = document.getElementById('card-errors');
    if (errorEl) errorEl.textContent = event.error ? event.error.message : '';
  });
}

// Call this once you have a Firestore submission ID to attach the card to.
// Returns { success: true } or { success: false, error }.
export async function saveCardOnFile({ name, email, submissionId }) {
  try {
    const createSetupIntent = httpsCallable(functions, 'createSetupIntent');
    const { data } = await createSetupIntent({ name, email, submissionId });

    const result = await stripe.confirmCardSetup(data.clientSecret, {
      payment_method: { card: cardElement, billing_details: { name, email } },
    });

    if (result.error) {
      return { success: false, error: result.error.message };
    }
    return { success: true };
  } catch (err) {
    console.error(err);
    return { success: false, error: 'Something went wrong saving your card. Please try again.' };
  }
}

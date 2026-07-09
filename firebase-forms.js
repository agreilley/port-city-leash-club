// firebase-forms.js
// Shared utility — included in every page that has a form
// Submits to Firestore 'submissions' collection

import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getFirestore, collection, addDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// ─── PASTE YOUR FIREBASE CONFIG HERE ─────────────────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyB4tKsUrk8-K8J74O7xHJE66A2bvEav-ME",
  authDomain: "port-city-leash-club-e391d.firebaseapp.com",
  projectId: "port-city-leash-club-e391d",
  storageBucket: "port-city-leash-club-e391d.firebasestorage.app",
  messagingSenderId: "649385306352",
  appId: "1:649385306352:web:8e8a6fcbe8a7eff29dfa35"
};
// ─────────────────────────────────────────────────────────────────────────────

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);

export async function submitToFirestore(type, data) {
  return await addDoc(collection(db, 'submissions'), {
    type,
    ...data,
    read: false,
    createdAt: serverTimestamp()
  });
}

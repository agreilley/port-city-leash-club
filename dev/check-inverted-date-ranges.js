// dev/check-inverted-date-ranges.js
//
// One-time, READ-ONLY audit for the pricing.js / firestore.rules date-order
// hardening (see pricing.js:getDaysBetween and firestore.rules'
// validMemberServiceRequest()). Scans the `overnights` and `submissions`
// collections for any existing document where endDate is before startDate.
// Once pricing.js's getDaysBetween throws on a negative range instead of
// silently pricing at $0, any pre-existing bad record would start throwing
// wherever it's read into a price calculation (e.g. admin's request-review
// modal, or onOvernightCompleted for an already-completed overnight) — this
// script exists to find those records BEFORE that fix deploys, not after.
//
// Makes ZERO writes. Only .get() reads. Does not modify, delete, or flag
// anything — that's a deliberate follow-up decision once the blast radius
// here is known, not something to fold into a one-time script silently.
//
// Requires Firestore Admin SDK credentials. Run ONE of:
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
//     node dev/check-inverted-date-ranges.js
//   (or, if you're already `firebase login`'d with access to this project)
//   node dev/check-inverted-date-ranges.js --project port-city-leash-club-827ab
//
// firebase-admin isn't a root dependency — it only lives in functions/
// node_modules — so it's required by explicit relative path below rather
// than a bare `require('firebase-admin')`.

const path = require('path');
const admin = require(path.join(__dirname, '..', 'functions', 'node_modules', 'firebase-admin'));

const PROJECT_ID = process.argv.includes('--project')
  ? process.argv[process.argv.indexOf('--project') + 1]
  : 'port-city-leash-club-827ab';

admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

// Timestamp | Date | string | null/undefined -> millis, or null if absent/unparseable.
function toMillis(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

async function scanCollection(collectionName, startField, endField) {
  const snap = await db.collection(collectionName).select(startField, endField, 'memberId', 'status', 'type').get();
  const bad = [];
  snap.forEach(doc => {
    const data = doc.data();
    const startMs = toMillis(data[startField]);
    const endMs = toMillis(data[endField]);
    if (startMs == null || endMs == null) return; // one/both absent — not an inverted range, out of scope here
    if (endMs < startMs) {
      bad.push({
        id: doc.id,
        memberId: data.memberId || null,
        status: data.status || null,
        type: data.type || null,
        startDate: new Date(startMs).toISOString(),
        endDate: new Date(endMs).toISOString(),
      });
    }
  });
  return { scanned: snap.size, bad };
}

async function main() {
  console.log(`Scanning project "${PROJECT_ID}" — read-only, no writes.\n`);

  const overnights = await scanCollection('overnights', 'startDate', 'endDate');
  console.log(`overnights: ${overnights.scanned} documents scanned, ${overnights.bad.length} with endDate < startDate`);
  overnights.bad.forEach(r => console.log(`  - overnights/${r.id}  member=${r.memberId}  status=${r.status}  start=${r.startDate}  end=${r.endDate}`));

  console.log('');

  // submissions holds many unrelated types (contact, application, ...) —
  // only service_request / overnight_request ever carry startDate/endDate,
  // everything else is skipped automatically by the startMs/endMs null check.
  const submissions = await scanCollection('submissions', 'startDate', 'endDate');
  console.log(`submissions: ${submissions.scanned} documents scanned, ${submissions.bad.length} with endDate < startDate`);
  submissions.bad.forEach(r => console.log(`  - submissions/${r.id}  type=${r.type}  member=${r.memberId}  status=${r.status}  start=${r.startDate}  end=${r.endDate}`));

  console.log(`\nTotal bad ranges found: ${overnights.bad.length + submissions.bad.length}`);
}

main().then(() => process.exit(0)).catch(e => {
  console.error('check-inverted-date-ranges failed:', e);
  process.exit(1);
});

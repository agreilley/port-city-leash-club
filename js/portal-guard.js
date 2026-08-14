// portal-guard.js — shared "signed in, but not a member" guard for portal pages.
//
// Usage (right after the existing `if (!user) { ... }` sign-in check inside
// onAuthStateChanged):
//   import { requireMemberDoc } from '/js/portal-guard.js';
//   memberData = await requireMemberDoc(db, user.uid);
//   if (!memberData) return;
//
// A missing members/{uid} doc (e.g. an admin account browsing the member
// portal — admins live in a separate `admins` collection, so their UID never
// resolves here) and a failed read (permissions, network) show the same
// message to the user, since there's nothing member-facing to distinguish
// them by. They're logged differently, though: a missing doc is expected and
// handled, so it's a warn; a thrown read is an actual failure worth standing
// out in the console as an error.
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import { showError } from '/js/status.js';

const NOT_A_MEMBER_MSG = "This account doesn't have portal access yet. If that seems wrong, email hello@portcityleashclub.com.";

export async function requireMemberDoc(db, uid) {
  let snap;
  try {
    snap = await getDoc(doc(db, 'members', uid));
  } catch (e) {
    console.error('requireMemberDoc: read failed for members/' + uid + ':', e.message);
    showError(NOT_A_MEMBER_MSG);
    return null;
  }
  if (!snap.exists()) {
    console.warn('requireMemberDoc: no members/' + uid + ' doc — showing not-a-member message.');
    showError(NOT_A_MEMBER_MSG);
    return null;
  }
  return { id: snap.id, ...snap.data() };
}

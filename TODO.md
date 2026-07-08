# Port City Leash Club — Open Items

Running list of things to work on. Add to this as new items come up; check items off (or remove) once done.

---

## Website / Content

- [x] ~~Cats and other pets are missing from Pet Sitting Services~~ — **Done.** Homepage copy, service request form (Pet Type dropdown added), FAQ entry, and the member portal's Pet Profile page wording are all species-neutral now.

## Known Issues

- [x] ~~`service-request.html` and `membership-request.html` submit buttons don't actually save anything~~ — **Fixed.** Both forms now write real submissions to Firestore and call `saveCardOnFile()` with the resulting submission ID. Still blocked on the Stripe/Firebase setup checklist below before the card-saving piece actually works end-to-end.
- [x] ~~"Extra pet +$20" add-on checkbox disconnected from the multi-dog card system~~ — **Fixed.** Removed the manual checkbox; the $20 add-on is now derived automatically from the number of pet cards (charged whenever more than one pet is added).

## Found During Full Site Audit (July 8)

- [x] ~~`portal-messages.html` had a leftover pre-Firebase `sendMessage()` stub and fake "Marcus" / "Priya" conversation threads in the sidebar~~ — **Partially fixed.** Removed the dead stub and the fake per-walker conversation switcher (it never loaded different content — just changed which item looked active). Sending a message to Port City Leash Club now reliably hits the real Firestore-backed `sendMessage`.
- [ ] **Still open:** `portal-messages.html` doesn't load or display real message history — the thread shown is hardcoded demo content, not pulled from Firestore. Sent messages land in `submissions` but the member never sees them (or anything else) rendered back. Needs a real read path (query `submissions` where `type == 'message' && memberId == current user`, render as a thread, ideally `onSnapshot` for live updates) before this page is genuinely functional.
- [ ] No UI anywhere calls the `chargeSavedCard` or `createMembershipSubscription` Cloud Functions — confirmed still true as of this audit. This is the biggest remaining gap before real payments can go live; needs its own design pass on what the admin "Confirm" flow should look like (charge immediately vs. on a schedule, what happens on failure, etc).

## Payments — Stripe Setup Checklist (do these yourself, in order)

Code is built (`/functions`, `firebase-payments.js`, card fields on both forms). These are the account-level steps that need to happen in your own Stripe and Firebase consoles before any of it goes live — none of these can be done on your behalf.

1. **Create a Stripe account** at stripe.com if you don't have one yet.
2. **Get your API keys** — Stripe Dashboard → Developers → API keys. You'll have a "Publishable key" (`pk_...`) and a "Secret key" (`sk_...`). Start with the **test mode** keys while everything is being wired up; switch to live keys only once you're ready to actually take real payments.
3. **Put the publishable key in the code** — open `firebase-payments.js`, replace `pk_test_REPLACE_ME` with your real publishable key. This one is safe to be visible in the code (it's meant to be public).
4. **Upgrade Firebase to the Blaze plan** — Firebase Console → your project → Upgrade. Requires a billing method on file. No monthly fee itself; pay-as-you-go, and at this business's scale expect $0–5/month (see cost notes from our conversation).
5. **Store the secret key securely** — never put this one in the code. From a terminal with the Firebase CLI installed and logged in:
   ```
   firebase functions:secrets:set STRIPE_SECRET_KEY
   ```
   Paste your Stripe secret key when prompted.
6. **Create the 3 membership Prices in Stripe** — Stripe Dashboard → Products → Add Product. Create one product each for Essential / Standard / Daily, each with a recurring monthly price matching current rates. Copy each Price ID (`price_...`) — these get passed into `createMembershipSubscription` later when admin confirms a new member.
7. **Deploy the functions**:
   ```
   firebase deploy --only functions
   ```
8. **Real form submission is already wired** — both forms write to Firestore and call `saveCardOnFile()` automatically on submit. Nothing further needed here once steps 1–7 are done.
9. **Build the admin-side "Confirm" actions** in the admin dashboard to actually call `chargeSavedCard` (one-time services) or `createMembershipSubscription` (memberships) — right now these Cloud Functions exist but nothing in the UI calls them yet.

## Still Open From Earlier Sessions

- [x] ~~Firestore: add "travel" as a valid tier value for pet-sitting-only clients~~ — **Done.** "Travel" is now a valid `tier` value. Admin can create one manually (Add Member modal), or — the main intended path — one gets created automatically the first time a non-member's one-time service request is confirmed in the admin inbox ("Confirm & Save as Client" button on `service_request` items). The tier stays invisible to the client themselves — the portal dashboard, account page, and pause-membership page all show neutral copy ("Pet Sitting," "No walk membership yet") instead of the literal word "Travel."
- [ ] Launch timeline: remove "Now booking pet sitting and dog walking for our August 2026 launch. Reserve your spot today." language from the hero once walks actually start (mental deadline: August 15, adjust as needed)

## Newly Found While Building the Travel Tier

- [x] ~~"Convert to Member" and "Add as Walker" buttons in the admin dashboard inbox were visually present but not wired to anything (`onclick = null`)~~ — **Fixed.** Both now open the existing Add Member / Add Walker modals prefilled with the request's data, and mark the source submission `confirmed` once the member/walker record is created.
- [ ] Worth deciding whether "Pause Membership" makes sense to show at all for Travel-tier clients — they have no recurring membership/billing to pause, so that nav item may be confusing for them. Not fixed yet, just flagging.
- [x] ~~Admin dashboard's Add Member tier dropdown still shows outdated pricing (Essential $129/mo, Standard $249/mo, Daily $429/mo)~~ — **Fixed.** Now shows current per-walk rates ($26 / $25 / $22).

## Password Reset

- [x] ~~Add password reset workflow to all three portals~~ — **Done.** Member portal already had a working reset flow (`portal-password-reset.html`); built matching versions for admin (`admin/reset-password.html`) and walker (`walker/reset-password.html`), each using the correct named Firebase app instance to match their login/dashboard pages. "Forgot password?" links added to both the admin and walker login pages.
- [ ] Firebase Console: customize the password reset email template (Authentication → Templates) — the workflow is fully functional, but the actual email a user receives is still Firebase's generic default wording/branding unless customized. This is an account-level setting, not something fixable from code.

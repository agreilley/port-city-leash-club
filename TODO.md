# Port City Leash Club — Open Items

Running list of things to work on. Add to this as new items come up; check items off (or remove) once done.

---

## Website / Content

- [ ] **Cats and other pets are missing from Pet Sitting Services.** The site currently only talks about dogs (dog walking, dog details forms, etc.), but drop-in visits and overnight stays should also cover other pets — cats especially. Needs:
  - Homepage Pet Sitting Services copy/cards reviewed for dog-only language
  - Service request form: "Dog Details" section either renamed/generalized or a parallel path added for non-dog pets
  - New FAQ entry answering "Do you take care of pets other than dogs?" (or similar)

## Known Issues

- [ ] `service-request.html` and `membership-request.html` submit buttons still don't actually save anything (still `alert('Mockup only...')` / no real submit handler wired). The card-saving piece is now built (see below) but needs to be connected to real form submission logic — the submission needs to be written to Firestore first (to get a `submissionId`), then `saveCardOnFile()` called with that ID before showing the confirmation message.
- [ ] "Extra pet +$20" add-on checkbox on the service request page is disconnected from the new multi-dog card system — someone could add 2+ dog cards without checking the add-on, or vice versa. Worth deciding whether pricing should auto-derive from number of dog cards instead of a manual checkbox.

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
8. **Wire up real form submission** on both request forms (see Known Issues above) — write the submission to Firestore, then call `saveCardOnFile()` from `firebase-payments.js` with the resulting submission ID.
9. **Build the admin-side "Confirm" actions** in the admin dashboard to actually call `chargeSavedCard` (one-time services) or `createMembershipSubscription` (memberships) — right now these Cloud Functions exist but nothing in the UI calls them yet.

## Still Open From Earlier Sessions

- [ ] Firestore: add `"travel"` as a valid `tier` value for pet-sitting-only clients (no active walk membership)
- [ ] Launch timeline: remove "Now booking pet sitting and dog walking for our August 2026 launch. Reserve your spot today." language from the hero once walks actually start (mental deadline: August 15, adjust as needed)

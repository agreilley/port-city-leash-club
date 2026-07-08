# Port City Leash Club — Open Items

Running list of things to work on. Add to this as new items come up; check items off (or remove) once done.

---

## Website / Content

- [x] ~~Cats and other pets are missing from Pet Sitting Services~~ — **Done.** Homepage copy, service request form (Pet Type dropdown added), FAQ entry, and the member portal's Pet Profile page wording are all species-neutral now.

## Known Issues

- [x] ~~`service-request.html` and `membership-request.html` submit buttons don't actually save anything~~ — **Fixed.** Both forms now write real submissions to Firestore and call `saveCardOnFile()` with the resulting submission ID. Still blocked on the Stripe/Firebase setup checklist below before the card-saving piece actually works end-to-end.
- [x] ~~"Extra pet +$20" add-on checkbox disconnected from the multi-dog card system~~ — **Fixed.** Removed the manual checkbox; the $20 add-on is now derived automatically from the number of pet cards (charged whenever more than one pet is added).
- [x] ~~Walker portal's "Mark as Completed" set `status: 'completed'` and nothing else — no photo, no note, despite `portal-walk-history.html` and the marketing site both promising walk photos/notes~~ — **Fixed.** Completing a walk now opens a small form (note textarea + photo upload to Firebase Storage) before it's marked done. `walks` docs now actually get `notes` and `photoUrl` populated. This was a prerequisite for the automated walk-update texts below — there was nothing to send.
- [ ] `DATABASE_SCHEMA.md` is a stale planning document from before the app was actually built — field names, collection structure, and even the security rules example in it don't match what's actually implemented (e.g. it describes a `messages` collection with `senderId`/`recipientId` that was never built; the real system uses `submissions` and, as of this session, `conversations`). Didn't touch it this session since it's out of scope, but it should probably move to the "archived" list alongside the other outdated docs, or get rewritten to match reality.

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

## Member Communication — Messaging Setup Checklist (do these yourself, in order)

Code is built (`functions/index.js`, admin portal "Messages" section, walker photo/note capture). These are the account-level steps that need to happen in your own Google, Twilio, and Firebase accounts before any of it actually sends or receives anything — none of these can be done on your behalf. Until they're done, the system degrades gracefully rather than breaking: manual sends show a clear "not set up yet" error, and automated walk-completion texts log what *would* have been sent instead of silently doing nothing (visible in the admin Messages screen with a "texting isn't connected yet" note).

### Google Workspace / Gmail

1. **Go to** [console.cloud.google.com](https://console.cloud.google.com) and create a new project (e.g. "Port City Leash Club Admin").
2. **Enable the Gmail API** for that project (APIs & Services → Library → search "Gmail API" → Enable).
3. **Set up the OAuth consent screen** — APIs & Services → OAuth consent screen. Choose **User type: Internal** (only available because this is a Workspace account — this is what avoids Google's verification process and the token-expiry issue entirely).
4. **Create an OAuth Client ID** — APIs & Services → Credentials → Create Credentials → OAuth client ID → Application type: **Web application**. Under "Authorized redirect URIs," add:
   ```
   https://us-central1-port-city-leash-club-827ab.cloudfunctions.net/gmailAuthCallback
   ```
   (This must match `GMAIL_REDIRECT_URI` in `functions/index.js` exactly — only change one if you change the other.)
5. **Copy the Client ID and Client Secret**, then set them:
   ```
   firebase functions:secrets:set GOOGLE_CLIENT_ID
   firebase functions:secrets:set GOOGLE_CLIENT_SECRET
   ```
6. **Check the "from" address** — `functions/index.js` sends as `hello@portcityleashclub.com` (the `BUSINESS_EMAIL_DISPLAY` / `BUSINESS_EMAIL_DOMAIN` constants near the top of the messaging section). If your real Workspace address is different, update both constants before deploying.
7. **Deploy, then click "Connect Gmail"** in the admin portal's Messages screen — this takes you through Google's consent flow and stores the connection. One-time step (Internal apps don't need reconnecting on a schedule).

### Twilio (phone number for walk-update texts + client texting)

1. **Sign up** at twilio.com and verify your business.
2. **Buy a US local number** with SMS + MMS capability (~$1.15/month).
3. **Complete A2P 10DLC registration** — Twilio's required process for business texting in the US (your LLC's info + a description of the use case: service notifications + customer messaging). Worth starting early — approval can take a few days.
4. **Copy the Account SID, Auth Token, and phone number**, then set them:
   ```
   firebase functions:secrets:set TWILIO_ACCOUNT_SID
   firebase functions:secrets:set TWILIO_AUTH_TOKEN
   firebase functions:secrets:set TWILIO_PHONE_NUMBER
   ```
5. **Set the inbound webhook** — in the Twilio Console, under your phone number's Messaging configuration, set "A message comes in" to:
   ```
   https://us-central1-port-city-leash-club-827ab.cloudfunctions.net/twilioInboundWebhook
   ```
   (Must match `TWILIO_WEBHOOK_URL` in `functions/index.js` exactly, including `https://` — signature validation will silently fail otherwise.)

### Firestore & Storage security rules — add manually, not deployed from this repo

This repo doesn't currently track the live Firestore rules as a file (they're edited directly in the Firebase Console), so rather than guess at and overwrite your actual live rules from a summary, add these two blocks to what's already there:

```
// Conversations — admin only, never exposed to members or walkers
match /conversations/{memberId} {
  allow read, write: if request.auth.token.admin == true
                      || exists(/databases/$(database)/documents/admins/$(request.auth.uid));
  match /messages/{messageId} {
    allow read, write: if request.auth.token.admin == true
                        || exists(/databases/$(database)/documents/admins/$(request.auth.uid));
  }
}

// Gmail refresh token — admin only, very sensitive
match /system/gmailAuth {
  allow read, write: if request.auth.token.admin == true
                      || exists(/databases/$(database)/documents/admins/$(request.auth.uid));
}
```

And in **Storage rules** (Firebase Console → Storage → Rules), allow walkers to upload walk photos:
```
match /walk-photos/{walkId}/{fileName} {
  allow read: if request.auth != null;
  allow write: if request.auth != null; // any signed-in walker/admin; tighten later if needed
}
```

### Deploy

```
firebase deploy --only functions
```

### What's NOT built yet, worth knowing

- **Unmatched texts** (from a number that doesn't match any member) show up in the admin Messages screen under their own thread, clearly labeled, but there's no "link this to a member" button yet — you'd currently just find/create the member manually and know to expect their replies going forward via the normal matching. Fine at low volume; worth a real "claim" button if this becomes frequent.
- **Gmail sync runs on a 5-minute poll**, not instant push — a member's email reply will take up to 5 minutes to show up in the admin portal. Fine for a business this size; can move to Gmail's push notifications (Pub/Sub) later if that lag ever matters.

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

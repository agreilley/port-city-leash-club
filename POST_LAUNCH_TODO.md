# Post-Launch TODO

Work deliberately deferred past launch (2026-07-25). Each item has enough context
to pick up cold, plus a one-line reason it was deferred. Nothing here is a launch
blocker — it's the "do it when there's a focused session / real traffic / it's
September" pile.

---

## 1. Build the real "Update Payment Method" flow

- **What:** Stripe SetupIntent + Elements card form + set-new-card-as-default.
- **Context:** The button is currently **hidden** (commented out) in
  `portal-account.html` (~line 517, in the "Billing & Payment" section-card).
  Restore and wire it when the flow is built. `stripeCustomerId` now lives in
  `members/{id}/private/billing` (relocated in M-1), **not** on the member doc —
  read it from there. The card-on-file display line (`#paymentMethodDisplay`,
  "A card is securely saved on file.") is already live and stays.
- **Opportunity:** while here, add real **last-4 display** instead of the generic
  on-file text.
- **Why deferred:** needs a focused session + live Stripe testing, not
  launch-day work.

## 2. M-4 — Stripe webhook reconciliation

- **What:** a webhook handler for `payment_intent.payment_failed` and
  `charge.dispute.created`, using `stripe.webhooks.constructEvent` for signature
  verification.
- **Context:** No Stripe webhook handler exists at all today. Failed and disputed
  charges are currently noticed **manually**, not alerted.
- **Why deferred:** targeted for **September**. Until built, no automated alerting
  on payment failures/disputes.

## 3. App Check on the public forms (M-2 companion)

- **What:** bot/abuse gate for the four public forms — `contact.html`,
  `membership-request.html`, `service-request.html`, `careers.html`.
- **Context:** reCAPTCHA site key + App Check SDK on the 4 public pages +
  enforcement on Firestore. Roll out in **monitoring mode first**, confirm no
  legitimate traffic is blocked, then enforce. This is the companion to the M-2
  submissions.create hardening (already shipped).
- **Why deferred:** needs real post-launch traffic to tune enforcement safely —
  enforcing pre-launch would be flying blind.

## 4. M-3 — walk-photo write scoping (`storage.rules`)

- **What:** gate writes to `walk-photos/{walkId}/{fileName}` to walkers only, via
  a custom auth claim (`request.auth.token.walker == true`).
- **Context:** Today `allow write` is any signed-in user (admin/walker/member),
  bounded only by an 8 MB size cap and an `image/*` contentType check — so a
  member could in principle upload a walk photo. Proper scoping needs custom
  claims because cross-service Firestore lookups do **not** work in
  `storage.rules` (documented at length in that file — `firestore.exists/get`
  fail at evaluation, not compilation). The claim would be set when a walker
  account is created.
- **Why deferred:** low practical impact (photos aren't sensitive; abuse is
  bounded by the size/type checks).

## 5. Emergency contact on pet profile

- **What:** a per-**household** emergency contact (NOT per-dog), stored on the
  member doc as `emergencyContact: { name, phone, relationship }`.
- **Context:** The `firestore.rules` member-update allowlist **already permits**
  `emergencyContact`, so **no rule change is needed** — just build the UI and
  wire it into the existing pet-profile / account save flow.
- **Why deferred:** post-security-work feature, not urgent.

---

## Known-deferred notes carried forward from in-code TODOs

Recorded here so they live in one place; the authoritative TODO comments remain
in the code.

- **`TODO(cancel)` — `createMembershipSubscription`** (`functions/index.js`
  ~line 463): a future cancellation flow MUST do all three together, or the crons
  keep billing a cancelled member:
  1. set `hasActiveSubscription: false` on the member doc,
  2. delete/null the `members/{id}/private/billing` subdoc, and
  3. call `stripe.subscriptions.cancel()`.
  `hasActiveSubscription` is a durable cron flag — pause/resume do **not** touch
  it, so only a real cancellation should clear it.

- **`TODO(post-launch)` — client-side `stripeCustomerId` copy**
  (`portal-request-extras.html` ~line 383, `portal-extend-walk.html` ~line 419):
  resolve `stripeCustomerId` **server-side** in the charge path (from `memberId`,
  in `chargeSavedCard`) instead of copying it client-side into the request.
  Not a security issue — just cleaner.

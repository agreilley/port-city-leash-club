# Port City Leash Club — Source of Truth

**Describes commit:** `285d5769aa70a5ab923493926266e9fbbfbd9491` (2026-08-29)
**Update (2026-08-30):** the working-tree changes described below in [§1.13](#113-uncommitted-working-tree-changes-important) as uncommitted have since been committed as `bb6fb02` — see that section for the current status. This document's Part 1 narrative elsewhere (e.g. §1.7's `stripeWebhook` row) was written when those changes were still uncommitted; treat §1.13 as the authoritative status for that specific feature, not the surrounding prose.
**Document generated:** 2026-08-29, by direct code inspection (six parallel research passes over the live working tree, cross-checked against each other and against `git diff`/`git log`), not copied from any prior document.
**Supersedes:** a previous `docs/SOURCE_OF_TRUTH.md` generated 2026-08-28 against commit `af87c3c` — that version is folded into the [Contradictions](#contradictions-found-prior-source-of-truth-af87c3c-vs-this-document) section below rather than discarded outright, since it's the only prior baseline actually available to diff against. **The original human-written "old doc" this document is supposed to carry business content from (Part 2) has still not been supplied in any session** — see [Part 2](#part-2--human-maintained-not-verified-against-code-owned-by-alison).

This file has two parts with different authority. Read the header of each before trusting anything in it.

---

# PART 1 — CODE-DERIVED (authoritative)

Every claim below is traceable to a `file:line` citation. If code and this document ever disagree, trust the code and fix this document — see [How to re-verify](#how-to-re-verify-this-document).

## 1.1 Member pricing and tiers

- Flat member walk rate (client-side display constant): `MEMBER_WALK_RATE = 27` — [pricing.js:31](../pricing.js#L31).
- Server-side Stripe counterpart: `MEMBER_PRICE_ID = 'price_1U3NghBYaaTA3vAvHzpaaHmg'; // $27/walk flat rate` — [functions/index.js:84](../functions/index.js#L84).
- `resolveMemberPriceId(tier)` — [functions/index.js:92-96](../functions/index.js#L92):
  - `tier === 'Member'` → returns `MEMBER_PRICE_ID` (every recurring member, flat rate, regardless of walk frequency) — L93.
  - `tier === 'Travel'` → returns `null` (one-time/pet-sitting client, no subscription) — L94.
  - Anything else → throws `HttpsError('failed-precondition', ...)` — a stray/garbage tier is a hard error, not silently ignored — L95.
  - Only two tier values are recognized anywhere in the codebase — confirmed via other tier checks at [functions/index.js:531](../functions/index.js#L531) and [functions/index.js:1512](../functions/index.js#L1512).
- One-time (non-member) standard walk: `STANDARD_WALK_PRICE = 30` — [pricing.js:23](../pricing.js#L23); `SERVICE_PRICES['standard-walk'].price = STANDARD_WALK_PRICE` — [pricing.js:41](../pricing.js#L41).
- One-time extended walk: `STANDARD_WALK_PRICE + WALK_EXTENSION_PRICE` = $42 — [pricing.js:42](../pricing.js#L42).

## 1.2 Add-on prices (`pricing.js` — single source of truth per its own header comment)

| Item | Value | Citation |
|---|---|---|
| Walk extension | $12 | `WALK_EXTENSION_PRICE = 12` — [pricing.js:24](../pricing.js#L24) |
| Check-in / drop-in visit | $25/day | `SERVICE_PRICES['drop-in-visit'].price = 25`, `unit: 'night'` — [pricing.js:43](../pricing.js#L43) |
| Overnight stay | $115/night | `SERVICE_PRICES['overnight-stay'].price = 115`, `unit: 'night'` — [pricing.js:44](../pricing.js#L44) |
| Extra pet | $10 | `EXTRA_PET_FEE = 10` — [pricing.js:74](../pricing.js#L74) |
| Medication admin | $10 | `MEDICATION_FEE = 10` — [pricing.js:75](../pricing.js#L75) |

Extra pet and medication only apply when `unit === 'night'` — i.e. drop-in/overnight bookings, never plain walks — gate logic at [pricing.js:98-101, 137-138](../pricing.js#L98).

Legacy key aliasing (portal-facing form field names → canonical service keys): `SERVICE_KEY_ALIASES = { overnight: 'overnight-stay', checkin: 'drop-in-visit' }` — [pricing.js:69-72](../pricing.js#L69).

`functions/pricing.js`, `functions/walker-pricing.js`, `functions/time-slots.js`, and `functions/visit-slots.js` are **generated copies** — `firebase.json`'s predeploy hook copies all four root files into `functions/` on every `firebase deploy --only functions`:
```
"predeploy": ["cp \"$RESOURCE_DIR/../pricing.js\" \"$RESOURCE_DIR/../walker-pricing.js\" \"$RESOURCE_DIR/../time-slots.js\" \"$RESOURCE_DIR/../visit-slots.js\" \"$RESOURCE_DIR/\""]
```
Confirmed byte-identical to their root counterparts (`diff` — no output) as of this snapshot. Never edit the `functions/` copies directly.

## 1.3 Walker payout rates (`walker-pricing.js`)

`WALKER_RATES = { standard: 16, extended: 24, checkin: 13, overnight: 65 }` — [walker-pricing.js:25-36](../walker-pricing.js#L25).

| Item | Value | Citation |
|---|---|---|
| Standard walk | $16 | [walker-pricing.js:26](../walker-pricing.js#L26) |
| Extended walk (flat — replaces the standard rate, not additive) | $24 | [walker-pricing.js:27](../walker-pricing.js#L27) |
| Check-in visit | $13/visit (not per day) | [walker-pricing.js:28](../walker-pricing.js#L28) |
| Overnight stay | $65 — a **composite** figure ($45 overnight + $13 check-in + $7 top-up); code explicitly warns "don't simplify this back down to $45" | [walker-pricing.js:29-36](../walker-pricing.js#L29) |
| Extra pet | $5/day | `WALKER_EXTRA_PET_FEE = 5` — [walker-pricing.js:38](../walker-pricing.js#L38) |
| Medication admin | $5/day | `WALKER_MEDICATION_FEE = 5` — [walker-pricing.js:39](../walker-pricing.js#L39) |

There is **no separate "extension" payout line** — an extended walk pays the flat `extended` rate in place of `standard`, never `standard + extension`.

`calculateOvernightPayout` ([walker-pricing.js:68-84](../walker-pricing.js#L68)): if the reservation has a non-empty `visitSchedule`, pays `WALKER_RATES.checkin × total visits`; otherwise falls back to `WALKER_RATES[key] × days`. Extra pet / medication are always per-DAY regardless of which branch fired ([walker-pricing.js:73-81](../walker-pricing.js#L73)).

**Holiday surcharge (+30%, on the walker rate card) is NOT implemented** — explicit comment: "no rule was ever defined for which dates count as a holiday or whether it's automatic vs. admin-marked... skipped rather than guessed" — [walker-pricing.js:11-14](../walker-pricing.js#L11). No other rate modifiers (seasonal, distance, tier-based) exist anywhere in this file or its call sites.

## 1.4 The visit grid — how check-ins, overnights, extra pet, and medication actually price

Two genuinely different pricing paths live under one "Additional Care" umbrella:

- **A true overnight stay** is priced flat: $115/night × nights, regardless of how many visits happen during it. Its optional `overnightVisitPlan` is **scheduling-only, never pricing** — [admin/dashboard.html:3700-3714](../admin/dashboard.html#L3700), [functions/index.js:4084-4102](../functions/index.js#L4084).
- **A check-in (drop-in) booking** is priced off an actual **visit schedule** — a per-day array of `{date, visits: count, slots: [...]}` — via `computeDropInVisitTotal()`, which sums total visits across all days and multiplies by `SERVICE_PRICES['drop-in-visit'].price` ($25), rather than a flat `days × visitsPerDay` estimate — [admin/dashboard.html:3685-3698](../admin/dashboard.html#L3685).

**This distinction was a real bug until commit `a7c21f5`** (2026-08-29, same day as this document): a member who chose "Check-In Visit" through the *overnight* request form (as opposed to the plain service-request form) was always priced as a flat estimate, because the pricing branch was keyed on which form the submission came from rather than on `serviceKey` alone. Fixed by keying `isCheckin = serviceKey === 'drop-in-visit'` on the service type only, independent of submission type — [functions/index.js:4155](../functions/index.js#L4155), comment at [4147-4154](../functions/index.js#L4147). The fix also means a check-in booked through the overnight form now correctly pays the walker per-visit (via `visitSchedule`) instead of per-day, since `calculateOvernightPayout` reads the same field.

**Slot vocabulary for the visit grid**: `VISIT_SLOTS = ['morning', 'midday', 'evening', 'last-out']`, with labels and clock ranges (7–10am / 11am–2pm / 5–8pm / 9–11pm) — [visit-slots.js:24-45](../visit-slots.js#L24). `defaultSlotsForCount(count)` spreads a chosen visit count across the day (1→morning, 2→morning+evening, 3→+midday, 4→all four, 5+→repeats `last-out`) — [visit-slots.js:65-75](../visit-slots.js#L65). This is a **separate vocabulary from plain-walk time slots** (`WALK_TIME_SLOTS = ['morning','early-afternoon','late-afternoon']`, [time-slots.js:35](../time-slots.js#L35)) — deliberately, since pet-sitting visits can happen outside walk hours; there is no cross-file consistency check between the two, none is intended ([visit-slots.js:1-16](../visit-slots.js#L1)).

**Which forms actually price through this vs. hardcode**: `service-request.html`, `portal-request-extras.html`, and `admin/dashboard.html` all import `SERVICE_PRICES`/`calculateServiceTotal` directly from `pricing.js` — none hardcodes a dollar figure independently ([service-request.html:741,808](../service-request.html#L741), [portal-request-extras.html:270,308](../portal-request-extras.html#L270), [admin/dashboard.html:958](../admin/dashboard.html#L958)). Server side, `functions/index.js` dynamically imports `pricing.js` at every charge/booking site rather than re-deriving numbers, and explicitly trusts the already-computed `amountInDollars`/`visitSchedule` sent up from the admin's review UI rather than recomputing server-side — comment at [functions/index.js:4018-4023](../functions/index.js#L4018). **This is a real trust boundary**: nothing server-side re-derives the charge amount from the visit schedule independently before charging the card (see [project_chargeCustomerCard_trust_boundary] in prior memory — still true, not re-verified line-by-line in this pass).

## 1.5 Signup flow, stage by stage

Every stage requires a human click-through; nothing here runs end-to-end automatically.

**Stage 0 — Public request.** `membership-request.html` writes a `submissions` doc directly (`type: 'membership_request'`, hardcoded) via client-side `addDoc` — [membership-request.html:626-647](../membership-request.html#L626). No Auth account, no member doc, no Stripe object, no card exists yet.

**Stage 1 — `onNewSubmission`** ([functions/index.js:6056-6177](../functions/index.js#L6056), `onDocumentCreated` on `submissions/{id}`) — sends the "we got your request" email, tracks referral-code redemption, and (only if a meet & greet slot was parsed) mirrors it into `meet_greet_availability` and pings the admin's Gmail. Does not create an account or touch billing.

**Stage 2 — `completeMeetGreetAndCreateAccount`** ([functions/index.js:3752-3943](../functions/index.js#L3752), `onCall`, admin-gated). Requires `meetGreetCompleted: true` explicitly. Creates the Firebase Auth user (random unguessable password, never shown) and the `members/{uid}` doc; handles referral-code intake. Comment states directly: "Deliberately does nothing beyond account creation: no Stripe subscription, no walk generation, no charge" — [functions/index.js:3741-3744](../functions/index.js#L3741). Sends the `portal-access` email with a Firebase password-set link.

**Stage 3 — Member adds a card**, from their own portal: `createAuthenticatedSetupIntent` ([functions/index.js:300-326](../functions/index.js#L300)) creates the SetupIntent; `confirmCardOnFile` ([functions/index.js:350-435](../functions/index.js#L350)) verifies it succeeded, sets it as the Stripe default payment method, sets `billing.cardOnFile = true`, and — this is the trigger — calls `finalizeSubmissionIfReady` for every open submission on that member ([functions/index.js:410-432](../functions/index.js#L410)).

**Stage 4 — `finalizeSubmissionIfReady`** ([functions/index.js:4453-4663](../functions/index.js#L4453), plain function, not a direct export — called from `confirmCardOnFile`, `markDatesConfirmed`, and admin-triggered `retryFinalizeSubmission`). Gated on: `memberId` present, eligible status, and (for membership) card on file, or (for service/overnight) card **and** confirmed dates. Uses a transactional `billingFinalized` claim so it runs exactly once. For membership: calls `runCreateMembershipSubscription` → `runGenerateInitialWalks` → `runChargeCurrentMonthWalks` → confirmation email. For service/overnight: `runServiceOrOvernightCharge` → confirmation email. Never rolls back a booking on failure — records `finalizeError` and flips `billing.needsReview` instead.

**Stage 5 — `runCreateMembershipSubscription`** ([functions/index.js:1141-1299](../functions/index.js#L1141)). Idempotent on `billing.stripeSubscriptionId` already set. Preconditions that throw `failed-precondition` if unmet: a saved card, at least one attached Stripe payment method, and `defaultWalkDays` non-empty for next month. Creates the subscription with `billing_cycle_anchor` at 6pm ET on the 1st of next month, `proration_behavior: 'none'`.

**Stage 6 — `runGenerateInitialWalks`** (exported `generateInitialWalks`, [functions/index.js:1406-1467](../functions/index.js#L1406)) — a deliberately separate follow-up step so a bug here can't affect the subscription-creation path it's paired with. Generates the member's first (partial) billed month of walk docs.

**Member's later schedule edit**: `updateWalkSchedule` ([functions/index.js:1498](../functions/index.js#L1498), `onCall`, member self-service, `tier === 'Member'` only) — reconciles *next* month's walks against a new day/time-slot selection, preserving walker assignment and extension state on surviving dates, handling orphaned-extension credit/move. Only ever touches next month; never the already-billed current month. Confirmed call sites: `portal-account.html:859,904` only — the admin dashboard does not call it directly (only comments reference the state it produces).

## 1.6 The visit model — generation, slots, completion, photos, notifications

**Generation.** `generateOvernightVisits(reviewed, isCheckin)` ([functions/index.js:4056-4139](../functions/index.js#L4056)) is called once, when an `overnights/{id}` doc is first written ([functions/index.js:4242](../functions/index.js#L4242)). Each visit object: `{ id, date, slot, status: 'expected', completedAt: null, note: '', photoUrl: null, walkerId: '', walkerName: '' }`. `id` is a real Firestore auto-ID minted up front, not an array index. Three branches: check-in bookings flat-map the admin-built `visitSchedule` into one visit per slot per day; a true overnight with an admin-edited `overnightVisitPlan` uses that; a true overnight with no plan gets one visit/night at a fixed `'midday'` slot.

**Completion — per visit.** `walker/dashboard.html`'s `completeVisit(overnightId, visitId)` ([walker/dashboard.html:697-747](../walker/dashboard.html#L697)) does a read-modify-write of the whole `visits` array (not `arrayUnion` — Firestore rejects `serverTimestamp()` inside an array element, so it uses client-clock `Timestamp.now()` instead, per comment at [walker/dashboard.html:724-728](../walker/dashboard.html#L724)). This is distinct from `completeOvernight(overnightId)`, which marks the whole reservation complete and is untouched by the per-visit system ([walker/dashboard.html:609-612](../walker/dashboard.html#L609)). Whole-walk completion is `completeWalk(walkId)` ([walker/dashboard.html:1085-1124](../walker/dashboard.html#L1085)).

**Photos.** Walk photos: `walk-photos/${walkId}/${Date.now()}_${file.name}` ([walker/dashboard.html:1112](../walker/dashboard.html#L1112)). Visit photos: `overnight-photos/${overnightId}/${visitId}_${Date.now()}_${file.name}` ([walker/dashboard.html:717](../walker/dashboard.html#L717)). Both client-enforce image type and an 8MB cap; `storage.rules` enforces the same server-side (see [§1.11](#111-storagerules--honest-summary)).

**Backend triggers:**
- `onWalkCompleted` ([functions/index.js:5283-5367](../functions/index.js#L5283)) — fires on `status: scheduled → completed`; stamps `payout` (rate locked at completion); sends an SMS linking to the walk's Care History card (no photo attached as MMS — see below).
- `onOvernightCompleted` ([functions/index.js:5378-5438](../functions/index.js#L5378)) — same pattern for the whole reservation; stamps payout only, no SMS/email.
- **`onOvernightVisitCompleted`** ([functions/index.js:5462-5551](../functions/index.js#L5462), new in commit `285d576`) — diffs `before.visits`/`after.visits` by `id` to find entries that newly flipped to `completed`, fires once per newly-completed visit. Sends an SMS (Twilio-gated, falls back to a `pending_credentials` log entry) and — independent of SMS/Twilio state — an email via the new `visit-completed` template. Does **not** stamp payout and does not write back to the doc, so there's no self-retrigger loop.

**"Care History."** `portal-walk-history.html` was converted from a walks-only page into a merged timeline: loads `walks` and `overnights` in parallel (both `where memberId == uid`), filters each to completed records, flat-maps each `overnights` doc's `visits` array into one card per completed visit, and sorts all of it — walks and visits together — into one reverse-chronological list, not stacked sections ([portal-walk-history.html:633-684](../portal-walk-history.html#L633)). Supports deep links (`?walk={id}` or `?overnight={id}&visit={id}`) that scroll/highlight the matching card ([portal-walk-history.html:553-566](../portal-walk-history.html#L553)). The nav label changed to "Care History" across every portal page's sidebar.

**"Link SMS to portal."** The automated completion SMS bodies were changed from attaching the photo as an MMS / embedding notes text, to instead linking out: `"${dogName} had a great walk! See notes and photos: ${walkLink}"` where `walkLink = ${BUSINESS_PORTAL_ORIGIN}/portal-walk-history?walk=${walkId}` ([functions/index.js:5338-5339](../functions/index.js#L5338)); same pattern for visits ([functions/index.js:5488,5498](../functions/index.js#L5488)). `BUSINESS_PORTAL_ORIGIN = 'https://www.portcityleashclub.com'` — [functions/index.js:3601](../functions/index.js#L3601).

**Email template.** `functions/templates/visit-completed.js` (105 lines) — subject/html/text exports, expects `{firstName, petNames, serviceLabel, dateStr, slotLabel, note, photoUrl, portalUrl}`, includes an optional photo and a "View in your portal" button. Registered in `functions/lib/email.js`. Idempotency key is per-visit (`visit-completed:{overnightId}:{visit.id}`), so completing multiple visits on one reservation sends multiple, un-deduped emails by design.

## 1.7 Every Cloud Function that touches money or state

All in `functions/index.js`. Secrets come from Firebase Secret Manager via `defineSecret`, never plain env vars (§1.12).

### Money-touching

| Function | Trigger | Schedule/path | Admin-gated | What it does | Citation |
|---|---|---|---|---|---|
| `createAuthenticatedSetupIntent` | onCall | — | No | Starts card-on-file capture for the caller | [L300](../functions/index.js#L300) |
| `confirmCardOnFile` | onCall | — | No | Finalizes SetupIntent, attaches card, triggers `finalizeSubmissionIfReady` | [L350](../functions/index.js#L350) |
| `getCardOnFile` / `removeCardOnFile` | onCall | — | No | Read/detach caller's own saved card | [L462](../functions/index.js#L462) / [L525](../functions/index.js#L525) |
| `declineMembershipRequest` / `declineServiceRequest` | onCall | — | Yes | Deletes the associated Stripe customer + any orphaned Auth user/member doc | [L678](../functions/index.js#L678) / [L703](../functions/index.js#L703) |
| `chargeSavedCard` | onCall | — | Yes | One-off charge of a saved card, applies referral/F&F discount guards | [L988](../functions/index.js#L988) |
| `chargeScheduledReservations` | onSchedule | every 15 min | — | Charges overnight/check-in reservations 24h after admin-confirmed dates | [L1076](../functions/index.js#L1076) |
| `createMembershipSubscription` | onCall | — | Yes | Thin wrapper for `runCreateMembershipSubscription` (legacy admin `saveMember()` path) | [L1301](../functions/index.js#L1301) |
| `dismissBillingReview` | onCall | — | Yes | Clears `needsReview`/`needsReviewReason` | [L1322](../functions/index.js#L1322) |
| `setFriendsFamilyDiscountActive` | onCall | — | Yes | Toggles an already-granted F&F discount on/off | [L1371](../functions/index.js#L1371) |
| `generateInitialWalks` | onCall | — | Yes | Wrapper for `runGenerateInitialWalks` | [L1460](../functions/index.js#L1460) |
| `updateWalkSchedule` | onCall | — | No | Member schedule change (§1.5) | [L1498](../functions/index.js#L1498) |
| `chargeCurrentMonthWalks` | onCall | — | Yes | One-off PaymentIntent for a member's first partial billed month. **No UI calls this — see [§1.15](#115-built-but-unreachable)** | [L2147](../functions/index.js#L2147) |
| `syncMonthlyWalkQuantities` | onSchedule | `5 0 1 * *` America/New_York | — | Pushes each active member's walk-day count to Stripe subscription-item quantity. Filters `status=='active'` — a paused member's quantity is frozen, not zeroed | [L2161](../functions/index.js#L2161) |
| `generateMonthlyWalks` | onSchedule | `5 0 1 * *` America/New_York | — | Generates next month's walks for active, subscribed members | [L2212](../functions/index.js#L2212) |
| `backfillNextMonthWalks` | onCall | — | Yes | Manual backfill of the above — reachable via `dev/backfill-next-month-walks.html` | [L2263](../functions/index.js#L2263) |
| `resumePausedMemberships` | onSchedule | `0 0 * * *` America/New_York | — | Flips paused members back to active once `pauseEndDate` passes, regenerates walks, emails admin. Makes zero Stripe calls | [L2326](../functions/index.js#L2326) |
| `submitVacationHold` | onCall | — | No | Member self-service pause: deletes future walks in-window, suggests a refund, emails admin. Never touches Stripe | [L2416](../functions/index.js#L2416) |
| `issueRefund` | onCall | — | Yes | Refunds part of an already-paid invoice, matched by billing period | [L2602](../functions/index.js#L2602) |
| `stripeWebhook` | onRequest | Stripe delivery | — | See breakdown below | [L3227](../functions/index.js#L3227) |
| `markDatesConfirmed` | onCall | — | Yes | Confirms dates on a service/overnight reservation, may trigger `finalizeSubmissionIfReady` | [L4840](../functions/index.js#L4840) |
| `generateWalkerPayout` / `markPaid` | onCall | — | Yes | Claims completed jobs into a payout record / flips it to paid | [L5806](../functions/index.js#L5806) / [L5845](../functions/index.js#L5845) |
| `getMemberCreditBalance` | onCall | — | No | Reads pending referral credit + live Stripe balance | [L6627](../functions/index.js#L6627) |
| `generateFriendsFamilyCode` | onCall | — | Yes | Creates a capped-redemption 40%-off F&F code | [L6529](../functions/index.js#L6529) |

**`stripeWebhook`** ([L3227](../functions/index.js#L3227)) — signature-verified, idempotent via a `stripe_webhook_events/{eventId}` create-guard. Listens for **exactly three** event types (stable — `git log -p` shows no additions/removals since introduced):
- **`invoice.payment_failed`** (L3258) → sets `billingStatus: 'past_due'`, `needsReview: true`, `needsReviewReason: 'renewal_payment_failed'` → fires `onBillingNeedsReview`'s admin email. **This `needsReview` write is currently uncommitted — see [§1.13](#113-uncommitted-working-tree-changes-important).** Does not stop walk generation.
- **`customer.subscription.deleted`** (L3273) → sets `hasActiveSubscription: false`, `billingStatus: 'canceled'`. Does **not** touch the `walks` collection — already-generated future walks stay on the walker's schedule; only next month's *new* generation is blocked (both monthly crons gate on `hasActiveSubscription`).
- **`invoice.paid`** (L3284) → `runFirstPaymentReferralCredit` — idempotent, no-op if no referral code, caps credit at 50% of the invoice amount, flags `needsReview` instead of crediting if the eligibility check comes back `'flagged'`. Never touches `walks`.

Any other event type is ignored by design (comment: "the Stripe Dashboard endpoint is only configured to send these three"). Every outcome except a signature-verification failure returns HTTP 200, so Stripe never retries a genuine no-op.

### State-touching (non-money) triggers worth knowing

| Function | Trigger | Path | What it does | Citation |
|---|---|---|---|---|
| `onWalkCompleted` | onDocumentUpdated | `walks/{id}` | Stamps payout, sends Care History SMS | [L5283](../functions/index.js#L5283) |
| `onOvernightCompleted` | onDocumentUpdated | `overnights/{id}` | Stamps payout for the whole reservation | [L5378](../functions/index.js#L5378) |
| `onOvernightVisitCompleted` | onDocumentUpdated | `overnights/{id}` | Per-visit SMS + email on completion (§1.6) | [L5462](../functions/index.js#L5462) |
| `onBillingNeedsReview` | onDocumentUpdated | `members/{id}/private/billing` | Emails admin on `needsReview` false→true | [L5578](../functions/index.js#L5578) |
| `onNewSubmission` | onDocumentCreated | `submissions/{id}` | New-submission email fan-out (§1.5) | [L6056](../functions/index.js#L6056) |
| `gmailSyncPoll` | onSchedule | every 5 min | Polls Gmail for member replies; no-ops silently if not connected | [L5061](../functions/index.js#L5061) |
| `twilioInboundWebhook` | onRequest | Twilio delivery | Inbound SMS/MMS logging | [L5234](../functions/index.js#L5234) |

Full 32-function `onCall` export list, admin-gating, and 4 more discount/referral-code functions (`generateReferralCode`, `generateEmailCaptureCode`, `getOrCreateMemberReferralCode`, `validateReferralCode`) not repeated above were all confirmed reachable from client code — see [§1.15](#115-built-but-unreachable) for the one confirmed exception.

## 1.8 Every portal/admin/walker/dev page that exists on disk

**Member portal** (`portal-*.html` at repo root):

| File | What it does |
|---|---|
| `portal-login.html` | Auth entry point |
| `portal-dashboard.html` | Home view: schedule summary, tier card, upcoming/completed walks |
| `portal-account.html` | Profile fields, walk-schedule editor (`updateWalkSchedule`), password change, card-management link |
| `portal-pet-profile.html` | Dog roster, medical/behavioral notes |
| `portal-walk-history.html` | **"Care History"** — merged, sorted timeline of completed walks + completed overnight/check-in visits, with deep-link highlighting (§1.6) |
| `portal-extras.html` | Pure navigation hub ("Additional Care") — no direct Firestore reads |
| `portal-request-extras.html` | Member-initiated overnight/check-in requests |
| `portal-extend-walk.html` | Member-initiated walk-extension requests |
| `portal-reschedule.html` | Member-initiated reschedule requests |
| `portal-pause-membership.html` | Calls `submitVacationHold` directly — self-service, no admin approval gate |
| `portal-referrals.html` | "Refer a Friend" tab — own code + redemption history |
| `portal-password-reset.html` | Handles Firebase Auth reset/welcome links, hands off to `password-reset-complete.html` |
| `password-reset-complete.html` (repo root) | Post-reset confirmation interstitial; forwards a validated same-origin `continueUrl` |

**There is still no member-facing "messages"/inbox page** — confirmed absent by content search, not just filename. Messaging (`conversations` collection, Gmail + Twilio) is admin-only, inside `admin/dashboard.html`.

**Admin** (`admin/`): `dashboard.html` (the whole admin SPA — Overview, Walk Calendar, Walkers, Payouts, Members, Meet & Greet Availability, Requests, Referral Codes, Messages tabs), `data-review.html` (raw doc-count/inspection tool), `index.html` (admin login), `reset-password.html`.

**Walker portal** (`walker/`): `dashboard.html` (walk list + **new** "Today's Visits" per-visit completion UI alongside the existing whole-reservation completion), `index.html` (login), `reset-password.html`.

**Dev tools** (`dev/`) — not public, not linked from the live site: `backfill-next-month-walks.html` (admin ops tool with dry-run + confirm-gated live run, calls `backfillNextMonthWalks`), `dev-coverage-map.html` (explicitly labeled "not a production page"), `seed-demo.html` (seeds/deletes `demo:true` test data).

**Public**: `index.html`, `membership-request.html`, `service-request.html`, `careers.html`, `contact.html`, `faq.html`, `walker-screening.html`, `welcomehome.html`.

## 1.9 Firestore collections and document shapes

| Collection | Doc ID pattern | Representative shape / citation |
|---|---|---|
| `members` | Auth UID | `name, email, phone, tier ('Member'\|'Travel'), status, address, accessNotes, zone, dogs[], defaultWalkDays[], defaultTimeSlot, assignedWalkerId, walksThisMonth, hasActiveSubscription, membershipStartDate, attribution, createdAt` — [functions/index.js:3817-3851](../functions/index.js#L3817) |
| `members/{id}/private/billing` | fixed `billing` | `stripeCustomerId, stripeSubscriptionId, stripeSubscriptionItemId, billingStatus, needsReview, needsReviewReason, referredByCode, referralSubmissionId, pendingReferralCredit, travelDiscountPercent, travelDiscountActive, cardOnFile` — [functions/index.js:1262-1279](../functions/index.js#L1262) |
| `walks` | `{memberId}_{startStr}` | `memberId, date, timeSlot, walkerId, notes, status, createdAt`, plus later `extended, extendedStatus, payout, completedAt, photoUrl` — created [functions/index.js:4191-4202](../functions/index.js#L4191) |
| `overnights` | auto-id | `memberId, memberName, dogName, startDate, endDate, serviceType, notes, status, confirmedAt, walkerId, extraPet, medication, visitSchedule (check-in only), visits[], confirmedTotalCents, chargePending, chargeScheduledFor` — [functions/index.js:4221-4250](../functions/index.js#L4221) |
| `overnights/{id}.visits[]` (array field, not a subcollection) | element `id` = Firestore auto-ID | `{ id, date, slot, status, completedAt, note, photoUrl, walkerId, walkerName }` — minted [functions/index.js:4056-4139](../functions/index.js#L4056), completed via whole-array rewrite [walker/dashboard.html:729-738](../walker/dashboard.html#L729) |
| `walkers` | two docs per walker: friendly `walkerId` and Auth `uid`, identical data | `name, email, phone, uid, walkerId, zones, status, weeklyTarget, availability{mon..sun}, availableForOvernights` — updated [admin/dashboard.html:5501-5503](../admin/dashboard.html#L5501) |
| `submissions` | auto-id | `type` discriminates shape — see §1.10 for the full type list and validation status |
| `admins` | Auth UID | Presence-only; no write site anywhere in app code — provisioned out-of-band (Firebase console) |
| `conversations` | `memberId` or `unmatched_<...>` | `memberId, memberName, memberEmail, memberPhone, unlinked, lastMessageAt, lastMessagePreview, lastMessageChannel, unreadByAdmin` — [functions/index.js:3445-3464](../functions/index.js#L3445) |
| `conversations/{id}/messages` | auto-id | `channel, direction, body, subject, mediaUrl, sentBy, status, externalId, automated, createdAt` — [functions/index.js:3430-3443](../functions/index.js#L3430) |
| `stripe_webhook_events` | Stripe event id | `{ type, receivedAt }` idempotency marker — [functions/index.js:3249-3251](../functions/index.js#L3249) |
| `walkExtensionCredits` | `{memberId}_{date}_{keyPart}` | `memberId, date, amount, chargeId, reason, status, createdAt` — [functions/index.js:1810-1824](../functions/index.js#L1810) |
| `walkerPayments` | `{walkerId}_{periodStartISO}` | `walkerId, walkerName, periodStart, periodEnd, status, items, counts, total, generatedAt, paidAt, quickbooksReference` — write-only via Admin SDK — [functions/index.js:5783-5797](../functions/index.js#L5783) |
| `referralCodes` | code string | `referrerId (null for partner codes), source, amountCents, expiresAt, maxRedemptions, creditIssued` — [functions/index.js:6207-6212](../functions/index.js#L6207) |
| `referralCodes/{code}/redemptions` | auto-id (often the submission id) | One doc per redemption — [functions/index.js:6079](../functions/index.js#L6079) |
| `meet_greet_availability` | date string | `{ bookings: [...] }` via `arrayUnion` — [functions/index.js:6126-6129](../functions/index.js#L6126) |
| `system` | fixed `gmailAuth` | Gmail OAuth refresh-token storage — [functions/index.js:5015-5018](../functions/index.js#L5015) |
| `emailLog` | idempotency key or auto-id | Every `sendEmail` attempt, used for dedupe |

No composite indexes are defined (`firestore.indexes.json`: `"indexes": []`); one collection-group field override exists on `private.stripeCustomerId`, supporting the cross-member Stripe-customer lookup used by the webhook handler ([functions/index.js:2737](../functions/index.js#L2737)).

## 1.10 `firestore.rules` — honest summary

Full file read (620 lines). Helpers: `isAdmin()`, `isWalker()`, `myWalkerId()` — [firestore.rules:4-15](../firestore.rules#L4).

- **`admins/{uid}`**: read only your own doc if it exists; write always `false` (closes a prior self-grant-admin hole).
- **`members/{id}`**: admin full access. **`allow read: if isWalker();` is unscoped** — [firestore.rules:32](../firestore.rules#L32) — any signed-in walker can read every member's full profile (address, access notes, vet, emergency contacts), not just members assigned to them. Member self-write is a narrow allowlist (name/phone/address/dogs/access fields) — tier, billing, schedule, and assignment are admin/Cloud-Function-only.
- **`members/{id}/private/{doc}`**: read admin or self; write always `false`. The rule's own wildcard (`{doc}`, not `{doc=='billing'}`) means a member could read *any* doc dropped under `/private`, not just `billing` — currently moot since only `billing` exists there, but worth knowing before adding a second private subdoc.
- **`walks`** / **`overnights`**: admin full; walker scoped to `walkerId == myWalkerId()`; member scoped to `memberId == uid`. On `walks`, member self-update is narrowly pinned (`hasOnly(['extended','extendedStatus','duration'])`). **On `overnights`, the assigned walker's update is unrestricted (no `hasOnly()`)** — this is *why* `walker/dashboard.html`'s per-visit completion can freely rewrite the whole `visits` array; it also means a walker's write access there isn't field-limited the way `walks` is.
- **`submissions`**: admin full. Create is split in two:
  - **Authenticated, non-anonymous**: any signed-in user may create a submission of any type *other than* `service_request`/`overnight_request` with **zero field validation from rules** — types named in-comment include `reschedule, dog_update, pause_membership, walker_incident, walker_schedule_request, vacation_hold_refund` — [firestore.rules:137-139, 515-517](../firestore.rules#L515). `service_request`/`overnight_request` while authenticated go through `validMemberServiceRequest()` (strict `hasOnly()`, date-order and visit-count checks) — [firestore.rules:484-513](../firestore.rules#L484).
  - **Anonymous**: exactly six public types, each with its own `hasOnly()` validator — `contact`, `membership_request`, `service_request`, `application`, `walker_screening`, `waitlist` — [firestore.rules:218-443](../firestore.rules#L218).
- **`meet_greet_availability`**: read `true` for anyone, unauthenticated included (intentional — public double-booking guard); write admin-only.
- **`conversations`** (+ `messages` subcollection): admin-only, full stop — no member or walker access at either level.
- **`walkerPayments`**: read admin or the owning walker; write always `false`.
- **`referralCodes`** / **`redemptions`**: no client create rule at all (Cloud Functions only); reads scoped to admin or the referrer. A separate admin-only collection-group rule on `redemptions` exists specifically to support the admin dashboard's cross-code query.

**Caveat that matters more than any specific rule:** there is **no CI/CD** in this repo (no `.github` directory) — rules deploy manually via `firebase deploy --only firestore:rules`. This document describes what's committed to the working tree, not provably what's enforced in production. Check the Rules tab's last-published timestamp in the Firebase Console before trusting any specific rule against real traffic.

## 1.11 `storage.rules` — honest summary

Full file read (84 lines). `isAdmin()` here is a **hardcoded single UID** (`'SZNWwqHGPDYp8TOixmg1EOUZaBD2'`), not a Firestore lookup — cross-service `firestore.exists(...)` calls don't evaluate correctly inside Storage rules, per the file's own comment explaining a prior broken version.

- **`walk-photos/{walkId}/{fileName}`**: read by any signed-in user; write by any signed-in user, bounded by an 8MB size cap and `image/.*` content-type. **Unscoped by design** — not limited to the assigned walker or member, because `memberId` isn't part of the storage path; the file says a proper fix needs custom auth claims.
- **`overnight-photos/{overnightId}/{fileName}`** (new — added in commit `e25a608`): identical shape and identical unscoped-by-design caveat as `walk-photos`.
- **`resumes/{submissionId}/{fileName}`**: create is fully unauthenticated (job applicants aren't signed in), capped at 10MB, PDF/DOC/DOCX only. Read/update/delete admin-only; no `list` permission, so applicants can't enumerate resumes including their own.
- Catch-all `{allPaths=**}`: deny by default.

## 1.12 Deployment

- **Frontend** (all public/portal/admin/walker HTML): static, hosted on **Vercel**. `vercel.json` sets `buildCommand: ""` (no build step) and adds security headers plus `noindex` on `/portal-*`, `/admin*`, `/walker*`, `/dev/*` routes. Deploy mechanism not defined in-repo — manual `vercel` CLI or Vercel's own git-push-triggered deploy.
- **Backend**: Firebase project `port-city-leash-club-827ab` (`.firebaserc`). `firebase.json` configures Firestore rules/indexes, Storage rules, and one Functions codebase (`functions/`, **Node 20** runtime, pinned in `functions/package.json` `engines`). Predeploy hook copies `pricing.js`, `walker-pricing.js`, `time-slots.js`, `visit-slots.js` into `functions/` (§1.2) — `visit-slots.js` was added to this exact copy list in the same commit that introduced the file (`f830cc6`), so this isn't a gap.
- **Secrets** (Firebase Secret Manager via `defineSecret`, never plain env vars, no `.env*` committed anywhere): `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `RESEND_API_KEY` (declared separately in `functions/lib/email.js`), `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN`/`TWILIO_PHONE_NUMBER`, `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
- **No CI/CD anywhere** — confirmed, no `.github` directory, no `.yml`/`.yaml` files outside `node_modules`. Every deploy (`firebase deploy --only functions:<names>`, `firebase deploy --only firestore:rules`) is run by hand.
- **Node 20 runtime**: no in-repo comment documents an end-of-support date (the 2026-10-30 date noted in this project's operating memory comes from Firebase's own deploy-time console warning, not from anything in this codebase) — worth reconfirming against the Firebase Console before treating it as still accurate.

## 1.13 Deployed-but-uncommitted work (standing check — none currently outstanding)

This section exists to catch a specific failure mode: code that's live in production but exists in no git commit, so a clean checkout would silently revert it. Re-run `git status` (and, if it's not clean, `git diff`) every time this document is regenerated, and update this section's status accordingly — even when there's nothing to report, keep the section rather than deleting it, so the check doesn't quietly stop happening.

**Current status (2026-08-30): none outstanding.** The below was real at generation time and has since been resolved.

**History.** At the moment this document was originally generated (2026-08-29), `git status` showed real, uncommitted work on top of `285d576`:

```
 M functions/index.js
 M functions/lib/email.js
 M functions/templates/billing-needs-review.js
?? functions/templates/vacation-hold-resumed.js
?? functions/templates/vacation-hold.js
```

That was not noise — it was a functioning feature that had never been committed to git:
- Two new email templates, `vacation-hold` and `vacation-hold-resumed`, registered in `functions/lib/email.js`.
- `submitVacationHold` now emails admin when a member self-pauses (previously only left an easy-to-miss unread `submissions` row) — diff adds a `sendEmail({template:'vacation-hold', ...})` call.
- `resumePausedMemberships` now emails admin when a hold ends, including whether it ended mid-month (a new `easternDateParts()` helper computes this correctly on the business's own America/New_York calendar, not raw UTC) — flagging that `chargeCurrentMonthWalks` may need a manual follow-up run for the tail of that month.
- The `invoice.payment_failed` Stripe webhook branch now also sets `needsReview: true, needsReviewReason: 'renewal_payment_failed'` (previously set `billingStatus` alone, invisible to admin outside manually opening that member's row) — matching a new `REASON_INFO` entry added to `billing-needs-review.js`.

**Resolution (2026-08-30).** All five files were committed as `bb6fb02` ("feat: notify admin on vacation hold start/end, flag renewal payment failures for review"), which is pushed to `origin/main` — confirmed via `git status` (clean), `git rev-parse main`/`origin/main` (identical), and `git show bb6fb02 --stat` (matches the file list above exactly). The four affected Cloud Functions (`stripeWebhook`, `submitVacationHold`, `resumePausedMemberships`, `onBillingNeedsReview`) were redeployed the same day to guarantee production matches this commit, since the CLI alone (no `gcloud` on this machine, `firebase functions:list` exposes no deploy timestamp or comparable source hash) couldn't independently prove the previously-live version already matched it.

Every citation to these specific behaviors elsewhere in this document (§1.7's `stripeWebhook`/`resumePausedMemberships`/`submitVacationHold` rows) can now be trusted as both committed and deployed as of 2026-08-30.

## 1.14 Built but inert

Code that exists and is wired but cannot currently run, by design, pending external configuration:

- **Twilio (SMS)**: fully wired (`sendMemberMessage`'s SMS branch, automated completion texts, inbound webhook), gated by `twilioConfigured()` checking the Account SID starts with `'AC'` — [functions/index.js:3471-3474](../functions/index.js#L3471). Until real credentials are set via `firebase functions:secrets:set TWILIO_*`, manual sends throw a clear `failed-precondition` error and automated completion texts log a `status: 'pending_credentials'` conversation entry instead of sending — [functions/index.js:5216](../functions/index.js#L5216), [5341](../functions/index.js#L5341), [5499-5503](../functions/index.js#L5499). This is the previously-known case (see prior operating memory: real number/A2P 10DLC registration still pending as of mid-2026).
  - **Comments throughout `functions/index.js` (lines 3332, 3352, 4999, 5232) reference a `TODO.md` setup checklist that no longer exists** — confirmed deleted in commit `95bc9d0` ("Delete TODO.md"). These are now dangling references; if you're looking for the setup checklist those comments point to, it isn't there.
- **Gmail sync (`gmailSyncPoll`)**: also inert without setup, but degrades silently rather than erroring — `getGmailClient()` returns `null` if `system/gmailAuth` has no `refreshToken`, and the poller just no-ops every 5 minutes until an admin completes the OAuth consent flow (`gmailAuthUrl` → Google consent → `gmailAuthCallback` writes the token) — [functions/index.js:3497-3504](../functions/index.js#L3497), [5061-5063](../functions/index.js#L5061). Requires both real `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` secrets and a one-time admin click.

## 1.15 Built but unreachable

`onCall` functions with zero client call sites anywhere in the repo (`admin/`, `walker/`, portal root files, `dev/`, public pages):

- **`chargeCurrentMonthWalks`** ([functions/index.js:2147](../functions/index.js#L2147)) — the only such function found. Admin-gated, takes `memberId`. Referenced only in code comments and — as of the uncommitted `vacation-hold-resumed` email (§1.13) — in a human instruction inside that email template's own copy: *"Run `chargeCurrentMonthWalks` for this member to catch up the rest of this month's billing."* No UI button exists anywhere. **How to invoke it today**: the Firebase Console's Cloud Functions "Test function" tab (supply `{"memberId": "..."}` as the callable payload — support for `onCall` semantics there is not guaranteed), or writing a one-off script that calls the callable HTTPS endpoint with a real admin ID token. There is no existing in-repo tool for this.
- `backfillNextMonthWalks` was previously suspected unreachable too — **it is not**: `dev/backfill-next-month-walks.html` calls it directly with both a dry-run and a real-run mode.

---

# PART 2 — HUMAN-MAINTAINED (NOT verified against code, owned by Alison)

**⚠️ The old Source of Truth document's business content still has not come through in any session that produced this file — including this one.** You referenced pricing, walker payout, and portal-page errors from "the old doc" when requesting this rewrite, but the document's actual text was never pasted into this conversation. Per instruction, nothing here is invented or reconstructed from memory — that would misrepresent unverified content as carried-over fact.

**Action needed:** paste the previous document's business content (positioning, service area, operational policy, key management, pricing philosophy/rationale, anything else not derivable from code) and it will be preserved verbatim under this heading on the next regeneration, with no rewriting. Until then, this document has no record of that content.

---

# Contradictions found (prior Source of Truth `af87c3c` vs. this document)

The only actual prior document available to diff against is this repo's own `docs/SOURCE_OF_TRUTH.md` as it stood at commit `af87c3c` (2026-08-25) — itself generated without the real "old doc," per its own placeholder note. Comparing that snapshot to the current working tree:

| `af87c3c` doc said | Current code says | Where |
|---|---|---|
| Portal page table: `portal-walk-history.html` — "Queries `walks` where `memberId == uid`" | Now a merged "Care History" page combining completed walks *and* completed overnight/check-in visits into one sorted timeline, with deep-link support | [§1.6](#16-the-visit-model--generation-slots-completion-photos-notifications), [§1.8](#18-every-portaladminwalkerdev-page-that-exists-on-disk) |
| Function table (§1.6) had no entry for any visit-level completion trigger | New `onOvernightVisitCompleted` trigger exists, sends per-visit SMS + email | [§1.6](#16-the-visit-model--generation-slots-completion-photos-notifications), [§1.7](#17-every-cloud-function-that-touches-money-or-state) |
| No mention of `visit-slots.js`, a visit-schedule/visit-grid pricing path, or per-visit photo storage at all | Entire visit-tracking system exists: `visit-slots.js`, `overnights.visits[]`, `overnight-photos` Storage path, `computeDropInVisitTotal()` | [§1.4](#14-the-visit-grid--how-check-ins-overnights-extra-pet-and-medication-actually-price), [§1.6](#16-the-visit-model--generation-slots-completion-photos-notifications), [§1.11](#111-storagerules--honest-summary) |
| §1.9 `submissions` rules summary described only the anonymous types as validated | The 7 *authenticated* submission types other than `service_request`/`overnight_request` get **zero field validation** from rules — a materially different (weaker) characterization than "admin full access; authenticated members can create/read their own" implied | [§1.10](#110-firestorerules--honest-summary) |
| Described the `invoice.payment_failed` webhook fix and the `vacation-hold-resumed` admin email as already shipped ("fixed 2026-08-27") | Both exist only as **uncommitted** working-tree changes right now — never committed to git, so their claimed "fixed" status was true of some working tree at some point but is not reflected in git history at any commit, including the one that doc cited | [§1.13](#113-uncommitted-working-tree-changes-important) |
| §1.9/§1.11 storage rules not covered at all | Full `storage.rules` audit added, including the hardcoded single-UID `isAdmin()` and unscoped read/write on both photo paths | [§1.11](#111-storagerules--honest-summary) |
| No mention of dangling `TODO.md` references | `functions/index.js` has four comments pointing at a `TODO.md` that was deleted in commit `95bc9d0` | [§1.14](#114-built-but-inert) |

The `af87c3c` doc's own carried-forward table of contradictions against the *true* original old doc ($26/25/22 tiered pricing, $29 single walk, $20 extra pet, $45 walker overnight payout, $10 walker extra-pet payout, a phantom "$8 extension" payout line, a phantom "messages" portal page, an omitted `portal-referrals.html`) is **still unverified against that original text**, since it was never supplied — see Part 2.

---

# Where customer-facing copy and code may need to converge

A quick pass over `faq.html` and `index.html` against the code above:

- FAQ/marketing copy already promises "photos taken during the walk" (standard walks) and "a photo update" (drop-in visits) — this is now genuinely delivered by the walk/visit-completion photo-upload flow (§1.6), where previously it may not have been. No action needed, but worth knowing the promise and the feature are now aligned.
- No customer-facing copy anywhere promises SMS/text updates on walk or visit completion — the automated completion texts (§1.6) are a feature the code delivers that isn't advertised on the site. Consider whether that's worth mentioning in the FAQ, since it's a real differentiator that currently only members who've experienced it would know about.
- No customer-facing copy mentions a holiday surcharge (the walker-facing rate card apparently does, per `walker-pricing.js`'s own comment, though that rate card itself isn't in this repo) — this is walker-facing, not customer-facing, so it isn't a site-copy risk, but it is worth confirming the walker rate card (wherever it actually lives) doesn't still promise a surcharge nobody gets paid.

This was a shallow grep-based pass, not exhaustive — if the FAQ or marketing copy makes other specific operational claims (response times, service radius, walker vetting steps), those weren't checked against code because they're not really code-checkable claims.

---

# How to re-verify this document

Written for the reader in three months, not for the model that wrote it.

**1. Confirm what's changed since this snapshot:**
```bash
git status --short
git log --oneline 285d5769aa70a5ab923493926266e9fbbfbd9491..HEAD -- pricing.js walker-pricing.js visit-slots.js time-slots.js functions/index.js firestore.rules storage.rules admin/dashboard.html walker/dashboard.html
```
If `git status` is clean and the log is empty, Part 1 is still current. **If `git status` is not clean, re-read §1.13 first** — this document may already be describing uncommitted work, and a `git diff` review is the only way to know whether that work is still there, has been committed, or has been reverted.

**2. Pricing (§1.1–1.4):**
```bash
grep -n "STANDARD_WALK_PRICE\|WALK_EXTENSION_PRICE\|MEMBER_WALK_RATE\|SERVICE_PRICES = {\|EXTRA_PET_FEE\|MEDICATION_FEE =" pricing.js
grep -n "WALKER_RATES = {\|standard:\|extended:\|checkin:\|overnight:\|WALKER_EXTRA_PET_FEE\|WALKER_MEDICATION_FEE" walker-pricing.js
grep -n "VISIT_SLOTS =\|VISIT_SLOT_LABELS\|VISIT_SLOT_RANGES\|defaultSlotsForCount" visit-slots.js
grep -n "MEMBER_PRICE_ID =\|^function resolveMemberPriceId" functions/index.js
diff pricing.js functions/pricing.js; diff walker-pricing.js functions/walker-pricing.js; diff visit-slots.js functions/visit-slots.js   # should all be empty
```

**3. Every Cloud Function + trigger type (§1.7):**
```bash
grep -n "^exports\.[a-zA-Z]* = on" functions/index.js
grep -n "schedule:" functions/index.js
grep -n "document:" functions/index.js
grep -n "event.type ===" functions/index.js   # stripeWebhook's handled event list
```

**4. Signup flow (§1.5):**
```bash
grep -n "^async function runCreateMembershipSubscription\|^async function finalizeSubmissionIfReady\|^exports.completeMeetGreetAndCreateAccount\|^exports.updateWalkSchedule" functions/index.js
```
Read each in full — this flow is exactly the kind of thing that quietly grows a fourth stage without anyone updating a doc.

**5. Visit model (§1.6):**
```bash
grep -n "generateOvernightVisits\|onOvernightVisitCompleted" functions/index.js
grep -n "completeVisit\|renderTodaysVisits" walker/dashboard.html
grep -n "visitRecords\|walkRecords\|allRecords" portal-walk-history.html
```

**6. Portal pages (§1.8):**
```bash
ls portal-*.html admin/*.html walker/*.html dev/*.html
find . -iname "*message*" -not -path "*/node_modules/*" -maxdepth 1   # should keep returning nothing
```

**7. Firestore collections (§1.9):**
```bash
grep -ohE "collection\('[a-zA-Z_]+'\)" functions/index.js | sort -u
```
Cross-check any new name against `firestore.rules` for a matching `match` block.

**8. `firestore.rules` / `storage.rules` (§1.10–1.11):**
```bash
grep -n "match /members/{id}" -A 5 firestore.rules       # re-check isWalker() is still unscoped
grep -n "isAdmin()" -A 3 storage.rules                    # re-check the hardcoded UID is still there / still correct
```
Then check the Rules tab's last-published timestamp in the Firebase Console — there's still no CI here, so the repo can never prove what's actually live.

**9. Deployment (§1.12):**
```bash
cat firebase.json .firebaserc vercel.json
find . -iname "*.yml" -o -iname "*.yaml" | grep -v node_modules   # confirm still no CI/CD
```

**10. Built-but-inert / built-but-unreachable (§1.14–1.15):**
```bash
grep -n "twilioConfigured\|pending_credentials" functions/index.js
grep -rn "chargeCurrentMonthWalks" --include="*.html" .   # should still return nothing if still unreachable
```

**11. Regenerating this whole document:** hand a fresh Claude session this exact file plus the instruction "re-run every command in the 'How to re-verify' section, compare to what's written above, and tell me what changed — and check `git status` first, since the last version of this document was generated with real uncommitted work in the tree." That's a much cheaper task than writing this document from scratch again, and cheaper still than the two-session gap it took to get the actual old business-content doc into Part 2 — paste that text in before the next regeneration if at all possible.

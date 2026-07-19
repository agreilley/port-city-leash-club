# Port City Leash Club — Database Schema
## Firebase Firestore Design | Reflects live production system as of July 2026

---

## OVERVIEW

This document describes the **actual, current** Firestore schema backing Port City Leash Club — a live, running system, not a planning spec. It covers every collection Cloud Functions and the member/walker/admin portals actually read and write, the real security rules, and the real data flows (walk generation, rescheduling, extension, overnight bookings, vacation holds, billing).

This is a from-scratch rewrite of a prior version of this document that was drafted before implementation and never updated — nearly every collection, field name, ID scheme, and rule in the old version diverged from what was actually built. If you're relying on this doc to write a query, check a field name, or reason about security rules, this version should be trustworthy; the old one was not.

**Key real-world facts that shape this design:**
- There is no separate `pets`, `billing`, `walk_history`, `membership_changes`, `membership_holds`, or `feedback` collection. Pet data lives on the member doc; billing is Stripe-subscription-based; history is just the `walks` collection; tier/pause changes flow through `submissions`; there's no satisfaction-survey feature.
- Walkers are stored at **two different document IDs** simultaneously (see `walkers` below) — this is the single most surprising thing in the schema and worth understanding before writing any walker-related code.
- Almost nothing is denormalized. The dashboard does live client-side lookups (`allMembers.find(...)`, `allWalkers.find(...)`) rather than storing copies of names on `walks`/`overnights` docs.

---

## COLLECTIONS & DOCUMENTS

### 1. `admins`

Existence of a document at `admins/{uid}` **is** the admin authorization check — the security rules and `assertIsAdmin()` (Cloud Functions) both just check `exists(/admins/{request.auth.uid})`. There's no roles/permissions system beyond this binary.

**Document ID:** the admin's Firebase Auth UID

**Fields:**
```
{
  name: string   // shown in the admin sidebar ("Admin" if missing)
}
```

**Created:** manually in the Firebase Console (no in-app "add admin" flow exists).

---

### 2. `members`

**Document ID:** the member's Firebase Auth UID (not an auto-generated ID — `setDoc(doc(db, 'members', uid), ...)`, so the doc ID is always something the member's own Auth session can be checked against directly).

**Fields:**
```
{
  uid: string                    // same value as the doc ID, kept as a field too
  name: string
  email: string
  emailNormalized: string        // lowercased, for case-insensitive lookups (findMemberByEmail)
  phone: string
  phoneDigits: string            // digits only, leading US "1" stripped
  address: string
  accessNotes: string            // free text: key location, gate code, etc. (single field, not structured)
  zone: string                   // neighborhood, used for walker routing/assignment
  tier: string                   // enum: "Essential" | "Standard" | "Daily" | "Travel"
  status: string                 // enum: "active" | "paused"
  assignedWalkerId: string       // references walkers.walkerId (the human-readable ID, not a walker doc's Auth UID)
  walksThisMonth: number

  // Default walking schedule
  defaultWalkDays: array<string> // e.g. ["Monday", "Wednesday", "Friday"]
  defaultTimeSlot: string        // enum: "morning" | "early-afternoon" | "late-afternoon"

  // Dogs — canonical shape, one member can have multiple
  dogs: array<object> {
    name: string
    breed: string
    age: string
    weight: string
    notes: string
    temperament: string
    walkingPrefs: string
    triggers: string             // free text — safety-relevant, shown prominently to walkers
    medications: string
    allergies: string
  }
  // Legacy flat fields — only present on member docs created before the
  // dogs[] array existed. Never written by new code; read as a fallback
  // (getMemberDogs()-style helpers) wherever dogs[] might be empty.
  dogName: string
  dogBreed: string
  dogAge: string
  dogNotes: string

  // Stripe billing (Travel-tier / one-time-service-only members may lack these)
  stripeCustomerId: string
  stripeSubscriptionId: string
  stripeSubscriptionItemId: string
  billingStatus: string          // e.g. "active"

  // Vacation hold — only present while status === "paused"
  pauseStartDate: timestamp
  pauseEndDate: timestamp

  createdAt: timestamp
}
```

**Notes:**
- `tier: "Travel"` members are pet-sitting-only clients with no recurring walk subscription — `defaultWalkDays`/`defaultTimeSlot` and the Stripe fields may be absent.
- `status: "paused"` is set by the vacation-hold flow (`submitVacationHold` Cloud Function) and cleared by a daily scheduled function (`resumePausedMemberships`) once `pauseEndDate` passes. There is no `"cancelled"` status anywhere in the code — churn/cancellation isn't a built feature yet.
- Security rules block members from writing their own Stripe/billing fields (`stripeCustomerId`, `stripeSubscriptionId`, `stripeSubscriptionItemId`, `billingStatus`, `lastPaymentAmount`, `lastPaymentDate`, `paymentMethodUpdatedAt`) even on an otherwise-permitted self-update — see Security Rules below. (`lastPaymentAmount`/`lastPaymentDate`/`paymentMethodUpdatedAt` are referenced in rules but not currently written by any code path found — likely reserved for a near-future feature.)

---

### 3. `walkers`

**Stored at two document IDs simultaneously**, with identical data written to both on creation (`createWalkerAccount()` in admin/dashboard.html):
1. A human-readable ID: `walker_{firstname}_{lastname}` (lowercase, underscored) — this is the ID used everywhere else as a reference (`walks.walkerId`, `overnights.walkerId`, `members.assignedWalkerId`).
2. The walker's Firebase Auth UID — this copy exists **only** so Firestore security rules can resolve "who is this logged-in walker" via `exists(/walkers/{request.auth.uid})` and look up their friendly walkerId (`myWalkerId()` helper in firestore.rules). The walker portal itself also falls back to querying `where('uid', '==', user.uid)` if the UID-keyed doc lookup misses.

**Fields (identical on both copies):**
```
{
  name: string
  email: string
  phone: string
  uid: string                    // Firebase Auth UID
  walkerId: string                // the human-readable ID (e.g. "walker_marcus_johnson")
  zones: array<string>            // neighborhoods, comma-separated input split into an array
  status: string                  // only "active" is ever set or checked — no deactivation flow exists
  weeklyTarget: number             // target walks/week, informational only (not enforced anywhere)
  availability: object {
    mon: array<string>            // enum values: "morning" | "early-afternoon" | "late-afternoon"
    tue: array<string>
    wed: array<string>
    thu: array<string>
    fri: array<string>
    sat: array<string>
    sun: array<string>
  }
  availableForOvernights: boolean
}
```

**Not real, despite being a natural thing to expect:** certification/background-check tracking, per-walker custom rates (all rates are global constants in `walker-pricing.js`, not stored per walker), a ratings/reviews system, `hireDate`, free-text `notes`.

---

### 4. `walks`

**Document ID:** `{memberId}_{YYYY-MM-DD}` — one walk per member per calendar day. Recurring walks are generated by `generateWalksForMember()` using `.doc(docId).create()` (fails silently/is treated as "already exists" on a collision, which is how duplicate-generation is prevented).

**Fields:**
```
{
  memberId: string
  date: timestamp                 // stored at noon UTC specifically, to avoid the date shifting
                                   // a day back when re-read in US timezones
  timeSlot: string                // enum: "morning" | "early-afternoon" | "late-afternoon"
  walkerId: string                // references walkers.walkerId (human-readable ID), or null if unassigned
  status: string                  // in practice only "scheduled" | "completed" — no "cancelled"/"rescheduled" value is ever set
  notes: string                   // walker's completion notes, written by completeWalk()
  photoUrl: string                // walk photo, set on completion; null if none uploaded
  completedAt: timestamp           // set on completion
  extended: boolean                // true if this walk was extended to 45 minutes
  extendedStatus: string           // enum: "pending" | "confirmed" | null — pending = member requested,
                                   // awaiting admin charge/approval; confirmed = admin approved
  duration: string                 // only ever set to the literal string "45-minute walk" when extended is true
                                   // (not a numeric minutes field, despite what you might expect)
  createdAt: timestamp
  updatedAt: timestamp              // set on walker reassignment or reschedule
}
```

**What does NOT exist here, despite being a reasonable guess:**
- No `walkId` field, no `petId` reference.
- No denormalized `walkerName`/`petName`/`membershipTier` — every screen that shows a walker or member/dog name for a walk does a live `.find()` against an already-loaded `allWalkers`/`allMembers` array, not a stored copy.
- No `originalDate`/`originalTimeSlot` and no `rescheduleHistory` audit trail. Rescheduling just overwrites `date` and `timeSlot` directly on the same document (`approveReschedule()` in admin/dashboard.html) — there is no record of what the walk's date used to be.
- No cancellation fields (`cancelledAt`/`cancellationReason`/`cancelledBy`) and no cancellation flow of any kind.
- No per-walk billing fields (`creditUsed`/`priceApplied`) — see the Billing section below for how charging actually works.

---

### 5. `submissions`

**The core "everything that needs a human decision" collection** — every public form, member request, and walker request lands here as a document with a `type` field, and the admin Requests tab renders/filters/acts on it based on that type. This entire collection was undocumented in the prior version of this doc.

**Document ID:** auto-generated.

**Common fields on every submission:**
```
{
  type: string        // see type list below
  status: string       // "pending" is the initial state for anything requiring a decision;
                        // terminal values vary by type (see below)
  read: boolean         // for the admin inbox's unread indicator
  createdAt: timestamp
}
```

**Status vocabulary is not one shared enum** — different types use different terminal values, all recognized as "resolved" by `isRequestCompleted()`: `confirmed`, `declined`, `resolved`, `handled`, `applied`. `pending` (and, for a couple of Stripe-related flows, `processing`) means still awaiting action.

**Submission types, in the order they were added, with their type-specific fields:**

**`contact`** (public contact form) — `name, email, phone, message`

**`membership_request`** (public signup form, `membership-request.html`) —
```
plan, ownerName, email, phone, address, accessNotes,
dogs: array<{name, breed, age, notes, weight}>,   // see note below re: shape drift
dogName,                                           // legacy: first dog's name, for pre-conversion display
startDate: timestamp,                              // converted from a date-input string at submission
timeWindow, days, meetGreetDateTime,
stripeCustomerId, paymentMethodStatus
```

**`service_request`** (public one-time-service form `service-request.html`, AND the member-portal booking flow `portal-request-extras.html` when the requested service isn't an overnight stay) —
```
service, ownerName, email, phone, address,
dogs: array<{name, species, breed, age, weight, spayed, temperament,
             friendlyWithPeople, takesMedication, notes,
             // dog-only: friendlyWithDogs, pullsOnLeash
             // cat-only: indoorOnly, comfortableHandled
            }>,
startDate: timestamp, endDate: timestamp,
visitsPerDay, extraPet, medication, estimatedTotal, stripeCustomerId, paymentStatus,
memberId, memberName   // present only when submitted from the member portal, not the public form
```
Note: the public form's `dogs[]` shape (species/spayed/friendly-with-people/etc.) is genuinely different from `membership_request`'s simpler shape and from `members.dogs[]`'s canonical shape — three different pet-object shapes exist in this codebase depending on which form produced them, admin's request-detail modal renders each correctly for its own submission type.

**`overnight_request`** (member-portal booking, `portal-request-extras.html`, when service is an overnight stay) — same field shape as `service_request` above, minus the public-form-only fields (no `ownerName`/full pet profile — assumes an existing member and looks their info up by `memberId`).

**`application`** (walker job application, `careers.html`) —
```
name, email, phone, neighborhood, dogExperience, experience,
availability: object { mon: [...], tue: [...], ... },   // same shape as walkers.availability
walksPerWeek, transportation, additional
```

**`dog_update`** — `memberName, previousDogs, newDogs, message`

**`walker_incident`** (walker-reported issue, from walker/dashboard.html) — `walkerName, walkId, memberId, memberName, dogNames, message`

**`walker_schedule_request`** (time off / schedule change, from walker/dashboard.html) — `walkerName, requestType ("time_off" | "schedule_change"), message`

**`reschedule`** (member requests a new date/time for an existing walk) — `memberId, memberName, walkId, newDate: timestamp, newTimeSlot`

**`walk_extension`** (member requests one or more 30→45 min upgrades) — `memberId, memberName, walkIds: array<string>, estimatedTotal, paymentStatus, stripeCustomerId`

**`tier_change`** (member requests a plan change, `portal-membership-upgrade.html`) — `memberId, memberName, currentTier, newTier`. No automated execution — admin manually updates the member's Stripe subscription price and the `members.tier` field, then marks the submission `applied`.

**`pause_membership`** (informational record — the vacation hold itself already took effect via a Cloud Function by the time this is written; status starts at `"applied"`, not `"pending"`, since there's nothing left to approve) — `memberId, memberName, pauseStartDate: timestamp, pauseEndDate: timestamp`

**`vacation_hold_refund`** (a separate, actionable request — created alongside `pause_membership` only when the hold cancels already-paid walks worth refunding) — `memberId, memberName, cancelledWalkCount, cancelledWalkDates, suggestedRefundAmount, stripeCustomerId, stripeSubscriptionId, refundPeriodYear, refundPeriodMonth, pauseStartDate, pauseEndDate`, plus `refundId`/`refundedAmount` once confirmed.

---

### 6. `overnights`

Confirmed (paid, scheduled) overnight stays and check-in visits — created from a `submissions` doc of type `overnight_request` or `service_request` once admin reviews and confirms it (`confirmOvernight()`).

**Document ID:** auto-generated.

**Fields:**
```
{
  memberId: string
  memberName: string               // denormalized at confirm time (one of the few real denormalizations in this schema)
  dogName: string
  startDate: timestamp
  endDate: timestamp
  serviceType: string               // e.g. "overnight" | "checkin"
  notes: string
  status: string                    // "confirmed" -> "completed" once the walker marks it done
  confirmedAt: timestamp
  completedAt: timestamp
  submissionId: string               // reference back to the originating submissions doc
  walkerId: string                   // references walkers.walkerId; empty until assigned
  extraPet: boolean
  medication: boolean
}
```

---

### 7. `conversations` (+ `messages` subcollection)

The unified SMS + email inbox — every text and email in or out of the business's shared inbox gets logged here, whether or not the sender/recipient is a known member. Built this session; not present in any prior version of this document.

**Document ID:** the member's ID if matched, otherwise a deterministic pseudo-ID (`unmatched_{sanitized email}`) for senders who don't match an existing member.

**`conversations/{id}` fields:**
```
{
  memberId: string
  memberName: string | null
  memberEmail: string | null
  memberPhone: string | null
  unlinked: boolean                 // true whenever {id} isn't a real members/{id} doc
  lastMessageAt: timestamp
  lastMessagePreview: string        // first 140 chars of the last message body (or "📷 Photo")
  lastMessageChannel: string        // "email" | "sms"
  unreadByAdmin: boolean
}
```

**`conversations/{id}/messages/{auto-id}` fields:**
```
{
  channel: string      // "email" | "sms"
  direction: string     // "inbound" | "outbound"
  body: string
  subject: string | null       // email only
  mediaUrl: string | null       // SMS/MMS photo, or a walk-completion photo relayed as a text
  sentBy: string         // admin's uid, "system", "member", or a raw phone/email for unmatched senders
  status: string          // "sent" | "received" | "failed" | "pending_credentials" | "unmatched"
  externalId: string | null    // Gmail message ID or Twilio SID — used to dedupe re-syncs
  automated: boolean
  createdAt: timestamp
}
```

Populated by two paths: Twilio SMS/MMS webhooks (real-time), and `gmailSyncPoll` — a scheduled function polling Gmail every 5 minutes for anything new (see below).

---

### 8. `system`

A single fixed document, `system/gmailAuth`, holding the Gmail OAuth connection state for the shared `hello@` inbox integration:
```
{
  refreshToken: string
  connectedAt: timestamp
  lastSyncedAt: timestamp   // updated at the end of every successful gmailSyncPoll run —
                             // the fastest way to confirm that scheduled function is healthy
}
```

---

### 9. `meet_greet_availability`

Admin-configured available time slots for prospective-member meet & greets, one document per calendar date.

**Document ID:** `YYYY-MM-DD`

**Fields:**
```
{
  slots: array<string>   // e.g. ["9:00am", "2:00pm"] — only present when admin has overridden
                          // that day's default slot set; absence of a doc means "use defaults"
}
```

---

## FIRESTORE SECURITY RULES

The real rules (`firestore.rules`), not the fictional custom-claims model previously documented:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function isAdmin() {
      return request.auth != null && exists(/databases/$(database)/documents/admins/$(request.auth.uid));
    }
    function isWalker() {
      return request.auth != null && exists(/databases/$(database)/documents/walkers/$(request.auth.uid));
    }
    // Resolves auth.uid -> the friendly walkerId used to scope walk/overnight access,
    // since walkers are stored at both IDs (see walkers collection above).
    function myWalkerId() {
      return get(/databases/$(database)/documents/walkers/$(request.auth.uid)).data.get('walkerId', request.auth.uid);
    }

    match /admins/{uid} {
      allow read, write: if request.auth != null && request.auth.uid == uid;
    }

    match /members/{id} {
      allow read, write: if isAdmin();
      allow read: if isWalker();
      allow read: if request.auth != null && request.auth.uid == id;

      // Members can update their own doc, but never their own billing fields —
      // those are Cloud-Function-only, to prevent a member granting themselves
      // free service or corrupting Stripe linkage.
      allow update: if request.auth != null
        && request.auth.uid == id
        && !request.resource.data.diff(resource.data).affectedKeys()
              .hasAny(['stripeCustomerId', 'stripeSubscriptionId', 'stripeSubscriptionItemId',
                       'billingStatus', 'lastPaymentAmount', 'lastPaymentDate', 'paymentMethodUpdatedAt']);
    }

    match /walkers/{id} {
      allow read, write: if isAdmin();
      allow read: if request.auth != null && resource.data.uid == request.auth.uid;
    }

    match /walks/{id} {
      allow read, write: if isAdmin();
      allow read, update: if isWalker() && resource.data.walkerId == myWalkerId();
      allow read: if request.auth != null && resource.data.memberId == request.auth.uid;

      // A member may flag their own walk for a 45-minute extension, but can only
      // ever write this exact shape — the real charge/confirmation happens through
      // admin review (confirmWalkExtension()), not by a member self-confirming.
      allow update: if request.auth != null
        && resource.data.memberId == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['extended', 'extendedStatus', 'duration'])
        && request.resource.data.extended == true
        && request.resource.data.extendedStatus == 'pending'
        && request.resource.data.duration == '45-minute walk';
    }

    match /submissions/{id} {
      allow read, write: if isAdmin();
      // Public lead-gen forms submit before the visitor has an account, so they
      // can't be gated behind request.auth != null — every other type requires login.
      allow create: if request.auth != null
        || request.resource.data.type in ['contact', 'membership_request', 'service_request', 'application'];
      allow read: if request.auth != null && resource.data.memberId == request.auth.uid;
    }

    match /meet_greet_availability/{id} {
      allow read: if true;
      allow write: if isAdmin();
    }

    match /overnights/{id} {
      allow read, write: if isAdmin();
      allow read: if request.auth != null && resource.data.memberId == request.auth.uid;
      allow read, update: if isWalker() && resource.data.walkerId == myWalkerId();
    }

    match /conversations/{id} {
      allow read, write: if isAdmin();
      match /messages/{messageId} {
        allow read, write: if isAdmin();
      }
    }
  }
}
```

**Notably absent:** custom auth claims (`request.auth.token.admin`) aren't used anywhere — admin/walker status is always a document-existence check. There's no rule for `system` or `admins` collection-wide reads (admins can only read/write their own admin doc via the explicit rule above; everything else they touch goes through the `isAdmin()` blanket grant on other collections).

---

## REAL DATA FLOWS

### Walk generation & rescheduling
- New members get their first partial month of `walks` generated by `generateInitialWalks()` right after `createMembershipSubscription()` succeeds (separate calls, so a failure in one doesn't block the other).
- Ongoing months are generated by a scheduled function following the member's `defaultWalkDays`/`defaultTimeSlot`.
- Rescheduling (`approveReschedule()`) directly overwrites `date`/`timeSlot` on the existing walk doc — no history is kept, no new document is created.

### Walk extension (30 → 45 min)
Member flags a walk via the narrow self-service rule above (`extended: true, extendedStatus: 'pending'`) and submits a `walk_extension` submissions doc. Admin reviews and calls `confirmWalkExtension()`, which sets `extendedStatus: 'confirmed'` and charges via Stripe. Declining resets `extended: false, extendedStatus: null`.

### Overnight / check-in booking
Member submits an `overnight_request` or `service_request` (via `portal-request-extras.html`). Admin reviews (adjustable dates/service/add-ons in the review UI), then `confirmOvernight()` creates the `overnights` doc, updates the submission to `confirmed`, and charges via Stripe. The walker later marks it `completed` from their portal.

### Vacation hold / pause
Member submits via `portal-pause-membership.html`, which calls the `submitVacationHold` Cloud Function. That function sets `members.status = 'paused'` + `pauseStartDate`/`pauseEndDate`, cancels any `walks` inside the hold window, creates the informational `pause_membership` submission (status already `applied`), and — only if paid walks were actually cancelled — a separate actionable `vacation_hold_refund` submission for admin to confirm. A daily scheduled function (`resumePausedMemberships`) flips the member back to `active` once `pauseEndDate` passes.

### Billing
There is no `billing` collection. Recurring membership charges are handled entirely through Stripe subscriptions (`members.stripeSubscriptionId`), with a Cloud Function keeping the subscription's billed quantity in sync with actual scheduled walk days each month. One-time services (overnight stays, check-ins, walk extensions, tier changes) are each charged individually via Stripe at the point admin confirms the relevant submission.

---

## DENORMALIZATION — WHAT ACTUALLY HAPPENS

Almost nothing is denormalized. The dashboard and portals hold `allMembers`/`allWalkers`/`allWalks` in memory (via `onSnapshot`) and do live `.find()` lookups to join a walk to its member/walker/dog names at render time. The one real exception is `overnights.memberName`/`dogName`, captured once at confirm time rather than looked up live.

---

## COMMON QUERIES IN PRACTICE

Real-time listeners (`onSnapshot`), not one-off queries, drive almost every screen:

**Member dashboard's walks:** `onSnapshot(query(collection(db,'walks'), where('memberId','==', uid)))`

**Walker's assigned walks:** `onSnapshot(query(collection(db,'walks'), where('walkerId','==', walkerDoc.id)))`

**Admin's pending requests:** `onSnapshot(collection(db,'submissions'))`, filtered/sorted client-side by `type` and `status` (via `isRequestCompleted()`), not by a Firestore-side composite query.

No query anywhere filters or sorts directly on a date field server-side (`where`/`orderBy` on `date`/`startDate`/etc.) — date-range logic is always applied client-side after fetching, using `.toDate?.() || new Date(...)` to handle both Timestamp and (for a couple of legacy fields) string values defensively.

---

## DATA RETENTION

No formal retention/archiving policy exists today. `walks`, `overnights`, `submissions`, and `conversations` all accumulate indefinitely — there is no `walk_history` archive, no scheduled deletion, and no document-count concern at this business's current scale.

---

**Document rewritten:** July 19, 2026
**Status:** Describes the live production schema, audited against `firestore.rules`, `functions/index.js`, and every collection read/write across the member/walker/admin portals.

# Port City Leash Club — Database Schema
## Firebase Firestore Design | June 2026

---

## OVERVIEW

This document outlines the complete Firestore database structure for Port City Leash Club. The design supports member management, walk scheduling, rescheduling, walker assignments, billing, and analytics.

**Key principle:** All walk modifications (rescheduling, cancellations) are tracked in the database, so the dashboard always shows accurate, up-to-date information.

---

## COLLECTIONS & DOCUMENTS

### 1. `members`
Stores member account information and preferences.

**Document ID:** `member_[UUID]` (Firebase auto-generates)

**Fields:**
```
{
  memberId: string (auto-generated UUID)
  name: string
  email: string (unique index)
  phone: string
  createdAt: timestamp
  tier: string (enum: "Essential", "Standard", "Daily")
  status: string (enum: "active", "paused", "cancelled")
  
  // Billing
  billingDate: number (day of month, 1-31)
  paymentMethodId: string (reference to payment processor)
  nextBillingDate: timestamp
  
  // Pet information
  petId: string (reference to pets collection)
  petName: string
  petBreed: string
  petAge: number
  
  // Default schedule (what they signed up for)
  defaultWalkDays: array<string> (["Monday", "Wednesday"] or similar)
  defaultTimeSlot: string (enum: "Early Morning", "Late Morning", "Afternoon")
  
  // Pending schedule changes (take effect next month)
  pendingScheduleChange: object {
    walkDays: array<string>
    timeSlot: string
    effectiveDate: timestamp (first of next month)
  }
  
  // Preferences
  walker: object {
    preferredWalkerId: string (optional)
    notes: string (dog temperament, handling notes, etc.)
  }
  
  // Address & access
  address: string
  city: string
  zipCode: string
  entryMethod: string (enum: "key", "keypad", "fob")
  entryDetails: string (keypad code, fob building, etc.)
  
  // Emergency contact
  emergencyContact: string
  emergencyPhone: string
  veterinarian: string
  veterinarianPhone: string
  
  // Flags
  isFirstWalkCompleted: boolean
  hasActiveHold: boolean
}
```

**Indexes:**
- `email` (unique)
- `tier` + `status`
- `createdAt`

---

### 2. `pets`
Stores pet profiles with care instructions.

**Document ID:** `pet_[member_id]` (one pet per member for now, expandable)

**Fields:**
```
{
  petId: string
  memberId: string (reference)
  name: string
  breed: string
  age: number
  weight: string
  gender: string (enum: "Male", "Female")
  
  // Behavior & care notes
  temperament: string
  walkingStyle: string
  commands: array<string>
  fears: array<string>
  triggers: array<string>
  medications: array<object> {
    name: string
    dosage: string
    frequency: string
    specialInstructions: string
  }
  allergies: array<string>
  
  // Photo
  photoUrl: string
  
  createdAt: timestamp
  updatedAt: timestamp
}
```

---

### 3. `walks`
**Core collection:** Stores all walk bookings, scheduled, rescheduled, and completed.

**Document ID:** `walk_[month_year]_[member_id]_[date]` 
(Example: `walk_June_2026_member_abc123_2026_06_20`)

**Fields:**
```
{
  walkId: string
  memberId: string (reference)
  petId: string (reference)
  
  // Original booking (immutable)
  originalDate: timestamp
  originalTimeSlot: string (enum: "Early Morning", "Late Morning", "Afternoon")
  
  // Current scheduled date (may differ if rescheduled)
  scheduledDate: timestamp
  scheduledTimeSlot: string
  
  // Walker assignment
  walkerId: string (reference to walkers collection)
  walkerName: string (denormalized for quick access)
  
  // Duration & type
  duration: number (minutes, typically 30)
  walkType: string (enum: "standard", "extended")
  
  // Status
  status: string (enum: "scheduled", "completed", "cancelled", "rescheduled")
  
  // Completion details (populated after walk)
  completedAt: timestamp (when walk actually happened)
  notes: string (walker notes)
  photos: array<string> (photo URLs)
  
  // Rescheduling history (tracks all changes)
  rescheduleHistory: array<object> {
    fromDate: timestamp
    fromTimeSlot: string
    toDate: timestamp
    toTimeSlot: string
    reason: string (optional)
    rescheduledAt: timestamp
    rescheduledBy: string (enum: "member", "system", "support")
  }
  
  // Cancellation details
  cancelledAt: timestamp (if cancelled)
  cancellationReason: string
  cancelledBy: string (enum: "member", "system", "walker")
  
  // Billing
  creditUsed: number (1 for standard, 1.5 for extended)
  priceApplied: number (USD)
  
  // System
  createdAt: timestamp
  updatedAt: timestamp
}
```

**Indexes:**
- `memberId` + `scheduledDate`
- `walkerId` + `scheduledDate`
- `status` + `scheduledDate`
- `memberId` + `status`

**Important notes on rescheduling:**
- When a walk is rescheduled, a new `walks` document is **not** created
- Instead, the existing document's `scheduledDate`, `scheduledTimeSlot`, and `rescheduleHistory` are updated
- This maintains a single source of truth and complete audit trail
- The `originalDate` field never changes (for reconciliation)

---

### 4. `walkers`
Stores walker/staff profiles and assignments.

**Document ID:** `walker_[UUID]`

**Fields:**
```
{
  walkerId: string
  name: string
  email: string
  phone: string
  
  // Certification & background
  certificationName: string (e.g., "Pet First Aid & CPR")
  certificationDate: timestamp
  certificationExpiresAt: timestamp
  backgroundCheckDate: timestamp
  backgroundCheckStatus: string (enum: "passed", "pending", "failed")
  
  // Availability
  availableSlots: object {
    Monday: array<string> (enum: "Early Morning", "Late Morning", "Afternoon")
    Tuesday: array<string>
    Wednesday: array<string>
    Thursday: array<string>
    Friday: array<string>
    Saturday: array<string>
    Sunday: array<string>
  }
  
  // Payment info
  paymentMethodType: string (enum: "bank_transfer", "paypal")
  paymentDetails: string (account number, obfuscated)
  
  // Rates
  standardWalkRate: number (USD, e.g., 16)
  extendedWalkRate: number (USD, e.g., 24)
  checkInRate: number (USD, e.g., 13)
  overnightRate: number (USD, e.g., 65 — composite: $45 overnight + $13 check-in + $7 top-up)
  
  // Performance
  assignedWalksThisMonth: number
  completedWalksThisMonth: number
  averageRating: number (1-5)
  totalRatings: number
  
  // Status
  status: string (enum: "active", "inactive", "on_leave")
  hireDate: timestamp
  
  // Notes
  notes: string (special handling instructions, preferences, etc.)
  
  createdAt: timestamp
  updatedAt: timestamp
}
```

**Indexes:**
- `status` + `availableSlots`

---

### 5. `billing`
Tracks monthly billing cycles and charges.

**Document ID:** `billing_[member_id]_[month_year]`
(Example: `billing_member_abc123_June_2026`)

**Fields:**
```
{
  billingId: string
  memberId: string (reference)
  
  // Billing period
  period: string (e.g., "June 2026")
  periodStart: timestamp (June 1, 2026)
  periodEnd: timestamp (June 30, 2026)
  
  // Membership charges
  membershipTier: string
  membershipPrice: number (USD)
  walksIncluded: number
  
  // Walk charges & credits
  walksScheduled: number
  walksCompleted: number
  walksCompletedInPeriod: number
  creditsUsed: number
  creditsRemaining: number
  creditsRolledOver: number (from previous month)
  
  // Add-on charges
  addOnCharges: array<object> {
    service: string (enum: "extended_walk", "overnight_stay", "check_in", "medication_admin")
    count: number
    unitPrice: number
    totalPrice: number
  }
  
  // Pricing applied (store for historical accuracy)
  priceIncreaseApplied: boolean (if annual 3% increase happened)
  priceIncreaseFactor: number (1.0 = no change, 1.03 = 3% increase)
  
  // Total
  subtotal: number
  tax: number (if applicable)
  total: number
  
  // Payment status
  chargeDate: timestamp
  paymentStatus: string (enum: "pending", "completed", "failed", "refunded")
  paymentFailureReason: string (if failed)
  paymentRetries: number
  lastRetryDate: timestamp
  
  // Notes
  adjustments: array<object> {
    description: string
    amount: number (can be negative)
    reason: string
    appliedBy: string
  }
  
  createdAt: timestamp
  updatedAt: timestamp
}
```

**Indexes:**
- `memberId` + `period`
- `paymentStatus`

---

### 6. `walk_history`
Archive of completed walks for analytics and member records.

**Document ID:** `history_[UUID]`

**Fields:**
```
{
  walkHistoryId: string
  walkId: string (reference to original walks document)
  memberId: string
  petId: string
  walkerId: string
  
  // When it happened
  completedDate: timestamp
  completedAt: timestamp (exact time)
  
  // Walk details
  duration: number (minutes)
  route: string (optional, walker notes on route)
  
  // Completion details
  notes: string
  photos: array<string> (URLs)
  
  // Rating
  rating: number (1-5, set by member)
  ratingComment: string (optional)
  
  createdAt: timestamp
}
```

**Indexes:**
- `memberId` + `completedDate`
- `walkerId` + `completedDate`

---

### 7. `membership_changes`
Audit log of all membership plan changes.

**Document ID:** `change_[UUID]`

**Fields:**
```
{
  changeId: string
  memberId: string
  
  // Change details
  fromTier: string
  toTier: string
  effectiveDate: timestamp
  
  // Reason
  changeReason: string (enum: "upgrade", "downgrade", "member_request", "admin_adjustment")
  
  // Credits handling
  creditsBeforeChange: number
  creditHandling: string (enum: "applied_to_new_tier", "converted_to_credit", "forfeited")
  creditsAfterChange: number
  
  // Admin notes
  notes: string
  changedBy: string (enum: "member", "admin")
  
  createdAt: timestamp
}
```

---

### 8. `membership_holds`
Vacation holds and service pauses.

**Document ID:** `hold_[member_id]_[UUID]`

**Fields:**
```
{
  holdId: string
  memberId: string
  
  // Hold period
  startDate: timestamp
  endDate: timestamp
  duration: number (days)
  
  // Details
  reason: string (optional)
  holdType: string (enum: "vacation", "extended_absence")
  
  // Status
  status: string (enum: "active", "completed", "cancelled")
  
  // Limits
  holdsUsedThisYear: number (out of 2 allowed)
  
  createdAt: timestamp
  cancelledAt: timestamp (if cancelled early)
}
```

**Indexes:**
- `memberId` + `status`
- `startDate`

---

### 9. `messages`
Member-to-support or member-to-walker messaging.

**Document ID:** `message_[UUID]`

**Fields:**
```
{
  messageId: string
  senderId: string (member or walker)
  recipientId: string (walker or member)
  
  // Message
  subject: string (optional)
  body: string
  
  // Status
  read: boolean
  readAt: timestamp (if read)
  
  // Type
  type: string (enum: "general", "walk_related", "billing", "urgent")
  
  createdAt: timestamp
  updatedAt: timestamp
}
```

**Indexes:**
- `senderId` + `recipientId`
- `recipientId` + `read`

---

### 10. `feedback`
Member feedback and satisfaction surveys.

**Document ID:** `feedback_[member_id]_[UUID]`

**Fields:**
```
{
  feedbackId: string
  memberId: string
  walkerId: string (reference, optional - if walk-specific)
  walkId: string (reference, optional)
  
  // Survey
  overallSatisfaction: number (1-5)
  walkerPerformance: number (1-5)
  serviceQuality: number (1-5)
  
  // Open feedback
  comment: string
  wouldRecommend: boolean
  areasForImprovement: array<string>
  
  // Flags
  requiresFollowUp: boolean
  followUpPriority: string (enum: "low", "medium", "high")
  
  createdAt: timestamp
}
```

**Indexes:**
- `memberId` + `createdAt`
- `requiresFollowUp`

---

## WALK RESCHEDULING FLOW (DATABASE PERSPECTIVE)

### Scenario: Member reschedules a walk from June 20 to June 24

**Before:**
```
Document: walks/walk_June_2026_member_abc123_2026_06_20

{
  walkId: "walk_June_2026_member_abc123_2026_06_20"
  originalDate: 2026-06-20T00:00:00Z
  scheduledDate: 2026-06-20T00:00:00Z  // Same as original
  status: "scheduled"
  rescheduleHistory: []  // Empty
}
```

**Member action:** Navigate to reschedule, select June 24, confirm

**After (database update):**
```
Document: walks/walk_June_2026_member_abc123_2026_06_20

{
  walkId: "walk_June_2026_member_abc123_2026_06_20"
  originalDate: 2026-06-20T00:00:00Z  // UNCHANGED (audit trail)
  scheduledDate: 2026-06-24T00:00:00Z  // UPDATED to new date
  status: "scheduled"  // Still scheduled, just different date
  rescheduleHistory: [
    {
      fromDate: 2026-06-20T00:00:00Z
      toDate: 2026-06-24T00:00:00Z
      rescheduledAt: 2026-06-19T14:35:22Z
      rescheduledBy: "member"
    }
  ]
}
```

**Dashboard impact:**
- Dashboard queries: `walks` where `memberId = "member_abc123"` AND `scheduledDate` between start/end of month
- Calendar regenerates with updated `scheduledDate`
- June 20 now shows no walk
- June 24 now shows the walk (moved from June 20)
- Complete audit trail visible to support team if needed

---

## PAYMENT & BILLING INTEGRATION

### Monthly billing flow:

1. **Billing date arrives** (e.g., June 1)
2. System queries `members` where `billingDate == 1`
3. For each member:
   - Query `walks` where `memberId = X` AND `scheduledDate` in previous month
   - Count `walksCompleted` 
   - Calculate `creditsUsed` from previous month
   - Create `billing` document with charges
   - Charge via Stripe/payment processor
   - Update `members.nextBillingDate`

### Rescheduling impact on billing:

- If a walk is **rescheduled to next month**, it still counts as one of this month's credits
- If a walk is **cancelled**, the credit is returned
- If a walk is **completed late** (originally scheduled for June, completed in July), it counts for June billing

---

## SECURITY & PERMISSIONS (Firestore Rules)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    
    // Members can only read/write their own data
    match /members/{memberId} {
      allow read, write: if request.auth.uid == memberId;
    }
    
    // Members can see walks only for their own pets
    match /walks/{walkId} {
      allow read: if request.auth.uid == resource.data.memberId;
      allow update: if request.auth.uid == resource.data.memberId 
                    && resource.data.status in ["scheduled", "rescheduled"];
      allow create: if request.auth.uid == request.resource.data.memberId;
    }
    
    // Walkers can read assigned walks
    match /walks/{walkId} {
      allow read: if request.auth.uid == resource.data.walkerId;
      allow update: if request.auth.uid == resource.data.walkerId
                    && request.resource.data.status in ["completed"];
    }
    
    // Members can read messages sent to them
    match /messages/{messageId} {
      allow read: if request.auth.uid == resource.data.recipientId 
                   || request.auth.uid == resource.data.senderId;
      allow create: if request.auth.uid == request.resource.data.senderId;
    }
    
    // Billing documents (read-only to members)
    match /billing/{billingId} {
      allow read: if request.auth.uid == resource.data.memberId;
    }
    
    // Admin access (separate role)
    match /{document=**} {
      allow read, write: if request.auth.token.admin == true;
    }
  }
}
```

---

## DENORMALIZATION STRATEGY

To optimize for frontend performance, we denormalize (duplicate) some data:

**In `walks` documents:**
- `walkerName` (denormalized from `walkers`)
- `petName` (denormalized from `pets`)
- `membershipTier` (denormalized from `members`)

This allows the dashboard to query walks and display full information without multiple lookups.

**Update strategy:**
- When a walker name changes, batch update all their pending `walks` documents
- This happens infrequently, so batch writes are acceptable

---

## FUTURE SCALABILITY

This schema supports:
- Multiple pets per member (expand `pets` to be separate documents)
- Multiple walkers per walk (group walks)
- Overnight stays and check-ins (add to `walks` with different type)
- Walker ratings/reviews (separate `reviews` collection)
- Referral tracking (add `referredBy` to `members`)
- Seasonal pricing adjustments
- Corporate memberships (add `enterprise` tier)

---

## QUERIES COMMONLY RUN

**Dashboard Calendar (most frequent):**
```
SELECT * FROM walks 
WHERE memberId = "member_abc123" 
  AND scheduledDate >= 2026-06-01 
  AND scheduledDate < 2026-07-01
ORDER BY scheduledDate ASC
```

**Walker Schedule:**
```
SELECT * FROM walks 
WHERE walkerId = "walker_xyz789" 
  AND scheduledDate >= TODAY 
  AND status IN ["scheduled", "rescheduled"]
ORDER BY scheduledDate ASC
```

**Monthly Billing:**
```
SELECT * FROM walks 
WHERE memberId = "member_abc123" 
  AND completedDate >= 2026-06-01 
  AND completedDate < 2026-07-01 
  AND status = "completed"
```

**Members Needing Follow-up:**
```
SELECT * FROM feedback 
WHERE requiresFollowUp = true 
  AND followUpPriority IN ["high", "medium"]
ORDER BY createdAt DESC
```

---

## DOCUMENT SIZE LIMITS

Firestore has a 1 MB document size limit. Current design keeps documents well under this:
- Largest typical document: `walks` with full history (~10 KB)
- `billing` document with month of data (~5 KB)

No risk of hitting limits with this schema.

---

## DATA RETENTION & ARCHIVING

- **Active `walks`:** Keep in main collection for current + 3 months
- **Completed `walks`:** Move to `walk_history` after 6 months
- **`billing` documents:** Keep indefinitely (required for accounting)
- **`messages`:** Archive after 1 year
- **`feedback`:** Keep indefinitely (valuable for trends)

---

**Document Created:** June 19, 2026  
**Schema Version:** 1.0  
**Status:** Ready for Firebase implementation  
**Next Step:** Set up Firestore project with these collections and enable authentication

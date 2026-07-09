# Port City Leash Club — Source of Truth
**Last updated:** July 2, 2026 | This document supersedes all other project files.

---

## THE BUSINESS

**Port City Leash Club** is a premium dog walking and pet care membership service in Wilmington, NC (28403 area). Founded by Alison Gamble.

**Tagline:** "Your dog's routine, handled."
**Positioning:** Reliability, consistency, and trust. Premium alternative to Rover/Care.com. Background-checked, insured, Pet First Aid certified walkers.

---

## PRICING (Current — Website is the source of truth)

### Leash Club Memberships (per walk rate, recurring weekly schedule)

| Tier | Frequency | Per Walk | Savings vs. Single |
|------|-----------|----------|--------------------|
| **Essential** | 1–2 walks/week | $26 | 10% off |
| **Standard** | 3–4 walks/week | $25 | 14% off |
| **Daily** | Every weekday | $22 | 24% off |

**Single walk (non-member):** $29

### Membership Perks by Tier

| Perk | Essential | Standard | Daily |
|------|-----------|----------|-------|
| Walk photos & notes | ✓ | ✓ | ✓ |
| Adjust dates anytime | ✓ | ✓ | ✓ |
| Welcome gift | — | ✓ | ✓ |
| 10% off all other services | — | — | ✓ |
| Priority scheduling | — | — | ✓ |

### One-Time Services (Non-Member Rates)

| Service | Price | Notes |
|---------|-------|-------|
| Standard Walk (30 min) | $29 | Non-member only |
| Extended Walk (45 min) | $40 | Non-member |
| Extended Walk upcharge | $12 | Members upgrading a 30-min walk |
| Check-In Visit (20 min) | $25 | Feeding, potty, play, photo |
| Overnight Stay | $115 | Evening through morning |
| Extra Pet | $20 | Per additional pet |
| Medication Administration | $10 | Per visit |

**Daily members receive 10% off all one-time services.**

### Walker Payout Structure

| Service | Walker Gets | Your Margin |
|---------|------------|-------------|
| Standard Walk (30 min) | $16 | ~45% |
| Extended Walk (45 min) | $24 | ~40% |
| Extended upcharge (+15 min) | $8 | ~33% |
| Check-In Visit | $13 | ~48% |
| Overnight Stay | $45 | ~61% |
| Extra Pet | $10 | ~50% |
| Medication Admin | $5 | ~50% |

---

## THE APP (Current State — July 2, 2026)

### Repo & Deployment
- **GitHub:** `github.com/agreilley/port-city-leash-club` (user: agreilley)
- **Live site:** `https://www.portcityleashclub.com` (also `https://port-city-leash-club.vercel.app`)
- **Deployment:** Vercel auto-deploys from GitHub main branch
- **Push command:** `git add . && git commit -m "message" && git push origin main`

### Firebase
- **Project:** `port-city-leash-club-839bc`
- **API Key:** `AIzaSyC9xuNrH15BOxVEpUzCD4mAJudUNXsUveY`
- **Admin UID:** TBD — set when admin account is created in the new project (alison@portcityleashclub.com)
- **Auth authorized domains:** localhost, portcityleashclub.com, www.portcityleashclub.com, port-city-leash-club.vercel.app

### Design System
- **Navy:** `#0D1B2A` — primary background, headings
- **Seafoam:** `#8FA8A2` — accents, secondary elements
- **Sand:** `#E9E1D3` — backgrounds, cards
- **Coral/Rust:** `#C17B6F` — CTAs, highlights
- **Fonts:** Cormorant Garamond (headings), DM Sans (body)

### Three Portals

| Portal | Login URL | Dashboard URL | Status |
|--------|-----------|---------------|--------|
| **Admin** | `/admin/index.html` | `/admin/dashboard.html` | ✅ Fully wired |
| **Walker** | `/walker/index.html` | `/walker/dashboard.html` | ✅ Fully wired |
| **Member** | `/portal-login` | `/portal-dashboard` | ✅ Fully wired |

**Note:** URLs use clean URLs (no `.html`) thanks to `cleanUrls: true` in `vercel.json`.

### Demo / Test Accounts
- **Admin:** alison.reilley@gmail.com
- **Demo member:** demo@portcityleashclub.com / LeashClub2026!
- **Demo walkers:** walker_marcus, walker_priya, walker_sam, walker_sarah_test

### Firestore Collections
- `admins` — admin users
- `members` — member profiles (dogs array, tier, status, defaultWalkDays, defaultTimeSlot)
- `walkers` — walker profiles (saved at both UID and friendly ID)
- `walks` — walk records (memberId, walkerId, date, timeSlot, status, extended, duration)
- `overnights` — confirmed overnight stays (memberId, startDate, endDate, status)
- `submissions` — all form submissions (walk reschedules, overnight requests, pause requests, messages, tier changes, dog roster updates)
- `meet_greet_availability` — meet & greet calendar slots

### Firestore Security Rules (Summary)
- Admins: read/write everything
- Walkers: read members + their own walks, update walk status
- Members: read/update their own member doc, read their own walks/overnights/submissions, create submissions
- `submissions.create`: open to all authenticated users
- `meet_greet_availability.read`: public

### Key Architecture Decisions
1. **Member portal uses named Firebase app `"member-app"`** to avoid session conflict with admin portal
2. **Walker docs saved at TWO IDs:** friendly ID (e.g. `walker_sarah_test`) used as `walkerId` in walks, plus UID for security rules
3. **Dogs stored as array** on member doc (`dogs: [{name, breed, age, weight, temperament, walkingPrefs, triggers, medications, allergies}]`) with legacy single-dog fields kept for backwards compat
4. **Overnights flow:** member submits via `portal-request-extras` → lands in `submissions` as `overnight_request` → admin confirms in inbox → moves to `overnights` collection → member calendar updates to confirmed (green)
5. **Extended walks:** member selects walks in `portal-extend-walk` → writes `extended: true` + `duration: '45-minute walk'` to walk doc in `walks` collection

### Member Portal Pages (all wired to Firebase)
| Page | File | What it does |
|------|------|-------------|
| Login | `portal-login` | Firebase Auth sign-in |
| Dashboard | `portal-dashboard` | Calendar (walks + overnights), metrics, next walk |
| Walk History | `portal-walk-history` | Completed walks with notes, filterable |
| Pet Profile | `portal-pet-profile` | Multi-dog profiles, add/remove dogs, home access |
| Account | `portal-account` | Member info, billing, walk schedule display |
| Additional Care | `portal-extras` | View/request overnight stays and check-ins |
| Request Extras | `portal-request-extras` | Submit overnight/check-in requests to Firestore |
| Extend Walk | `portal-extend-walk` | Select walks to upgrade to 45 min ($12 upcharge) |
| Reschedule | `portal-reschedule` | Submit reschedule request to Firestore |
| Pause Membership | `portal-pause-membership` | Submit pause request + update member status |
| Messages | `portal-messages` | Send message to admin via Firestore submission |
| Membership Upgrade | `portal-membership-upgrade` | Submit tier change request |
| Password Reset | `portal-password-reset` | Firebase password reset |

### Admin Portal Features (all working)
- Member management (add, view, edit)
- Walker management (add, view, edit)
- Walk calendar with overnight stays shown as chips
- Walk assignment and completion
- Inbox for all submissions (overnight confirm button, dog update alerts, messages)
- Analytics (member count, walks this week, unassigned walks, active walkers)

### Walker Portal Features (all working)
- Upcoming assigned walks
- Month calendar with color-coded time slots
- Walk details modal
- Mark walks as completed
- Walk history and stats

---

## MULTI-DOG POLICY

- One membership covers the full household (all dogs)
- All dogs walked together within the same 30-minute visit (owner and walker's discretion on splitting time)
- Extended walk ($12 upcharge for members) is the natural option for multi-dog households or high-energy breeds needing more time
- Dog roster changes (adds/removals) in the member portal automatically notify admin via `dog_update` submission

---

## OPERATIONS NOTES

- **Service area:** Wilmington, NC 28403
- **Walk time slots:** Morning (7–10am), Early Afternoon (11am–2pm), Late Afternoon (2–5pm)
- **Meet & greet:** Required before first walk, scheduled via availability calendar
- **Walkers:** Background checked, insured, Pet First Aid certified
- **Booking:** Schedule set at membership start, adjust dates anytime through portal

---

## WHAT'S STILL TO DO (as of July 2, 2026)

### Minor / Polish
- [ ] Walk History page: currently shows real data but walker notes are sparse in demo data — will improve as real walks accumulate
- [ ] Account page: walk schedule display pulls from `defaultWalkDays`/`defaultTimeSlot` on member doc — needs to be set when admin creates member
- [x] ~~Messages page~~ — **Removed.** Member communication now goes through real email/text (Gmail + Twilio), not an in-app inbox. `portal-messages.html` deleted. Contact info shown on Account page instead.
- [ ] Password reset page: UI exists but Firebase password reset email not yet configured

### When Ready to Launch to Real Members
- [x] ~~Add real member accounts via admin portal~~ — **Done (July 8).** "Add Member" and "Convert to Member" now create a real Firebase Auth login and save the member doc at the Auth UID. Admin sees login credentials (email + temporary password) on the success screen.
- [ ] Set `defaultWalkDays` and `defaultTimeSlot` on each member doc when onboarding
- [ ] Configure Firebase password reset email template (Firebase Console → Authentication → Templates)
- [ ] Remove demo member account (`demo@portcityleashclub.com`) or leave for testing
- [ ] Re-seed demo data with current dates if showing site to prospective members

---

## FILES IN THIS PROJECT (Archived — Historical Reference Only)

The following project files are **outdated** and should be treated as historical context only. The information above supersedes them:

- `Membership_Framework.md` — old pricing model
- `Financial_Projections.md` — built on old pricing
- `Port_City_Leash_Club_Pricing_Quick_Reference.md` — superseded by pricing table above
- `Port_City_Leash_Club_Business_Plan_Summary_ABBREVIATED.md` — partially outdated
- `Port_City_Leash_Club_Cowork_Task_Board.md` — old task list, no longer relevant
- `Port_City_Leash_Club_Master_Task_List.md` — old task list

Still relevant:
- `Operations_Manual.md` / `Port_City_Leash_Club_Operations_Manual_ABBREVIATED.md` — operational processes mostly current
- `Port_City_Leash_Club_Marketing_Playbook_POLISHED.md` — marketing strategy still valid

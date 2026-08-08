# SEO Audit — Port City Leash Club

**Date:** 2026-08-08
**Scope:** Static site in this repo, deployed to Vercel from `main`, live at https://www.portcityleashclub.com
**Method:** Static code review of all HTML in the repo + live checks against the production domain (curl for headers/status, no Lighthouse run). Read-only — no changes made.

---

## 1. Page Inventory

### Public marketing / conversion pages (should be indexable, optimized)

| File | Live path | Title | Meta description |
|---|---|---|---|
| `index.html` | `/` | `Port City Leash Club` | **missing** |
| `faq.html` | `/faq` | `FAQ \| Port City Leash Club` | **missing** |
| `contact.html` | `/contact` | `Contact \| Port City Leash Club` | **missing** |
| `careers.html` | `/careers` | `Careers \| Port City Leash Club` | **missing** |
| `membership-request.html` | `/membership-request` | `Join The Leash Club \| Port City Leash Club` | **missing** |
| `service-request.html` | `/service-request` | `Request a Service \| Port City Leash Club` | **missing** |

### Utility / landing pages (not core marketing, indexing status varies)

| File | Live path | Title | Notes |
|---|---|---|---|
| `welcomehome.html` | `/welcomehome` | `Welcome Home \| Port City Leash Club` | Partner-referral landing page (per project memory, meant for external partner/QR links, not organic search). No `noindex`, no meta description. |
| `walker-screening.html` | `/walker-screening` | `Walker Screening \| Port City Leash Club` | Has `<meta name="robots" content="noindex, nofollow">`. Not linked from any public page — reached only via a direct link sent to candidates. Correctly excluded from indexing. |
| `portal-login.html` | `/portal-login` | `Login - The Leash Club` | Public entry point to the gated portal. No description, no `noindex`. |
| `password-reset-complete.html` | `/password-reset-complete` | `Password Updated - Port City Leash Club` | Transactional confirmation page. No `noindex`. |
| `portal-password-reset.html` | `/portal-password-reset` | `Reset Password - The Leash Club` | Transactional. No `noindex`. |
| `dev/backfill-next-month-walks.html` | `/dev/backfill-next-month-walks` | `Backfill Next Month's Walks \| PCLC (admin only)` | Internal admin tool, tracked in git and **live** (200). Correctly has `noindex, nofollow`. |

Not live (gitignored, confirmed 404 in production): `dev/seed-demo.html`, `dev/dev-coverage-map.html`, `dev/email-previews/*`. No action needed on these.

### Gated portal pages (member)

`portal-account.html`, `portal-dashboard.html`, `portal-extend-walk.html`, `portal-extras.html`, `portal-membership-upgrade.html`, `portal-pause-membership.html`, `portal-pet-profile.html`, `portal-referrals.html`, `portal-request-extras.html`, `portal-reschedule.html`, `portal-walk-history.html`

### Gated portal pages (admin)

`admin/index.html`, `admin/dashboard.html`, `admin/data-review.html`, `admin/reset-password.html`

### Gated portal pages (walker)

`walker/index.html`, `walker/dashboard.html`, `walker/reset-password.html`

**All 21 gated pages above return HTTP 200 with no authentication check at the server/HTTP level** (confirmed live: `/portal-dashboard` and `/admin/dashboard` both return `200`, full HTML shell, no `noindex` meta, no `X-Robots-Tag` header). Auth is enforced client-side only (JS checks after page load), which is fine for access control but means nothing stops a crawler from indexing these URLs. See §3.

---

## 2. Head Tag Audit (public pages)

Checked all 6 public marketing pages plus `welcomehome.html`, `walker-screening.html`, `portal-login.html`, `password-reset-complete.html`, `portal-password-reset.html`.

| Item | Finding |
|---|---|
| **Canonical tags** | **None exist anywhere in the repo.** Zero pages, public or gated, have `<link rel="canonical">`. |
| **Open Graph tags** | **None exist anywhere.** No `og:title`, `og:description`, `og:image`, `og:url`, `og:type` on any page. Links shared to iMessage/Slack/Facebook/etc. will render with no preview or a browser-guessed one. |
| **Twitter card tags** | **None exist anywhere.** Same gap as OG. |
| **og:image resolves?** | N/A — the tag doesn't exist to check. |
| **Meta description** | **Missing on every single page in the site** (100+ HTML files, public and gated alike). No exceptions found. |
| **Viewport** | Present and correct on every page checked: `<meta name="viewport" content="width=device-width, initial-scale=1.0">`. |
| **`lang` attribute** | Present and correct on every page checked: `<html lang="en">`. |
| **Charset** | Present and correct: `<meta charset="UTF-8">`, always the first tag in `<head>`. |
| **Google Search Console verification** | Not found (no `google-site-verification` meta tag anywhere). Could also be verified via DNS TXT record instead, which this audit can't see — worth confirming with Alison whether GSC is set up at all. |
| **Analytics** | `js/ga4.js`, `js/meta-pixel.js`, and `js/attribution.js` are loaded (deferred) on every public page — these are analytics/attribution scripts, not verification meta tags. |

---

## 3. Indexing Control

- **`robots.txt`**: **Does not exist.** Confirmed both in the repo and live (`https://www.portcityleashclub.com/robots.txt` → HTTP 404). No crawl directives of any kind are being given to search engines.
- **`sitemap.xml`**: **Does not exist.** Confirmed both in the repo and live (404).
- **Portal/admin/walker `noindex`**: **None of the 21 gated pages have a `noindex` directive**, and there's no site-wide blocking mechanism (no `robots.txt` disallow, no `X-Robots-Tag` header — `vercel.json`'s header block only sets security headers). Since these pages also return `200` without server-side auth, they are fully crawlable and indexable right now if Google finds a link to them. This is the single biggest indexing-control gap.
  - Lower-priority in the same category: `portal-login.html`, `password-reset-complete.html`, and `portal-password-reset.html` are public but have no indexable value (login form / transactional confirmation) and currently have no `noindex`.
- **`vercel.json` review**:
  - `cleanUrls: true` — confirmed live: requesting `/faq.html` returns a `308` redirect to `/faq`. So `.html` and extensionless URLs are **not** both independently reachable — the `.html` form permanently redirects. This is good; it removes the duplicate-content risk that flat-out dual-reachability would create. **However**, since there's no canonical tag either, this redirect is currently the *only* thing preventing duplicate-URL indexing — there's no second line of defense.
  - `trailingSlash` is not set (defaults to `false`/no forced trailing slash) — not tested for a redirect behavior but not flagged as a risk given `cleanUrls` handles the main case.
  - No `redirects` or `rewrites` blocks exist in `vercel.json`.

---

## 4. On-Page Structure (public pages)

**Heading hierarchy**: All 8 pages checked (`index`, `faq`, `contact`, `careers`, `membership-request`, `service-request`, `walker-screening`, `welcomehome`, plus `portal-login` and the two password pages) have **exactly one `<h1>`** — correct, no violations found. H2 usage is sensible: `index.html` (5 H2s), `faq.html` (7 H2s, one per FAQ section), `careers.html` (1 H2 + 2 H3s, correctly nested), `membership-request.html`/`service-request.html` (5 H2s each, one per form step — reasonable for a multi-step form page).

**Image audit** (public pages only): 11 total `<img>` tags across the 8 public/utility pages. **Every single one has a populated, descriptive `alt` attribute** — no missing or empty alt text found, and no generic filenames (`hero.jpg`, `lifestyle.jpeg`, `founder.jpeg`, `logo-horizontal.png` — all descriptive, no `IMG_1234.jpg` style names). This is a genuine strength.

However, file **sizes** are a real problem:

| File | Size | Used on |
|---|---|---|
| `images/lifestyle.jpeg` | **4.8 MB** | `index.html` |
| `images/hero.jpg` | 437 KB | `index.html` |
| `images/founder.jpeg` | 111 KB | `index.html` |
| `images/logo-horizontal.png` | 94 KB | every public page (header logo) |
| `images/logo-square.png` | 75 KB | (favicon/social use, not confirmed embedded) |

A 94 KB PNG logo rendered at 72px tall in the header, and a 4.8 MB JPEG on the homepage, are both far outside normal web-image budgets (see §6).

**Internal linking**: Every public page shares one global nav linking to `/`, `/careers`, `/contact`, `/faq`, `/membership-request`, `/portal-login`. `index.html` additionally links to `/service-request` (three variants, by query param) and to plan-specific membership-request links.

- **`walker-screening.html` is an orphan** from public navigation — no public page links to it (only a code comment references it). This appears intentional (candidates are sent the link directly), and it already carries `noindex`, so it's not an SEO problem — just confirming the design is consistent.
- **`welcomehome.html` is also an orphan** — no public page links to it. This matches the referral-program design (external partner links), but it means the page has zero internal link equity and depends entirely on external links/QR codes to be found. Flagged as worth confirming intent (see Questions).
- `service-request.html` is otherwise only linked from `index.html` and from two gated pages (`portal-request-extras.html`, `admin/dashboard.html`), which don't count for public crawl discovery.
- No page links to `index.html` by an anchor other than the logo (`href="/"`), which is standard and fine.

---

## 5. Structured Data

**Zero JSON-LD or any other schema markup exists anywhere in the repo.** No `application/ld+json` blocks on any page.

Specifically absent:
- No `LocalBusiness` / `ProfessionalService` schema. There's no NAP block to draw from either — `contact.html` publishes only an email address (`hello@portcityleashclub.com`); no phone number and no street address appear anywhere in the public site's visible text (consistent with a no-storefront, service-area business). Service-area data (zip codes 28401, 28403, 28405, 28411, 28480) exists only inside a JavaScript comment/array in `index.html` (`SIMPLE_ZIPS`, service-area validation logic) — it is not in any visible page copy or schema, so neither users nor search engines can currently see it as content.
- No `FAQPage` schema, despite `faq.html` having well-structured, crawlable Q&A content (7 H2-delimited sections) that's a strong, low-effort candidate for it.

---

## 6. Performance Signals (static analysis, no Lighthouse run)

**Fonts (Cormorant Garamond, DM Sans)**: Loaded via `@import` inside an inline `<style>` block in `<head>` on every public page:
```
@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:...&family=DM+Sans:...&display=swap');
```
This is **render-blocking in the worst common way** for font loading — the browser must download and begin parsing the inline stylesheet before it even discovers the Google Fonts URL, so the font-fetch can't start in parallel with anything else. There's no `<link rel="preconnect">` to `fonts.googleapis.com` or `fonts.gstatic.com` anywhere in the site, which would otherwise offset some of this cost. The standard fix (`<link rel="preload">`/`<link rel="stylesheet">` with preconnect, or self-hosting the fonts) is not in use anywhere.

**Render-blocking scripts in `<head>`**:
- All public pages load `js/meta-pixel.js`, `js/attribution.js`, `js/ga4.js` with `defer` — correctly non-blocking.
- `index.html` loads the Google Maps JS API in `<head>` with `async defer` — correctly non-blocking.
- `membership-request.html` loads `<script src="https://js.stripe.com/v3/"></script>` in `<head>` **with no `async` or `defer`** — this one is genuinely render-blocking on the page that most needs to convert well.

**Total page weight (heaviest public pages)**:
| Page | HTML size | + local images loaded | Approx. total |
|---|---|---|---|
| `index.html` | 58.6 KB | logo (94 KB) + hero.jpg (437 KB) + lifestyle.jpeg (4.8 MB) + founder.jpeg (111 KB) | **~5.5 MB** |
| `service-request.html` | 61.4 KB | logo only (94 KB) | ~155 KB |
| `membership-request.html` | 52.5 KB | logo only (94 KB) | ~147 KB |
| `careers.html` | 34.6 KB | logo only (94 KB) | ~129 KB |

The homepage is roughly **35x heavier** than any other public page, almost entirely because of one 4.8 MB JPEG. That single image is the largest concrete lever available for improving homepage load performance (and by extension, Core Web Vitals, which are a ranking factor).

---

## 7. Content Signals

| Page | Approx. indexable word count* | Location terms present |
|---|---|---|
| `index.html` | ~558 | "Wilmington" ×10, "NC" ×several, no neighborhood names, no zip codes in visible copy |
| `faq.html` | ~1,328 | "Wilmington" ×1 |
| `contact.html` | ~150 | "Wilmington" ×1 |
| `careers.html` | ~268 | "Wilmington" ×3 |
| `membership-request.html` | ~472 | "Wilmington" ×1 |
| `service-request.html` | ~289 | "Wilmington" ×1 |
| `welcomehome.html` | ~123 | "Wilmington" ×2 |

*Rough word counts from stripped body text, including nav/footer boilerplate repeated on every page and form field labels — treat as approximate, not prose-only counts.

Neighborhood-level terms found in visible copy anywhere on the public site: "Landfall," "Wrightsville" (once, likely "Wrightsville Beach"), "downtown," "Midtown," "historic district" — all concentrated in `index.html`'s copy. No other public page mentions a neighborhood or zip code. `contact.html` and `welcomehome.html` are notably thin on both word count and location signal.

---

## Prioritized Fix List

| # | Item | Impact | Effort |
|---|---|---|---|
| 1 | Add unique `<meta name="description">` to all 6 public pages (and `welcomehome.html`) | High | Small |
| 2 | Add `robots.txt` (allow public pages, disallow `/portal-*`, `/admin/*`, `/walker/*`) | High | Small |
| 3 | Add `noindex` meta to all 21 gated portal/admin/walker pages, plus `portal-login.html`, `password-reset-complete.html`, `portal-password-reset.html` | High | Small |
| 4 | Compress/resize `images/lifestyle.jpeg` (4.8 MB → target well under 300 KB) | High | Small |
| 5 | Rewrite `<title>` tags on public pages to include primary keyword + "Wilmington, NC" (all are currently far under the 50–60 char budget and generic, especially the homepage's bare `Port City Leash Club`) | High | Small |
| 6 | Add `sitemap.xml` listing only the public/indexable pages, once §2/§3 items are decided | Medium | Small |
| 7 | Add canonical tags to all public pages (`<link rel="canonical" href="https://www.portcityleashclub.com/...">`) | Medium | Small |
| 8 | Add Open Graph + Twitter card tags (title/description/image/url) to public pages, including a proper `og:image` | Medium | Medium |
| 9 | Add `FAQPage` JSON-LD schema to `faq.html` | Medium | Small |
| 10 | Add `LocalBusiness`/`ProfessionalService` JSON-LD with `areaServed` (zip codes already defined in `index.html`'s JS, just not surfaced anywhere) | Medium | Medium |
| 11 | Fix font loading: replace the `@import` in `<style>` with `<link rel="preconnect">` + `<link rel="stylesheet">` (or self-host) | Medium | Small |
| 12 | Remove `async`/blocking gap on the Stripe script in `membership-request.html` — move it later or add `defer` if Stripe.js supports it in this flow | Low | Small |
| 13 | Compress `images/hero.jpg` (437 KB) and `images/logo-horizontal.png` (94 KB — large for a logo) | Low | Small |
| 14 | Expand thin content on `contact.html` (~150 words) and `welcomehome.html` (~123 words); add a neighborhood/zip mention to at least one more public page beyond the homepage | Low | Medium |
| 15 | Get real, visible service-area text (zip codes/neighborhoods) onto the page instead of only living in a JS comment/array | Low | Small |

---

## Questions for Alison

These require a business decision, not just a technical fix:

1. **`welcomehome.html` indexing**: Is this page meant to ever show up in organic Google search, or is it strictly for partner/QR/offline referral links? If strictly the latter, it should get `noindex` like `walker-screening.html`; if you'd be happy to also pick up organic traffic from it, it needs a description, more content, and internal links instead.
2. **`portal-login.html`**: Do you want this to be indexable (e.g., someone searching "port city leash club login")? Recommendation is `noindex` since it has no content value, but confirming before I'd apply it.
3. **Google Search Console**: Is a GSC property already set up for the domain via DNS verification? This audit can't see DNS-based verification, only an in-page meta tag (which doesn't exist). If GSC isn't set up, that should happen before/alongside a sitemap submission.
4. **`robots.txt` scope**: Should `walker-screening.html` stay reachable-by-direct-link-only with `noindex` (current state), or should it also be blocked in `robots.txt`? (The meta tag alone is normally sufficient — `robots.txt` disallow would actually prevent Google from even reading the noindex tag, so current approach is technically correct; flagging only so the choice is explicit.)
5. **Brand name in titles**: Portal-page titles inconsistently say "The Leash Club" vs. "Port City Leash Club" (e.g., `portal-dashboard.html` → "Dashboard - The Leash Club" vs. `portal-account.html` → "Account Settings - Port City Leash Club"). Not an indexing concern if those pages go `noindex`, but worth knowing which brand form is canonical if it comes up elsewhere.
6. **Target keywords/priority neighborhoods**: Before rewriting titles/descriptions (#5 in the fix list) and adding LocalBusiness schema (#10), it would help to know which specific service-area terms (e.g., "downtown Wilmington dog walker," "Wrightsville Beach pet sitting") you most want to rank for, since that should drive the copy, not the other way around.

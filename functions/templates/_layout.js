// functions/templates/_layout.js
//
// Shared HTML/text shell every automated email template wraps its content
// in, plus the copy helpers (name joining, pluralization, date/detail block
// formatting) every template needs so none of them re-derive this logic on
// their own. Table-based layout with inline styles throughout: email
// clients strip <style> blocks and don't support flexbox/grid reliably, so
// this is the actual portable subset, not a stylistic choice. The one
// exception is the small <style> block in wrapHtml for the mobile padding
// media query — inline styles can't respond to viewport width on their own.
//
// Fonts are declared with web-safe fallbacks (Georgia for the serif
// headings, Helvetica/Arial for body text) since most email clients never
// load @font-face/webfonts at all — Cormorant Garamond/DM Sans render only
// where the client happens to already have them or honors a <link>, Georgia/
// Helvetica are what most recipients will actually see.
//
// Deliberately no Gmail dark-mode CSS overrides: Gmail inverts colors AFTER
// its own CSS is applied, and the common workarounds for fighting that
// (forced color-scheme meta combinations, !important color pins on every
// element) are unreliable across Gmail's own client versions. The palette
// below is the actual mitigation — warm, mid-toned colors invert to
// something reasonable, where pure white/near-black would invert to
// something jarring.
//
// No em dashes as sentence punctuation anywhere a template renders content
// to a recipient (subject/html/text) — every helper here that builds
// user-facing copy uses commas/colons/periods instead. Code comments are
// exempt; this only applies to what actually gets sent.

const NAVY = '#0D1B2A';
const SEAFOAM = '#8FA8A2';
const SAND = '#E9E1D3';
const SAND_LIGHT = '#F4F0EA';
const CORAL = '#C17B6F';

// Two sign-off identities, chosen per template by how personal the moment
// is, not interchangeable defaults. Alison signs the high-touch moments —
// she's the sole founder and operator, and templates like the meet & greet
// confirmations and the portal-access email name her personally as who's
// actually showing up or doing the work described. The team signs the
// transactional moments — a generated referral code, an automated charge
// notice — where naming her individually would overstate her personal
// involvement in something automated. Two shared constants, one per
// identity, so every template using either one stays in lockstep if either
// name ever changes.
const SIGNOFF_NAME = 'Alison';
const TEAM_SIGNOFF = 'The Port City Leash Club team';

const HEADING_FONT = "'Cormorant Garamond', Georgia, 'Times New Roman', serif";
const BODY_FONT = "'DM Sans', Helvetica, Arial, sans-serif";

// Header logo — Sand-colored artwork on transparent, so it must only ever
// sit on the navy header bar, never a light background. Asset is 480x76
// (2x) for retina; width/height are set explicitly below since Outlook
// collapses the row without an explicit height on the <img> itself.
const LOGO_URL = 'https://portcityleashclub.com/email/logo.png';
const LOGO_WIDTH = 240;
const LOGO_HEIGHT = 38;

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// "2026-09-02" -> "Tuesday, September 2". Parses components directly rather
// than `new Date(str)` to avoid any timezone-driven day shift — this is a
// pure calendar date, not an instant.
function formatCalendarDate(dateStr) {
  if (typeof dateStr !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
// Back-compat name used by membership-request-received; same function.
const formatMeetGreetDate = formatCalendarDate;

// "5:00pm" -> "5:00 PM". The meet-greet calendar (meet-greet-calendar.js)
// always produces lowercase, no-space slots like this — same format on both
// membership_request and service_request submissions.
function formatMeetGreetSlot(slot) {
  if (typeof slot !== 'string') return null;
  const m = slot.match(/^(\d{1,2}):(\d{2})(am|pm)$/i);
  if (!m) return slot;
  return `${m[1]}:${m[2]} ${m[3].toUpperCase()}`;
}

// walks/{id}.timeSlot is a bucket key ('morning' / 'early-afternoon' /
// 'late-afternoon'), not a clock time like the meet-greet calendar's slots
// — a different format needs a different formatter rather than reusing
// formatMeetGreetSlot and rendering the raw key. Unrecognized/missing
// values return null so callers can degrade to a date-only line instead of
// printing a raw key like "early-afternoon".
const WALK_TIME_SLOT_LABELS = {
  morning: 'Morning',
  'early-afternoon': 'Early Afternoon',
  'late-afternoon': 'Late Afternoon',
};
function formatWalkTimeSlot(slot) {
  return WALK_TIME_SLOT_LABELS[slot] || null;
}

// "2026-09-12" + "2026-09-15" -> "September 12 to September 15". Always
// repeats the month on both ends, even within the same month — matches the
// literal example in the brief rather than abbreviating.
function formatDateRange(startStr, endStr) {
  const fmt = (s) => {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const [year, month, day] = s.split('-').map(Number);
    return new Date(year, month - 1, day).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  };
  const start = fmt(startStr);
  const end = fmt(endStr);
  if (!start) return end || '';
  if (!end || start === end) return start;
  return `${start} to ${end}`;
}

// Names, joined with a serial (Oxford) comma:
//   1: "Bailey"
//   2: "Bailey and Max"
//   3+: "Bailey, Max, and Cooper"
function joinNames(names) {
  const list = (names || []).filter(Boolean);
  if (!list.length) return '';
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

// "Can't wait to meet you and Bailey." / "Can't wait to meet you, Bailey,
// and Max." — the owner is always the first item in the series, pet names
// follow in order.
function meetClosingLine(names) {
  return `Can't wait to meet ${joinNames(['you', ...(names || []).filter(Boolean)])}.`;
}

function pluralNoun(count, singular, plural) {
  return count === 1 ? singular : plural;
}

// "your dog's" (1) / "your dogs'" (2+) — works for "pet"/"pets" too.
// Passing the same word for singular/plural where a noun's plural isn't a
// simple +s isn't needed here (dog/dogs, pet/pets both regular).
function possessive(count, singular, plural) {
  return count === 1 ? `${singular}'s` : `${plural}'`;
}

const SMALL_NUMBER_WORDS = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
// 3 -> "Three" (spelled out through ten, matching the brand's restrained
// tone in the given examples: "Three nights", not "3 nights"). Falls back
// to the numeral for anything longer, since a spelled-out "Fourteen" reads
// worse than "14" at that length.
function spellSmallNumber(n) {
  return (Number.isInteger(n) && n >= 0 && n < SMALL_NUMBER_WORDS.length) ? SMALL_NUMBER_WORDS[n] : String(n);
}

// Shared "Sand box with an eyebrow label, optional big heading line, and a
// stack of label/value rows" — used for the meet & greet detail block
// (membership-request-received, service-request-received) and every
// booking/request block (portal-service-request-received,
// portal-service-confirmed, walk-confirmed, portal-walk-request-received,
// member-welcome). One shared renderer so the visual pattern approved for
// template 1 stays consistent everywhere it's reused, rather than each
// template reimplementing its own box. Background is SAND, one step
// deeper than the SAND_LIGHT body, so it reads as a distinct card without
// needing a border.
function renderBlockHtml({ eyebrow, heading, rows }) {
  const rowsHtml = (rows || []).filter(Boolean).map((r) => `
            <tr>
              <td style="padding-bottom:10px;font-family:${BODY_FONT};font-size:14px;color:${NAVY};"><strong>${escapeHtml(r.label)}:</strong> ${r.value}</td>
            </tr>`).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SAND};border-radius:4px;margin:28px 0;">
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 4px;font-family:${BODY_FONT};font-size:12px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY};">${escapeHtml(eyebrow)}</p>
          ${heading ? `<p style="margin:0 0 18px;font-family:${HEADING_FONT};font-weight:400;font-size:26px;line-height:1.2;color:${NAVY};">${heading}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0">${rowsHtml}
          </table>
        </td>
      </tr>
    </table>
  `;
}

function renderBlockText({ eyebrow, heading, rows }) {
  const lines = [eyebrow.toUpperCase()];
  if (heading) lines.push(heading);
  lines.push('');
  (rows || []).filter(Boolean).forEach((r) => lines.push(`${r.label}: ${r.value}`));
  return lines.join('\n');
}

// Bulletproof-ish table button — no <button>/box-shadow/gradients, just a
// solid-color table cell with padding, which survives Outlook's Word
// rendering engine as well as every modern client.
function renderButtonHtml({ href, label }) {
  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td style="background-color:${CORAL};border-radius:6px;">
          <a href="${escapeHtml(href)}" style="display:inline-block;padding:13px 28px;font-family:${BODY_FONT};font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;border-radius:6px;">${escapeHtml(label)}</a>
        </td>
      </tr>
    </table>
  `;
}

// Shared sign-off: a 1px Seafoam rule above the WHOLE closing block, then
// (optionally) a greeting line ("Talk soon,"), then the name in italic
// serif. `greeting` is a parameter rather than something each template
// writes as its own paragraph before calling this — the rule has to sit
// above both lines together, not between them, so this one shared spot
// owns the complete closing block, not just the name. Five templates pass
// "Talk soon," here; membership-request-received and
// service-request-received call this with no greeting at all and still
// get the rule directly above the name, no gap where a missing line would
// otherwise leave one. The copy itself is unchanged either way — only
// which file's markup contains the "Talk soon," string moved. The rule
// uses a 1px-tall bordered cell rather than <hr>, which email clients
// render inconsistently.
function renderSignoffHtml(name, greeting) {
  const greetingHtml = greeting ? `<p style="margin:16px 0 0;">${escapeHtml(greeting)}</p>` : '';
  const nameMarginTop = greeting ? '4px' : '16px';
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0 0;">
      <tr><td style="border-top:1px solid ${SEAFOAM};font-size:1px;line-height:1px;">&nbsp;</td></tr>
    </table>
    ${greetingHtml}
    <p style="margin:${nameMarginTop} 0 0;font-family:${HEADING_FONT};font-style:italic;font-size:18px;color:${NAVY};">${escapeHtml(name)}</p>
  `;
}

function wrapHtml({ preheader, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<title>Port City Leash Club</title>
<style>
  @media only screen and (max-width: 600px) {
    .pclc-body-pad { padding-left: 24px !important; padding-right: 24px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${SAND_LIGHT};">
${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;opacity:0;">${escapeHtml(preheader)}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SAND_LIGHT};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background-color:${SAND_LIGHT};border-radius:8px;border:1px solid rgba(13,27,42,0.08);">
        <tr>
          <td align="center" style="background-color:${NAVY};padding:28px 0;border-radius:8px 8px 0 0;">
            <img src="${LOGO_URL}" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" alt="Port City Leash Club" style="display:block;margin:0 auto;border:0;outline:none;text-decoration:none;" />
          </td>
        </tr>
        <tr>
          <td class="pclc-body-pad" style="padding:36px 40px;font-family:${BODY_FONT};color:${NAVY};font-size:16px;line-height:1.6;">
            ${bodyHtml}
          </td>
        </tr>
        <tr>
          <td style="background-color:${NAVY};padding:24px 40px;text-align:center;border-radius:0 0 8px 8px;">
            <p style="margin:0;font-family:${BODY_FONT};font-size:12px;line-height:1.6;color:${SAND};">
              Port City Leash Club &middot; Wilmington, NC<br>
              Questions? Just reply to this email, or write to
              <a href="mailto:hello@portcityleashclub.com" style="color:${CORAL};">hello@portcityleashclub.com</a>.
            </p>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;
}

function wrapText({ bodyText }) {
  return `${bodyText}\n\nPort City Leash Club\nWilmington, NC\nQuestions? Just reply to this email, or write to hello@portcityleashclub.com.\n`;
}

module.exports = {
  NAVY, SEAFOAM, SAND, SAND_LIGHT, CORAL, HEADING_FONT, BODY_FONT, SIGNOFF_NAME, TEAM_SIGNOFF,
  escapeHtml, formatCalendarDate, formatMeetGreetDate, formatMeetGreetSlot, formatWalkTimeSlot, formatDateRange,
  joinNames, meetClosingLine, pluralNoun, possessive, spellSmallNumber,
  renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml,
  wrapHtml, wrapText,
};

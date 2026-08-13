// dev/render-emails.js
//
// Local preview tool — renders every email template registered in
// functions/lib/email.js with sample data covering each one's meaningful
// variants, writes them to dev/email-previews/, and prints the plain-text
// version of each to stdout. Never deployed (Cloud Functions only deploys
// the functions/ directory) and never sends real mail — this only calls
// each template's own subject()/html()/text() functions directly.
//
// Run: node dev/render-emails.js
// Then open dev/email-previews/index.html in a browser.
//
// Sample data deliberately varies pet/dog count across the set (1, 2, and
// 3) so the name-join (joinNames/meetClosingLine) and possessive() logic
// both render in every shape they can take: "Bailey" / "Bailey and Max" /
// "Bailey, Max, and Cooper", "you and Bailey" / "you, Bailey, and Max",
// and "dog's"/"pet's" vs "dogs'"/"pets'".

const fs = require('fs');
const path = require('path');
const { TEMPLATES } = require('../functions/lib/email.js');

const OUT_DIR = path.join(__dirname, 'email-previews');
fs.mkdirSync(OUT_DIR, { recursive: true });

// Each entry: { template, variant, label, petCount, data }
// petCount is just for the index page label — it's not read by any template.
const RENDERS = [
  // ── membership-request-received ──────────────────────────────────────
  {
    template: 'membership-request-received',
    variant: 'with-meetgreet',
    label: 'With meet and greet',
    petCount: 2,
    data: {
      firstName: 'Jamie',
      dogNames: ['Bailey', 'Max'],
      tier: null, // sub.plan no longer exists client-side — sendMembershipRequestReceivedEmail always passes null now
      meetGreetDateStr: '2026-09-02',
      meetGreetSlot: '5:00pm',
      address: '412 Market St, Wilmington, NC 28401',
    },
  },
  {
    template: 'membership-request-received',
    variant: 'without-meetgreet',
    label: 'No meet and greet on file yet',
    petCount: 1,
    data: {
      firstName: 'Morgan',
      dogNames: ['Rex'],
      tier: null, // sub.plan no longer exists client-side — sendMembershipRequestReceivedEmail always passes null now
      meetGreetDateStr: '',
      meetGreetSlot: '',
      address: '',
    },
  },

  // ── service-request-received ─────────────────────────────────────────
  {
    template: 'service-request-received',
    variant: 'pet-sitting-with-meetgreet',
    label: 'Pet sitting, with meet and greet',
    petCount: 3,
    data: {
      firstName: 'Alex',
      petNames: ['Luna', 'Milo', 'Charlie'],
      serviceFamily: 'pet-sitting',
      meetGreetDateStr: '2026-09-05',
      meetGreetSlot: '10:00am',
      address: '88 Oak Ave, Wilmington, NC 28403',
    },
  },
  {
    template: 'service-request-received',
    variant: 'pet-sitting-without-meetgreet',
    label: 'Pet sitting, no meet and greet on file yet',
    petCount: 1,
    data: {
      firstName: 'Casey',
      petNames: ['Whiskers'],
      serviceFamily: 'pet-sitting',
      meetGreetDateStr: '',
      meetGreetSlot: '',
      address: '',
    },
  },
  {
    template: 'service-request-received',
    variant: 'walk-with-meetgreet',
    label: 'One-time walk, with meet and greet',
    petCount: 1,
    data: {
      firstName: 'Chris',
      petNames: ['Duke'],
      serviceFamily: 'walk',
      meetGreetDateStr: '2026-09-06',
      meetGreetSlot: '5:30pm',
      address: '20 Elm St, Wilmington, NC 28401',
    },
  },
  {
    template: 'service-request-received',
    variant: 'walk-without-meetgreet',
    label: 'One-time walk, no meet and greet on file yet',
    petCount: 2,
    data: {
      firstName: 'Robin',
      petNames: ['Bailey', 'Max'],
      serviceFamily: 'walk',
      meetGreetDateStr: '',
      meetGreetSlot: '',
      address: '',
    },
  },

  // ── portal-service-request-received ──────────────────────────────────
  {
    template: 'portal-service-request-received',
    variant: 'overnight',
    label: 'Overnight stay (exact night count shown)',
    petCount: 2,
    data: {
      firstName: 'Sam',
      petNames: ['Luna', 'Milo'],
      serviceLabel: 'Overnight Stay',
      startDateStr: '2026-09-12',
      endDateStr: '2026-09-15',
      unitCount: 3,
      unitNoun: 'night',
    },
  },
  {
    template: 'portal-service-request-received',
    variant: 'dropin',
    label: 'Drop-in visit (Length row omitted)',
    petCount: 1,
    data: {
      firstName: 'Taylor',
      petNames: ['Coco'],
      serviceLabel: 'Drop-In Visit',
      startDateStr: '2026-09-10',
      endDateStr: '2026-09-13',
      unitCount: null,
      unitNoun: 'visit',
    },
  },

  // ── portal-service-confirmed ──────────────────────────────────────────
  {
    template: 'portal-service-confirmed',
    variant: 'existing-member',
    label: 'Existing member',
    petCount: 3,
    data: {
      firstName: 'Alex',
      petNames: ['Luna', 'Milo', 'Charlie'],
      serviceLabel: 'Overnight Stay',
      startDateStr: '2026-09-12',
      endDateStr: '2026-09-15',
      unitCount: 3,
      unitNoun: 'night',
      isNewAccount: false,
      portalSetupLink: null,
    },
  },
  {
    template: 'portal-service-confirmed',
    variant: 'new-account',
    label: 'New account',
    petCount: 1,
    data: {
      firstName: 'Taylor',
      petNames: ['Coco'],
      serviceLabel: 'Drop-In Visit',
      startDateStr: '2026-09-10',
      endDateStr: '2026-09-13',
      unitCount: 4,
      unitNoun: 'visit',
      isNewAccount: true,
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-new-service',
    },
  },

  // ── walk-confirmed ────────────────────────────────────────────────────
  {
    template: 'walk-confirmed',
    variant: 'existing-client',
    label: 'Existing client',
    petCount: 2,
    data: {
      firstName: 'Riley',
      dogNames: ['Bailey', 'Max'],
      walkTypeLabel: 'Extended walk',
      durationMinutes: 45,
      walks: [{ dateStr: '2026-09-12', slot: 'early-afternoon' }],
      isNewAccount: false,
      portalSetupLink: null,
    },
  },
  {
    template: 'walk-confirmed',
    variant: 'new-account',
    label: 'New account (also: no time slot captured, date-only line)',
    petCount: 1,
    data: {
      firstName: 'Jordan',
      dogNames: ['Rex'],
      walkTypeLabel: 'Standard walk',
      durationMinutes: 30,
      walks: [{ dateStr: '2026-09-14', slot: null }],
      isNewAccount: true,
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-new-walk',
    },
  },

  // ── portal-walk-request-received ─────────────────────────────────────
  {
    template: 'portal-walk-request-received',
    variant: 'single-walk',
    label: 'Single walk requested',
    petCount: 1,
    data: {
      firstName: 'Drew',
      dogNames: ['Duke'],
      walkTypeLabel: 'Extended walk',
      durationMinutes: 45,
      walks: [{ dateStr: '2026-09-12', slot: 'morning' }],
    },
  },
  {
    template: 'portal-walk-request-received',
    variant: 'multiple-walks',
    label: 'Multiple walks requested',
    petCount: 2,
    data: {
      firstName: 'Riley',
      dogNames: ['Bailey', 'Max'],
      walkTypeLabel: 'Extended walk',
      durationMinutes: 45,
      walks: [
        { dateStr: '2026-09-12', slot: 'early-afternoon' },
        { dateStr: '2026-09-14', slot: 'morning' },
      ],
    },
  },

  // ── member-welcome ────────────────────────────────────────────────────
  {
    template: 'member-welcome',
    variant: 'one-dog',
    label: 'One dog',
    petCount: 1,
    data: {
      firstName: 'Jamie',
      dogNames: ['Bailey'],
      tier: 'Member',
      frequency: 'Monday, Wednesday, Friday',
      firstWalkDateStr: '2026-09-03',
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-welcome-one',
    },
  },
  {
    template: 'member-welcome',
    variant: 'multiple-dogs',
    label: 'Multiple dogs (also: no first walk scheduled yet)',
    petCount: 3,
    data: {
      firstName: 'Morgan',
      dogNames: ['Bailey', 'Max', 'Cooper'],
      tier: 'Member',
      frequency: 'Monday, Tuesday, Wednesday, Thursday, Friday',
      firstWalkDateStr: null,
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-welcome-multi',
    },
  },

  // ── portal-membership-confirmed ──────────────────────────────────────
  {
    template: 'portal-membership-confirmed',
    variant: 'one-dog',
    label: 'One dog, first walk scheduled',
    petCount: 1,
    data: {
      firstName: 'Jamie',
      dogNames: ['Bailey'],
      tier: 'Member',
      frequency: 'Monday, Wednesday, Friday',
      firstWalkDateStr: '2026-09-03',
    },
  },
  {
    template: 'portal-membership-confirmed',
    variant: 'multiple-dogs',
    label: 'Multiple dogs, no first walk found yet',
    petCount: 3,
    data: {
      firstName: 'Morgan',
      dogNames: ['Bailey', 'Max', 'Cooper'],
      tier: 'Member',
      frequency: 'Monday, Tuesday, Wednesday, Thursday, Friday',
      firstWalkDateStr: null,
    },
  },

  // ── portal-access ─────────────────────────────────────────────────────
  {
    template: 'portal-access',
    variant: 'membership',
    label: 'Membership, meet & greet just completed',
    petCount: 2,
    data: {
      firstName: 'Jamie',
      petNames: ['Bailey', 'Max'],
      kind: 'membership',
      tier: 'Standard',
      frequency: 'Monday, Wednesday, Friday',
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-portal-access-membership',
    },
  },
  {
    template: 'portal-access',
    variant: 'service-dates-requested',
    label: 'Net-new one-time service, dates already requested',
    petCount: 1,
    data: {
      firstName: 'Morgan',
      petNames: ['Cooper'],
      kind: 'service',
      serviceLabel: 'Drop-In Visit',
      requestedDatesStr: 'September 12 to September 15',
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-portal-access-service-dates',
    },
  },
  {
    template: 'portal-access',
    variant: 'service-dates-unset',
    label: 'Net-new one-time service, dates not yet set',
    petCount: 1,
    data: {
      firstName: 'Riley',
      petNames: ['Luna'],
      kind: 'service',
      serviceLabel: 'Standard Walk',
      requestedDatesStr: null,
      portalSetupLink: 'https://www.portcityleashclub.com/reset?oobCode=demo-portal-access-service-unset',
    },
  },

  // ── referral-code-delivery ────────────────────────────────────────────
  {
    template: 'referral-code-delivery',
    variant: 'apartment-referral',
    label: 'Partner referral (apartment intake)',
    petCount: 0,
    data: {
      firstName: 'Jordan',
      code: 'PCLC-7X9K2M',
    },
  },
];

// ── render ────────────────────────────────────────────────────────────────

const indexRows = [];

for (const entry of RENDERS) {
  const mod = TEMPLATES[entry.template];
  if (!mod) {
    console.error(`Skipping "${entry.template}/${entry.variant}": not registered in functions/lib/email.js's TEMPLATES.`);
    continue;
  }

  const subject = mod.subject(entry.data);
  const html = mod.html(entry.data);
  const text = mod.text(entry.data);

  const fileName = `${entry.template}-${entry.variant}.html`;
  fs.writeFileSync(path.join(OUT_DIR, fileName), html);

  console.log('='.repeat(78));
  console.log(`${entry.template} / ${entry.variant}  —  ${entry.label}`);
  console.log(`Subject: ${subject}`);
  console.log('-'.repeat(78));
  console.log(text);
  console.log();

  indexRows.push({ ...entry, fileName, subject });
}

// Warn (not silently) about any registered template this script never
// exercises, so a new template added later doesn't quietly go unpreviewed.
const coveredTemplates = new Set(indexRows.map((r) => r.template));
const uncovered = Object.keys(TEMPLATES).filter((name) => !coveredTemplates.has(name));
if (uncovered.length) {
  console.error(`No sample renders defined for: ${uncovered.join(', ')} — add entries to RENDERS in dev/render-emails.js.`);
}

// ── index.html ───────────────────────────────────────────────────────────

const groupedByTemplate = {};
for (const row of indexRows) {
  if (!groupedByTemplate[row.template]) groupedByTemplate[row.template] = [];
  groupedByTemplate[row.template].push(row);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const sections = Object.entries(groupedByTemplate).map(([template, rows]) => `
  <section style="margin-bottom:32px;">
    <h2 style="font-size:18px;margin:0 0 10px;font-family:-apple-system,Helvetica,Arial,sans-serif;">${escapeHtml(template)}</h2>
    <ul style="margin:0;padding-left:20px;line-height:1.9;">
      ${rows.map((r) => `
        <li>
          <a href="${escapeHtml(r.fileName)}" target="preview">${escapeHtml(r.label)}</a>
          <span style="color:#888;font-size:13px;"> — ${r.petCount} pet${r.petCount === 1 ? '' : 's'} — subject: "${escapeHtml(r.subject)}"</span>
        </li>
      `).join('')}
    </ul>
  </section>
`).join('');

const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Email template previews</title>
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 20px; color: #222; }
  a { color: #0645AD; }
  code { background: #f0f0f0; padding: 2px 5px; border-radius: 3px; }
</style>
</head>
<body>
  <h1 style="margin-bottom:4px;">Email template previews</h1>
  <p style="color:#666;margin-top:0;">Generated by <code>node dev/render-emails.js</code> — never deployed, never sent. Regenerate any time after editing a template.</p>
  ${sections}
</body>
</html>`;

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml);

console.log('='.repeat(78));
console.log(`Wrote ${indexRows.length} renders + index.html to ${OUT_DIR}`);
console.log(`Open: ${path.join(OUT_DIR, 'index.html')}`);

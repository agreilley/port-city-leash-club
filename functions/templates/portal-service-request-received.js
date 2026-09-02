// functions/templates/portal-service-request-received.js
//
// Sent when an EXISTING member submits a pet sitting request through the
// portal (portal-request-extras.html) — overnight_request or service_request
// with a memberId already on it. Always pet sitting: that page only offers
// Overnight Stay and Drop-In Visit, never a walk (see
// portal-walk-request-received for the walk-family equivalent, sourced from
// walk_extension submissions instead). No meet and greet section, unlike
// the public-form templates: an existing member has already had one.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   serviceLabel: string,   // e.g. 'Overnight Stay' or 'Drop-In Visit'
//   startDateStr: string,   // 'YYYY-MM-DD'
//   endDateStr: string,     // 'YYYY-MM-DD'
//   unitCount: number|null, // nights (overnight, always exact from the date
//                           // range) or visits (drop-in) — null omits the
//                           // Length row entirely. portal-request-extras.html
//                           // never collects visitsPerDay, so a drop-in visit
//                           // count can't be derived here without guessing;
//                           // the date range alone is shown instead, and
//                           // admin confirms the real count at review time.
//   unitNoun: 'night' | 'visit',
// }

const {
  escapeHtml, formatDateRange, joinNames, possessive, spellSmallNumber,
  SIGNOFF_NAME, renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function unitLine(data) {
  if (data.unitCount == null) return null;
  const word = spellSmallNumber(data.unitCount);
  const noun = data.unitCount === 1 ? data.unitNoun : `${data.unitNoun}s`;
  return `${word} ${noun}`;
}

function subject(data) {
  const names = joinNames(data.petNames) || 'your pets';
  return `We got your request for ${names}`;
}

function html(data) {
  const petCount = (data.petNames || []).filter(Boolean).length || 1;

  const lengthLine = unitLine(data);
  const block = renderBlockHtml({
    eyebrow: 'Your request',
    rows: [
      { label: 'Service', value: escapeHtml(data.serviceLabel || '') },
      { label: 'Dates', value: escapeHtml(formatDateRange(data.startDateStr, data.endDateStr)) },
      lengthLine ? { label: 'Length', value: escapeHtml(lengthLine) } : null,
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Thanks for your request. We've got it and we're looking over the dates now.</p>
    ${block}
    <p style="margin:20px 0 0;">We'll confirm everything shortly. In the meantime, you can update your ${possessive(petCount, 'pet', 'pets')} routine, feeding, or any other details anytime in your ${possessive(petCount, "pet", "pets")} profile in the portal.</p>
    <p style="margin:20px 0 0;">If you have any questions, just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(SIGNOFF_NAME, 'Talk soon,')}
  `;

  return wrapHtml({ preheader: `We've got your request and we're looking over the dates now.`, bodyHtml: body });
}

function text(data) {
  const petCount = (data.petNames || []).filter(Boolean).length || 1;

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Thanks for your request. We've got it and we're looking over the dates now.`,
    '',
    renderBlockText({
      eyebrow: 'Your request',
      rows: [
        { label: 'Service', value: data.serviceLabel || '' },
        { label: 'Dates', value: formatDateRange(data.startDateStr, data.endDateStr) },
        unitLine(data) ? { label: 'Length', value: unitLine(data) } : null,
      ],
    }),
    '',
    `We'll confirm everything shortly. In the meantime, you can update your ${possessive(petCount, 'pet', 'pets')} routine, feeding, or any other details anytime in your ${possessive(petCount, "pet", "pets")} profile in the portal.`,
    '',
    `If you have any questions, just reply here and it'll come straight to us.`,
    '',
    `Talk soon,`,
    SIGNOFF_NAME,
  ];

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

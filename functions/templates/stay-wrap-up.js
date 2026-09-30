// functions/templates/stay-wrap-up.js
//
// Sent the second morning after a pet-sitting reservation (overnight stay OR drop-in
// visits, both live on overnights/{id}) ends — see sendStayWrapUpEmails,
// functions/index.js. A thank-you that closes the booking out: points to
// the stay's card in the portal (notes/photos, review, tip) and invites a
// reply with any questions or thoughts.
//
// Signed by Alison personally (SIGNOFF_NAME), unlike the other automated
// member emails that sign as the team: this is written in her voice as the
// owner's own thank-you, by her decision (2026-09-29).
//
// The review ask is direct; the tip is only mentioned in passing. Both only
// mention what's still open: someone who already left a review and/or a
// tip from the portal is thanked for it instead of being asked again.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   hasFeedback: boolean,   // overnights/{id}.feedback already set
//   hasTip: boolean,        // overnights/{id}.tip already set
//   walkerNames: string[],  // first names, default walker first, then any per-visit covers
//   portalUrl: string,      // deep link to this stay's card in portal-walk-history
// }

const {
  escapeHtml, joinNames, SIGNOFF_NAME,
  renderButtonHtml, renderSignoffHtml,
  wrapHtml, wrapText,
} = require('./_layout');

function subject(data) {
  return `Thank you for trusting us with ${joinNames(data.petNames) || 'your pets'}`;
}

// Plain-text paragraphs, shared by html() and text() so the two can't
// drift. html() escapes each one.
function paragraphs(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const walkers = joinNames(data.walkerNames) || 'your walker';

  const opening = `I wanted to take a minute to thank you for letting us take care of ${names} this week. All of the notes and photos from the visits are saved in your portal if you ever want to look back through them.`;

  let review;
  if (!data.hasFeedback) {
    review = "If you have a moment, I'd really appreciate it if you'd leave a review of the stay in your portal. Your feedback helps us keep getting better, and it means a lot to me and our walkers.";
    if (!data.hasTip) review += ` You can also leave a tip for ${walkers} there. Tips are never expected, but always appreciated.`;
    else review += ` Thank you, too, for the tip you left ${walkers}.`;
  } else if (!data.hasTip) {
    review = 'Thank you so much for your review. It means a lot to me and our walkers.';
    review += ` You can also leave a tip for ${walkers} in your portal. Tips are never expected, but always appreciated.`;
  } else {
    review = `Thank you so much for your review and for the tip you left ${walkers}. Both mean a lot to me and our walkers.`;
  }

  const reachOut = "If you have any questions, or anything you'd like to share about the stay, just reply to this email. I'd love to hear from you.";
  const closing = `We hope to see ${names} again soon.`;

  return { opening, review, reachOut, closing };
}

function buttonLabel(data) {
  return data.hasFeedback ? 'View your stay' : 'Leave a review';
}

function html(data) {
  const names = joinNames(data.petNames) || 'your pets';
  const p = paragraphs(data);

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(p.opening)}</p>
    <p style="margin:0 0 20px;">${escapeHtml(p.review)}</p>
    ${renderButtonHtml({ href: data.portalUrl, label: buttonLabel(data) })}
    <p style="margin:0 0 20px;">${escapeHtml(p.reachOut)}</p>
    <p style="margin:0;">${escapeHtml(p.closing)}</p>
    ${renderSignoffHtml(SIGNOFF_NAME)}
  `;

  return wrapHtml({
    preheader: `Thank you for letting us take care of ${names}.`,
    bodyHtml: body,
  });
}

function text(data) {
  const p = paragraphs(data);
  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    p.opening,
    '',
    p.review,
    '',
    `${buttonLabel(data)}: ${data.portalUrl}`,
    '',
    p.reachOut,
    '',
    p.closing,
    '',
    SIGNOFF_NAME,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

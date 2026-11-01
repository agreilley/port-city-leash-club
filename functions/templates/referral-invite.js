// functions/templates/referral-invite.js
//
// Sent by sendReferralInvite (functions/index.js) when a member types a
// friend's name and email into the portal's Refer a Friend tab. Replaces
// the old mailto: "Share via Email" button, which sent from the member's
// own mail app — so the business never knew who was invited.
//
// The friend never opted in to hearing from us, so this is deliberately a
// single email: no member-written message (nothing for a bad actor to fill
// with spam), and a closing line saying we won't write again unless they
// reach out or book. sendReferralInvite enforces one invite per address.
//
// data: {
//   friendFirstName: string,
//   referrerName: string,   // the member's full name, so the friend recognizes it
//   code: string,           // the member's evergreen PCLC- code
//   amountCents: number,    // 5000 today
//   link: string,           // homepage URL carrying ?code= (see js/referral-code-carry.js)
// }

const {
  escapeHtml, NAVY, SAND, HEADING_FONT, BODY_FONT, TEAM_SIGNOFF,
  renderButtonHtml, renderSignoffHtml, renderCodeBlockHtml, renderCodeBlockText, wrapHtml, wrapText,
} = require('./_layout');

function formatDollars(amountCents) {
  return `$${Math.round(amountCents / 100)}`;
}

// "Who we are" card copy is the version Alison approved for the
// 2026-10-19 Puppies & Pilates follow-ups, reused word for word.
const WHO_WE_ARE_INTRO = "We're Wilmington's newest dog walking and pet sitting company, and we're working hard to become its most trusted pet care team.";
const WHO_WE_ARE_OFFERS = [
  { label: 'The Leash Club', text: 'recurring weekly walks on a schedule that fits your week.' },
  { label: 'Pet sitting', text: 'drop-in visits and overnight care in your home.' },
];
const WHO_WE_ARE_CLOSE = "Whichever you choose, you'll work with our small, consistent team. Every member is background checked, insured, and Pet First Aid certified.";

function subject(data) {
  return `${data.referrerName} thought you'd like Port City Leash Club`;
}

function html(data) {
  const amount = formatDollars(data.amountCents);
  const offersHtml = WHO_WE_ARE_OFFERS.map((o) =>
    `<li style="margin:0 0 8px;"><strong>${escapeHtml(o.label)}:</strong> ${escapeHtml(o.text)}</li>`).join('');

  const card = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SAND};border-radius:4px;margin:28px 0;">
      <tr>
        <td style="padding:24px;font-family:${BODY_FONT};font-size:15px;line-height:1.6;color:${NAVY};">
          <p style="margin:0 0 4px;font-size:12px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;">Who we are</p>
          <p style="margin:0 0 14px;font-family:${HEADING_FONT};font-weight:400;font-size:26px;line-height:1.2;">Port City Leash Club</p>
          <p style="margin:0 0 14px;">${escapeHtml(WHO_WE_ARE_INTRO)}</p>
          <p style="margin:0 0 8px;">We offer:</p>
          <ul style="margin:0 0 14px;padding-left:20px;">${offersHtml}</ul>
          <p style="margin:0;">${escapeHtml(WHO_WE_ARE_CLOSE)}</p>
          ${renderButtonHtml({ href: data.link, label: 'Take a Look' })}
        </td>
      </tr>
    </table>
  `;

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.friendFirstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(data.referrerName)} is a Port City Leash Club client and asked us to send you their referral code. It takes ${amount} off your first charge with us, up to half the charge amount.</p>
    ${renderCodeBlockHtml(data.code)}
    ${card}
    <p style="margin:20px 0 0;">The button above carries your code with it, or you can enter it on any request form.</p>
    <p style="margin:20px 0 0;">${escapeHtml(data.referrerName)} asked us to send this one email. We won't write again unless you reach out or book with us. Questions? Just reply.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({ preheader: `${amount} toward your first charge, from ${data.referrerName}.`, bodyHtml: body });
}

function text(data) {
  const amount = formatDollars(data.amountCents);
  const lines = [
    `Hi ${data.friendFirstName || 'there'},`,
    '',
    `${data.referrerName} is a Port City Leash Club client and asked us to send you their referral code. It takes ${amount} off your first charge with us, up to half the charge amount.`,
    '',
    renderCodeBlockText(data.code),
    '',
    'WHO WE ARE',
    WHO_WE_ARE_INTRO,
    '',
    'We offer:',
    ...WHO_WE_ARE_OFFERS.map((o) => `- ${o.label}: ${o.text}`),
    '',
    WHO_WE_ARE_CLOSE,
    '',
    `Take a look: ${data.link}`,
    '',
    'That link carries your code with it, or you can enter it on any request form.',
    '',
    `${data.referrerName} asked us to send this one email. We won't write again unless you reach out or book with us. Questions? Just reply.`,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

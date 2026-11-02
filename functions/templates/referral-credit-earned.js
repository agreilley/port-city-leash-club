// functions/templates/referral-credit-earned.js
//
// Sent to a member once a friend who used their Refer a Friend code makes
// a first payment and the member's own referral credit has been issued.
// Fired by onReferralCreditNotice (functions/index.js) from a
// referralCodes/{code}/creditNotices/{newMemberId} doc that both
// referrer-credit paths write right after issueReferralCredit succeeds —
// a trigger rather than a direct send so the charge paths never need the
// Resend secret bound and a send failure can never touch a charge.
//
// data: {
//   firstName: string,         // the referring member
//   friendFirstName: string|null,
//   amountCents: number,
//   isMembershipTier: boolean, // Stripe balance on the next invoice vs. pendingReferralCredit on the next charge
//   dogNames: string[],
// }

const {
  escapeHtml, NAVY, TEAM_SIGNOFF, joinNames,
  renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

const REFERRALS_URL = 'https://www.portcityleashclub.com/portal-referrals.html';

function formatDollars(amountCents) {
  return `$${Math.round(amountCents / 100)}`;
}

function friendLabel(data) {
  return data.friendFirstName || 'Your friend';
}

function appliesLine(data) {
  return data.isMembershipTier
    ? 'It comes off your next monthly membership charge automatically.'
    : 'It comes off your next charge automatically.';
}

function closingLine(data) {
  const dogs = joinNames((data.dogNames || []).filter(Boolean));
  const thanks = `Thank you for sending ${data.friendFirstName || 'them'} our way.`;
  return dogs
    ? `${thanks} We're honored you've trusted us with ${dogs}, and with your friends too.`
    : `${thanks} We're honored you've trusted us with your friends.`;
}

function subject(data) {
  return `Your ${formatDollars(data.amountCents)} referral credit is in`;
}

function html(data) {
  const amount = formatDollars(data.amountCents);
  const body = `
    <p style="margin:0 0 20px;font-family:'Cormorant Garamond', Georgia, 'Times New Roman', serif;font-weight:400;font-size:28px;line-height:1.25;color:${NAVY};">Your ${amount} credit is in.</p>
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(friendLabel(data))} booked with us using your referral code, so ${amount} in credit is now on your account. ${escapeHtml(appliesLine(data))}</p>
    <p style="margin:0 0 20px;">You can see your credit and send your code to another friend on the Refer a Friend tab.</p>
    ${renderButtonHtml({ href: REFERRALS_URL, label: 'Refer a Friend' })}
    <p style="margin:20px 0 0;">${escapeHtml(closingLine(data))}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${friendLabel(data)} booked with your code.`, bodyHtml: body });
}

function text(data) {
  const amount = formatDollars(data.amountCents);
  const lines = [
    `Your ${amount} credit is in.`,
    '',
    `Hi ${data.firstName || 'there'},`,
    '',
    `${friendLabel(data)} booked with us using your referral code, so ${amount} in credit is now on your account. ${appliesLine(data)}`,
    '',
    `You can see your credit and send your code to another friend on the Refer a Friend tab: ${REFERRALS_URL}`,
    '',
    closingLine(data),
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

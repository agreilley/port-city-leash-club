// functions/templates/portal-reservation-confirmed.js
//
// Sent when admin confirms a pet-sitting reservation (check-in visits or an
// overnight stay) from confirmServiceRequest() or confirmOvernight() in
// admin/dashboard.html. Unlike portal-service-confirmed (the walk/pet-sitting
// email for services charged immediately at confirm time), this reservation
// type is NOT charged yet — confirming schedules the charge for 24 hours
// later (chargeScheduledFor on the overnights doc, run by
// chargeScheduledReservations) so the member has a real window to change
// plans before their card is touched. This email exists to make that window
// meaningful: it states the exact amount and the exact date the card will
// be charged, and for check-ins, the confirmed per-day visit schedule a
// member with an estimate-based request (e.g. "3 visits/day") needs to see
// spelled out before the charge goes through.
//
// data: {
//   firstName: string,
//   petNames: string[],
//   serviceLabel: string,          // e.g. "Drop-In Visit" | "Overnight Stay"
//   startDateStr: string,          // 'YYYY-MM-DD'
//   endDateStr: string,            // 'YYYY-MM-DD'
//   totalDollars: number,          // the confirmed price, before credits
//   creditApplied: number,         // account credit the charge takes (0 if none)
//   referralDiscountApplied: number, // new-member referral discount (0 if none)
//     // both previewed from the member's billing doc for a charge not yet
//     // run (previewChargeCredits), or what a charge that ran actually took
//   alreadyCharged: boolean,       // resend after the charge ran — past tense
//   chargeDateStr: string,         // 'YYYY-MM-DD' — matches chargeScheduledFor
//   chargeBeforeStart: boolean,    // charged 48h before the start date instead
//     // of 24h after confirming (CHARGE_48H_BEFORE_START_EMAILS) — says so
//   visitSchedule: array<{date: 'YYYY-MM-DD', visits: number}> | null,
//     // check-in only; null/absent for overnight stays — no per-day block rendered
//   addOnDropIns: array<{date: 'YYYY-MM-DD', visits: number}> | null,
//     // overnight stay only — paid drop-ins admin added; each listed as its
//     // own line item under the stay
//   order: { lines: [{label, detail?, amount}], total, totalLabel } | null,
//     // overnight stay only — itemized order (buildStayOrder); replaces the
//     // plain Service/Dates/Total rows when present
//   stayPlan: array<{date, visits: [{slot, extra}], overnight}> | null,
//     // overnight stay only — day-by-day plan from the booked visits
//   needsCard: boolean,            // true when there's no card on file yet —
//     // confirming no longer waits on one (finalizeSubmissionIfReady), so
//     // the charge-date sentence below would otherwise state a date/amount
//     // that was never actually scheduled
//   addCardUrl: string,            // portal-account.html's Update Payment Method flow; required when needsCard is true
//   isNewAccount: boolean,         // never signed in to the portal (portalSetupForMember) —
//   portalSetupLink: string|null,  //   this email is their welcome, so one set-password button replaces Add Your Card
// }

// The card / portal-setup paragraphs, shared by html() and text().
//   New client, no card: one button that sets their password, then lands on Add Card.
//   Existing client, no card: Add Your Card, plus how to get in without a password.
//   New client who somehow already has a card: a portal-setup button only.
function cardCopy(data) {
  const amount = fmtDollars(chargeDollars(data));
  const expired = `If the link has expired, go to the portal sign-in page and tap "Set Your Password" for a new one.`;
  if (data.isNewAccount && data.portalSetupLink) {
    return data.needsCard ? {
      paragraphs: [`Since this is your first booking with us, we've set up a portal account for you. Set your password, then add a card so we can process the ${amount} charge for this reservation.`],
      href: data.portalSetupLink, label: 'Set Up Your Portal', after: expired,
    } : {
      paragraphs: [`Since this is your first booking with us, we've set up a portal account for you, where you can see your booking and update your pet profiles.`],
      href: data.portalSetupLink, label: 'Set Up Your Portal', after: null,
    };
  }
  if (!data.needsCard) return { paragraphs: [], href: null, label: null, after: null };
  return {
    paragraphs: [`We don't have a card on file for you yet. Add one so we can process the ${amount} charge for this reservation.`],
    href: data.addCardUrl, label: 'Add Your Card',
    after: `You'll sign in to your portal first. If you haven't set a password yet, tap "Set Your Password" on the sign-in page.`,
  };
}

const {
  escapeHtml, formatDateRange, formatCalendarDate, joinNames, pluralNoun, possessive, TEAM_SIGNOFF, addOnDropInRows, stayPlanRows, stayPlanNote,
  renderOrderHtml, renderOrderText, renderScheduleHtml, renderScheduleText,
  renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

function fmtDollars(n) {
  return `$${(n || 0).toFixed(2)}`;
}

// formatCalendarDate returns null for anything that isn't a plain
// 'YYYY-MM-DD' string — degrades to the raw value rather than dropping the
// row entirely, same defensive posture formatDateRange already uses.
function visitScheduleRows(visitSchedule) {
  return (visitSchedule || []).map(d => ({
    label: formatCalendarDate(d.date) || d.date,
    value: `${d.visits} ${pluralNoun(d.visits, 'visit', 'visits')}`,
  }));
}

// What the card is (or was) charged: the order's total when there is one
// (it already has the credits taken off), else the price less credits.
function chargeDollars(data) {
  if (data.order) return data.order.total;
  const net = (data.totalDollars || 0) - (data.creditApplied || 0) - (data.referralDiscountApplied || 0);
  return Math.max(0, Math.round(net * 100) / 100);
}

function creditRows(data) {
  return [
    ...(data.referralDiscountApplied > 0 ? [{ label: 'Referral credit', value: `\u2212${fmtDollars(data.referralDiscountApplied)}` }] : []),
    ...(data.creditApplied > 0 ? [{ label: 'Account credit', value: `\u2212${fmtDollars(data.creditApplied)}` }] : []),
  ];
}

// Service/Dates/Total normally; with add-on drop-ins, one line item per
// service instead (the stay, then each drop-in day), then the Total. Any
// credits are listed under the Total, then what's actually charged.
function reservationRows(data) {
  const dropIns = addOnDropInRows(data.addOnDropIns);
  const head = dropIns.length
    ? [{ label: data.serviceLabel || 'Service', value: formatDateRange(data.startDateStr, data.endDateStr) }, ...dropIns]
    : [
      { label: 'Service', value: data.serviceLabel || '' },
      { label: 'Dates', value: formatDateRange(data.startDateStr, data.endDateStr) },
    ];
  const credits = creditRows(data);
  if (!credits.length) return [...head, { label: 'Total', value: fmtDollars(data.totalDollars) }];
  return [
    ...head,
    { label: 'Total', value: fmtDollars(data.totalDollars) },
    ...credits,
    { label: data.alreadyCharged ? 'Total charged' : 'Total to be charged', value: fmtDollars(chargeDollars(data)) },
  ];
}

function chargeSentence(data) {
  const date = formatCalendarDate(data.chargeDateStr) || data.chargeDateStr;
  return data.alreadyCharged
    ? `Your card was charged ${fmtDollars(chargeDollars(data))}${date ? ` on ${date}` : ''}.`
    : date && data.chargeBeforeStart ? `Your card will be charged ${fmtDollars(chargeDollars(data))} two days before your reservation starts, on ${date}.`
    : date ? `Your card will be charged ${fmtDollars(chargeDollars(data))} on ${date}.`
    : `Your card will be charged ${fmtDollars(chargeDollars(data))}.`;
}

// Same two lines portal-service-confirmed (the public form's old overnight
// email) always carried, so moving those bookings onto this email didn't
// lose them.
const ROUTINE_LINE = `We'll follow your usual routine for feeding, walks, and any medications, and we'll send you updates along the way so you can relax and enjoy your trip.`;
function closingLine(data) {
  const petCount = (data.petNames || []).filter(Boolean).length || 1;
  // A first booking has no earlier care details to have "changed" — same as walk-confirmed.
  if (data.isNewAccount) return `If you have any questions, just reply here and it'll come straight to us.`;
  return `If anything about your ${possessive(petCount, 'pet', 'pets')} care has changed, you can update their profile anytime in the portal. And if you have any questions, just reply here and it'll come straight to us.`;
}

function subject() {
  return 'Your pet sitting reservation is confirmed';
}

function html(data) {
  const names = joinNames(data.petNames) || 'your pets';

  // Overnight stays carry an itemized order (buildStayOrder); drop-in
  // reservations keep the plain Service/Dates/Total rows.
  const reservationBlock = data.order
    ? renderOrderHtml({ eyebrow: 'Your reservation', order: data.order })
    : renderBlockHtml({
      eyebrow: 'Your reservation',
      rows: reservationRows(data).map(r => ({ label: r.label, value: escapeHtml(r.value) })),
    });

  const scheduleBlock = Array.isArray(data.visitSchedule) && data.visitSchedule.length
    ? renderBlockHtml({ eyebrow: 'Visit schedule', rows: visitScheduleRows(data.visitSchedule).map(r => ({ label: r.label, value: escapeHtml(r.value) })) })
    : '';

  const planRows = stayPlanRows(data.stayPlan);
  const planSection = planRows.length ? `
    ${renderScheduleHtml({ eyebrow: 'Your schedule', stayPlan: data.stayPlan })}
    <p style="margin:20px 0 0;">${escapeHtml(stayPlanNote(data.addOnDropIns))}</p>
  ` : '';

  const card = cardCopy(data);
  const billingHtml = data.needsCard ? `
    ${card.paragraphs.map(p => `<p style="margin:20px 0 0;">${escapeHtml(p)}</p>`).join('')}
    ${renderButtonHtml({ href: card.href, label: card.label })}
    ${card.after ? `<p style="margin:20px 0 0;">${escapeHtml(card.after)}</p>` : ''}
    <p style="margin:20px 0 0;">If your plans change, reservations canceled within 48 hours of the start date may still be charged.</p>
  ` : `
    ${card.paragraphs.map(p => `<p style="margin:20px 0 0;">${escapeHtml(p)}</p>`).join('')}
    ${card.href ? renderButtonHtml({ href: card.href, label: card.label }) : ''}
    <p style="margin:20px 0 0;">${escapeHtml(chargeSentence(data))}</p>
    <p style="margin:20px 0 0;">If your plans change, reservations canceled within 48 hours of the start date may still be charged. This is the same policy that applies to scheduled walks.</p>
  `;

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Your pet sitting reservation for ${escapeHtml(names)} is confirmed. Here's what to expect.</p>
    ${reservationBlock}
    ${scheduleBlock}
    ${planSection}
    <p style="margin:20px 0 0;">${escapeHtml(ROUTINE_LINE)}</p>
    ${billingHtml}
    <p style="margin:20px 0 0;">${escapeHtml(closingLine(data))}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;

  return wrapHtml({
    preheader: `Your reservation is confirmed. Here's the schedule and when your card will be charged.`,
    bodyHtml: body,
  });
}

function text(data) {
  const names = joinNames(data.petNames) || 'your pets';

  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Your pet sitting reservation for ${names} is confirmed. Here's what to expect.`,
    '',
    data.order
      ? renderOrderText({ eyebrow: 'Your reservation', order: data.order })
      : renderBlockText({ eyebrow: 'Your reservation', rows: reservationRows(data) }),
    '',
  ];

  if (Array.isArray(data.visitSchedule) && data.visitSchedule.length) {
    lines.push(
      renderBlockText({ eyebrow: 'Visit schedule', rows: visitScheduleRows(data.visitSchedule) }),
      ''
    );
  }

  if (stayPlanRows(data.stayPlan).length) {
    lines.push(
      renderScheduleText({ eyebrow: 'Your schedule', stayPlan: data.stayPlan }),
      '',
      stayPlanNote(data.addOnDropIns),
      '',
    );
  }

  lines.push(ROUTINE_LINE, '');

  const card = cardCopy(data);
  if (data.needsCard) {
    lines.push(
      ...card.paragraphs.flatMap(p => [p, '']),
      `${card.label}: ${card.href}`,
      '',
      ...(card.after ? [card.after, ''] : []),
      `If your plans change, reservations canceled within 48 hours of the start date may still be charged.`,
      '',
    );
  } else {
    if (card.href) lines.push(...card.paragraphs.flatMap(p => [p, '']), `${card.label}: ${card.href}`, '');
    lines.push(
      chargeSentence(data),
      '',
      `If your plans change, reservations canceled within 48 hours of the start date may still be charged. This is the same policy that applies to scheduled walks.`,
      '',
    );
  }

  lines.push(
    closingLine(data),
    '',
    TEAM_SIGNOFF,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

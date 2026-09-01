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
//   serviceLabel: string,          // e.g. "Check-In Visit" | "Overnight Stay"
//   startDateStr: string,          // 'YYYY-MM-DD'
//   endDateStr: string,            // 'YYYY-MM-DD'
//   totalDollars: number,
//   chargeDateStr: string,         // 'YYYY-MM-DD' — matches chargeScheduledFor
//   visitSchedule: array<{date: 'YYYY-MM-DD', visits: number}> | null,
//     // check-in only; null/absent for overnight stays — no per-day block rendered
//   needsCard: boolean,            // true when there's no card on file yet —
//     // confirming no longer waits on one (finalizeSubmissionIfReady), so
//     // the charge-date sentence below would otherwise state a date/amount
//     // that was never actually scheduled
//   addCardUrl: string,            // portal-account.html's Update Payment Method flow; required when needsCard is true
// }

const {
  escapeHtml, formatDateRange, formatCalendarDate, joinNames, pluralNoun, TEAM_SIGNOFF,
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

function subject() {
  return 'Your pet sitting reservation is confirmed';
}

function html(data) {
  const names = joinNames(data.petNames) || 'your pets';

  const reservationBlock = renderBlockHtml({
    eyebrow: 'Your reservation',
    rows: [
      { label: 'Service', value: escapeHtml(data.serviceLabel || '') },
      { label: 'Dates', value: escapeHtml(formatDateRange(data.startDateStr, data.endDateStr)) },
      { label: 'Total', value: escapeHtml(fmtDollars(data.totalDollars)) },
    ],
  });

  const scheduleBlock = Array.isArray(data.visitSchedule) && data.visitSchedule.length
    ? renderBlockHtml({ eyebrow: 'Visit schedule', rows: visitScheduleRows(data.visitSchedule).map(r => ({ label: r.label, value: escapeHtml(r.value) })) })
    : '';

  const billingHtml = data.needsCard ? `
    <p style="margin:20px 0 0;">We don't have a card on file for you yet — add one so we can process the ${escapeHtml(fmtDollars(data.totalDollars))} charge for this reservation.</p>
    ${renderButtonHtml({ href: data.addCardUrl, label: 'Add Your Card' })}
  ` : `
    <p style="margin:20px 0 0;">Your card will be charged ${escapeHtml(fmtDollars(data.totalDollars))} on ${escapeHtml(formatCalendarDate(data.chargeDateStr) || data.chargeDateStr)}.</p>
    <p style="margin:20px 0 0;">If your plans change, reservations cancelled within 48 hours of the start date may still be charged. This is the same policy that applies to scheduled walks.</p>
  `;

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Your pet sitting reservation for ${escapeHtml(names)} is confirmed. Here's what to expect.</p>
    ${reservationBlock}
    ${scheduleBlock}
    ${billingHtml}
    <p style="margin:20px 0 0;">If you have any questions, just reply to this email.</p>
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
    renderBlockText({
      eyebrow: 'Your reservation',
      rows: [
        { label: 'Service', value: data.serviceLabel || '' },
        { label: 'Dates', value: formatDateRange(data.startDateStr, data.endDateStr) },
        { label: 'Total', value: fmtDollars(data.totalDollars) },
      ],
    }),
    '',
  ];

  if (Array.isArray(data.visitSchedule) && data.visitSchedule.length) {
    lines.push(
      renderBlockText({ eyebrow: 'Visit schedule', rows: visitScheduleRows(data.visitSchedule) }),
      ''
    );
  }

  if (data.needsCard) {
    lines.push(
      `We don't have a card on file for you yet — add one so we can process the ${fmtDollars(data.totalDollars)} charge for this reservation.`,
      '',
      `Add your card: ${data.addCardUrl}`,
      '',
    );
  } else {
    lines.push(
      `Your card will be charged ${fmtDollars(data.totalDollars)} on ${formatCalendarDate(data.chargeDateStr) || data.chargeDateStr}.`,
      '',
      `If your plans change, reservations cancelled within 48 hours of the start date may still be charged. This is the same policy that applies to scheduled walks.`,
      '',
    );
  }

  lines.push(
    `If you have any questions, just reply to this email.`,
    '',
    TEAM_SIGNOFF,
  );

  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

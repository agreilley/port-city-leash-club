// functions/templates/walk-reschedule-update.js
//
// Sent when admin approves or declines a member's reschedule request
// (approveReschedule / declineReschedule in admin/dashboard.html, via the
// sendRescheduleDecisionEmail callable). Before this, neither outcome
// notified the member — an approved move only showed up if they happened
// to check their portal calendar, and there was no decline at all.
//
// A decline leaves the original walk exactly where it was, so unlike
// request-declined.js (a one-time booking that isn't happening) this says
// the walk is still on and invites a reply to find another time.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   approved: boolean,
//   originalDateStr: string|null,  // 'YYYY-MM-DD'; null on a decline of a request with no walk attached
//   originalSlot: string|null,     // timeSlot bucket key ('morning', ...)
//   newDateStr: string|null,       // approved: the walk's new date; declined: the date they asked for
//   newSlot: string|null,          // bucket key, or the member-facing label the request stored ('Morning')
//   calendarUrl: string,
// }

const {
  escapeHtml, formatCalendarDate, formatWalkTimeSlot, joinNames, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// Reschedule submissions store the portal's label ('Early Afternoon') rather
// than the bucket key, so try it as a key both ways before falling back to
// the stored text as-is.
async function slotLabel(slot) {
  if (!slot) return null;
  const key = String(slot).trim().toLowerCase().replace(/\s+/g, '-');
  return (await formatWalkTimeSlot(slot)) || (await formatWalkTimeSlot(key)) || String(slot);
}

async function when(dateStr, slot) {
  const d = formatCalendarDate(dateStr);
  const s = await slotLabel(slot);
  if (!d) return s || 'Date to be confirmed';
  return s ? `${d}, ${s.toLowerCase()}` : d; // "Saturday, October 3, late afternoon" — same as walk-confirmed
}

function subject(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  return data.approved
    ? `${names}'s walk has been rescheduled`
    : `About your reschedule request for ${names}`;
}

async function content(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const original = await when(data.originalDateStr, data.originalSlot);
  const requested = await when(data.newDateStr, data.newSlot);
  if (data.approved) {
    return {
      intro: `You're all set. We've rescheduled ${names}'s walk.`,
      eyebrow: 'Rescheduled walk',
      rows: [
        { label: 'New time', value: requested },
        { label: 'Original time', value: original },
      ],
      outro: `You'll see the change on your calendar in the portal.`,
      preheader: `${names}'s walk is now ${requested}.`,
    };
  }
  // No original date = a request that never had a walk attached (sent
  // before the reschedule page had its walk picker), so there's no single
  // walk to say is "still scheduled".
  const hasOriginal = !!data.originalDateStr;
  return {
    intro: hasOriginal
      ? `We weren't able to move ${names}'s walk to the time you asked for, so it's staying on its original date for now.`
      : `We weren't able to process your reschedule request for ${names}, so your walks are staying as scheduled for now.`,
    eyebrow: hasOriginal ? 'Your walk' : 'Your request',
    rows: [
      hasOriginal ? { label: 'Still scheduled', value: original } : null,
      { label: 'You asked for', value: requested },
    ].filter(Boolean),
    outro: `Just reply to this email and we'll find another time that works.`,
    preheader: hasOriginal ? `${names}'s walk is still on for ${original}.` : `An update on your reschedule request for ${names}.`,
  };
}

async function html(data) {
  const c = await content(data);
  const block = renderBlockHtml({
    eyebrow: c.eyebrow,
    rows: c.rows.map(r => ({ label: r.label, value: escapeHtml(r.value) })),
  });
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(c.intro)}</p>
    ${block}
    <p style="margin:20px 0 0;">${escapeHtml(c.outro)}</p>
    ${renderButtonHtml({ href: data.calendarUrl, label: 'View Your Calendar' })}
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: c.preheader, bodyHtml: body });
}

async function text(data) {
  const c = await content(data);
  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    c.intro,
    '',
    renderBlockText({ eyebrow: c.eyebrow, rows: c.rows }),
    '',
    c.outro,
    '',
    `View your calendar: ${data.calendarUrl}`,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

// functions/templates/monthly-schedule-reminder.js
//
// Sent on the 25th of each month by sendMonthlyScheduleReminders
// (functions/index.js) to every subscribed Member-tier member who has walks
// scheduled next month. Next month's walks already exist by then
// (generateMonthlyWalks creates them a full month ahead, on the 1st), so this
// lists the real dates, not a projection, and points the member at the portal
// to move a walk or change their days before the 1st, when the month is billed.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   monthLabel: string,        // 'November'
//   billingDateLabel: string,  // 'November 1'
//   walks: [{ dateStr: 'YYYY-MM-DD', slot: string|null }], // sorted, at least one
//   calendarUrl: string,       // portal-dashboard
//   rescheduleUrl: string,     // portal-reschedule
//   scheduleUrl: string,       // portal-account (walk days / time slot)
// }

const {
  escapeHtml, formatWalkTimeSlot, joinNames, pluralNoun, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// "2026-11-04" -> "Wed, Nov 4". Built from the components, not new Date(str),
// so there's no timezone-driven day shift (same reasoning as formatCalendarDate).
function shortDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// One shared time line when every walk is in the same slot (the normal case);
// otherwise the slot moves onto each date instead.
async function scheduleRows(data) {
  const walks = data.walks || [];
  const labels = await Promise.all(walks.map(w => formatWalkTimeSlot(w.slot)));
  const distinct = [...new Set(labels.filter(Boolean))];
  const sameSlot = distinct.length <= 1;
  const dates = walks.map((w, i) => (sameSlot || !labels[i]) ? shortDate(w.dateStr) : `${shortDate(w.dateStr)} (${labels[i]})`);
  return {
    count: `${walks.length} ${pluralNoun(walks.length, 'walk', 'walks')}`,
    time: sameSlot ? (distinct[0] || null) : null,
    dates,
  };
}

function subject(data) {
  return `Your ${data.monthLabel} walk schedule`;
}

async function html(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const r = await scheduleRows(data);
  const block = renderBlockHtml({
    eyebrow: `${data.monthLabel} walks`,
    heading: escapeHtml(r.count),
    rows: [
      r.time ? { label: 'Time', value: escapeHtml(r.time) } : null,
      { label: 'Dates', value: r.dates.map(escapeHtml).join('<br>') },
    ],
  });

  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">Here's ${escapeHtml(names)}'s walk schedule for ${escapeHtml(data.monthLabel)}. Take a quick look and make any changes before the month starts.</p>
    ${block}
    <p style="margin:0 0 12px;"><strong>Need to move a walk?</strong> <a href="${escapeHtml(data.rescheduleUrl)}" style="color:inherit;">Request a reschedule</a> from your portal at least 48 hours ahead.</p>
    <p style="margin:0 0 12px;"><strong>Want different days or a different time going forward?</strong> <a href="${escapeHtml(data.scheduleUrl)}" style="color:inherit;">Update your walk schedule</a> in your account settings.</p>
    <p style="margin:0;">Your membership is billed on ${escapeHtml(data.billingDateLabel)} for the walks scheduled in ${escapeHtml(data.monthLabel)}.</p>
    ${renderButtonHtml({ href: data.calendarUrl, label: 'Review Your Calendar' })}
    <p style="margin:0;">Questions? Just reply here and it'll come straight to us.</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `${r.count} scheduled for ${data.monthLabel}. Review and make changes before the 1st.`, bodyHtml: body });
}

async function text(data) {
  const names = joinNames(data.dogNames) || 'your dog';
  const r = await scheduleRows(data);
  const lines = [
    `Hi ${data.firstName || 'there'},`,
    '',
    `Here's ${names}'s walk schedule for ${data.monthLabel}. Take a quick look and make any changes before the month starts.`,
    '',
    renderBlockText({
      eyebrow: `${data.monthLabel} walks`,
      heading: r.count,
      rows: [r.time ? { label: 'Time', value: r.time } : null, { label: 'Dates', value: '' }],
    }),
    ...r.dates.map(d => `  ${d}`),
    '',
    `Need to move a walk? Request a reschedule from your portal at least 48 hours ahead: ${data.rescheduleUrl}`,
    '',
    `Want different days or a different time going forward? Update your walk schedule in your account settings: ${data.scheduleUrl}`,
    '',
    `Your membership is billed on ${data.billingDateLabel} for the walks scheduled in ${data.monthLabel}.`,
    '',
    `Review your calendar: ${data.calendarUrl}`,
    '',
    `Questions? Just reply here and it'll come straight to us.`,
    '',
    TEAM_SIGNOFF,
  ];
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

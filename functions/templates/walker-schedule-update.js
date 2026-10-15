// functions/templates/walker-schedule-update.js
//
// Sent at 5pm ET by sendWalkerAssignmentDigests (functions/index.js) to each
// walker whose schedule changed since the last update: reservations newly
// assigned to them (walks, drop-in visits, overnight nights, their own or a
// cover), and reservations taken off their schedule (reassigned, canceled,
// or deleted). A walker with no changes gets no email.
//
// Walker-facing, so written in Alison's walker voice and signed by her:
// plain, no exclamation points, "clients", "pet sitting". Grouped by client
// so a new regular's month of walks reads as one card, not a wall of lines.
// The closing deliberately only invites questions, not "let me know if this
// doesn't work", which read as an invitation to turn work down.
//
// data: {
//   firstName: string,
//   added: [Client],      // newly assigned; may be empty
//   removed: [Client],    // taken off their schedule; may be empty (not both)
//   dashboardUrl: string, // walker dashboard
// }
// Client: {
//   clientName: string,
//   dogNames: string[],
//   items: [{ dateStr: 'YYYY-MM-DD', kind: 'walk'|'visit'|'night', slot: string|null }], // sorted
// }                       // clients sorted by first date

const {
  NAVY, SAND, BODY_FONT, HEADING_FONT, SIGNOFF_NAME,
  escapeHtml, joinNames,
  renderButtonHtml, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// Mirrors VISIT_SLOT_LABELS/RANGES (visit-slots.js) and the walk slot
// labels/ranges (time-slots.js), lowercased for prose. Those are ES modules
// these CommonJS templates can't require synchronously.
const WALK_SLOTS = { morning: 'morning (8–11am)', 'early-afternoon': 'early afternoon (11am–2pm)', 'late-afternoon': 'late afternoon (2–5pm)' };
const VISIT_SLOTS = { morning: 'morning (7–9am)', midday: 'midday (12–3pm)', evening: 'evening (4–7pm)', 'last-out': 'last out (8–10pm)' };

// "2026-11-04" -> "Wed, Nov 4", built from the components so there's no
// timezone day shift.
function shortDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function itemText(item) {
  if (item.kind === 'night') return 'Overnight';
  if (item.kind === 'visit') return VISIT_SLOTS[item.slot] ? `Drop-in visit, ${VISIT_SLOTS[item.slot]}` : 'Drop-in visit';
  return WALK_SLOTS[item.slot] ? `Walk, ${WALK_SLOTS[item.slot]}` : 'Walk';
}

// One row per item, date repeated, so a drop-in visit and the overnight
// on the same day read as two separate lines (Alison's call, 2026-10-15).
function clientRows(client) {
  return (client.items || []).map((item) => ({ label: shortDate(item.dateStr), text: itemText(item) }));
}

function itemCount(clients) {
  return (clients || []).reduce((sum, c) => sum + (c.items || []).length, 0);
}

function subject(data) {
  const added = itemCount(data.added);
  const removed = itemCount(data.removed);
  if (added && removed) return 'New reservations and a change to your schedule';
  if (added) return "You've been assigned new reservations";
  return 'A change to your schedule';
}

// Plain-text copy, shared by html() and text() so the two can't drift.
function copy(data) {
  const added = itemCount(data.added);
  const removed = itemCount(data.removed);
  return {
    addedIntro: "You've been assigned the reservations below. Everything is also on your dashboard.",
    removedIntro: added
      ? `${removed === 1 ? 'This has' : 'These have'} also been taken off your schedule:`
      : `${removed === 1 ? 'This has' : 'These have'} been taken off your schedule:`,
    outro: 'If you have any questions, just reply to this email.',
    preheader: added
      ? "You've been assigned new reservations. Everything is also on your dashboard."
      : 'Something has been taken off your schedule.',
  };
}

function clientCardHtml(client) {
  const dogs = joinNames(client.dogNames);
  const rows = clientRows(client).map((row, i) => `
            <tr>
              <td width="88" style="padding:${i ? '12px' : '0'} 12px 12px 0;${i ? 'border-top:1px solid rgba(13,27,42,0.12);' : ''}font-family:${BODY_FONT};font-size:14px;font-weight:700;line-height:1.5;color:${NAVY};vertical-align:top;white-space:nowrap;">${escapeHtml(row.label)}</td>
              <td style="padding:${i ? '12px' : '0'} 0 12px;${i ? 'border-top:1px solid rgba(13,27,42,0.12);' : ''}font-family:${BODY_FONT};font-size:14px;line-height:1.5;color:${NAVY};vertical-align:top;">
                ${escapeHtml(row.text)}
              </td>
            </tr>`).join('');
  return `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${SAND};border-radius:4px;margin:0 0 16px;">
      <tr>
        <td style="padding:24px;">
          <p style="margin:0 0 4px;font-family:${BODY_FONT};font-size:12px;font-weight:500;letter-spacing:0.08em;text-transform:uppercase;color:${NAVY};">${escapeHtml(client.clientName || 'Client')}</p>
          ${dogs ? `<p style="margin:0 0 16px;font-family:${HEADING_FONT};font-weight:400;font-size:24px;line-height:1.2;color:${NAVY};">${escapeHtml(dogs)}</p>` : ''}
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}
          </table>
        </td>
      </tr>
    </table>
  `;
}

function html(data) {
  const c = copy(data);
  const added = data.added || [];
  const removed = data.removed || [];
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    ${added.length ? `<p style="margin:0 0 28px;">${escapeHtml(c.addedIntro)}</p>${added.map(clientCardHtml).join('')}` : ''}
    ${removed.length ? `<p style="margin:${added.length ? '28px' : '0'} 0 28px;">${escapeHtml(c.removedIntro)}</p>${removed.map(clientCardHtml).join('')}` : ''}
    ${renderButtonHtml({ href: data.dashboardUrl, label: 'Open your dashboard' })}
    <p style="margin:0;">${escapeHtml(c.outro)}</p>
    ${renderSignoffHtml(SIGNOFF_NAME, 'Thanks so much.')}
  `;
  return wrapHtml({ preheader: c.preheader, bodyHtml: body });
}

function clientText(client) {
  const name = (client.clientName || 'Client').toUpperCase();
  const dogs = joinNames(client.dogNames);
  const lines = [dogs ? `${name} (${dogs})` : name];
  clientRows(client).forEach((row) => lines.push(`  ${row.label}: ${row.text}`));
  lines.push('');
  return lines;
}

function text(data) {
  const c = copy(data);
  const lines = [`Hi ${data.firstName || 'there'},`, ''];
  if ((data.added || []).length) {
    lines.push(c.addedIntro, '');
    data.added.forEach((client) => lines.push(...clientText(client)));
  }
  if ((data.removed || []).length) {
    lines.push(c.removedIntro, '');
    data.removed.forEach((client) => lines.push(...clientText(client)));
  }
  lines.push(`Open your dashboard: ${data.dashboardUrl}`, '', c.outro, '', 'Thanks so much.', SIGNOFF_NAME);
  return wrapText({ bodyText: lines.join('\n') });
}

module.exports = { subject, html, text };

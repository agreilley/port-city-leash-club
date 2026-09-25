// functions/templates/walk-extension-declined.js
//
// Sent when admin declines a walk_extension request (declineWalkExtension in
// admin/dashboard.html, via the sendWalkExtensionDeclinedEmail callable).
// Before this, a decline notified nobody: the member got "We got your
// request" (portal-walk-request-received) and then their walk quietly went
// back to 30 minutes. Nothing is ever charged for an extension until it's
// confirmed, so "you haven't been charged" is always true here.
//
// data: {
//   firstName: string,
//   dogNames: string[],
//   walks: [{ dateStr: 'YYYY-MM-DD', slot: string|null }], // at least one
// }

const {
  escapeHtml, formatCalendarDate, formatWalkTimeSlot, joinNames, TEAM_SIGNOFF,
  renderBlockHtml, renderBlockText, renderSignoffHtml, wrapHtml, wrapText,
} = require('./_layout');

// Same "Saturday, October 17, late afternoon" form as walk-confirmed.js.
async function whenLines(data) {
  const lines = await Promise.all((data.walks || []).map(async (w) => {
    const d = formatCalendarDate(w.dateStr);
    if (!d) return null;
    const slot = await formatWalkTimeSlot(w.slot);
    return slot ? `${d}, ${slot.toLowerCase()}` : d;
  }));
  return lines.filter(Boolean);
}

function subject(data) {
  return `About your extended walk request for ${joinNames(data.dogNames) || 'your dog'}`;
}

function copy(data, count) {
  const names = joinNames(data.dogNames) || 'your dog';
  const many = count > 1;
  return {
    intro: `Thanks for asking about extending ${names}'s ${many ? 'walks' : 'walk'}. Unfortunately we can't fit in the extra time this time around, but ${many ? 'their regular 30-minute walks are' : 'their regular 30-minute walk is'} still on as planned.`,
    eyebrow: many ? 'Your walks' : 'Your walk',
    outro: `You haven't been charged for the extension. If another day would work better, just reply here and we'll see what we can do.`,
  };
}

async function html(data) {
  const lines = await whenLines(data);
  const c = copy(data, lines.length);
  const block = renderBlockHtml({
    eyebrow: c.eyebrow,
    rows: [{ label: 'When', value: lines.map(escapeHtml).join('<br>') || 'As scheduled' }],
  });
  const body = `
    <p style="margin:0 0 20px;">Hi ${escapeHtml(data.firstName || 'there')},</p>
    <p style="margin:0 0 20px;">${escapeHtml(c.intro)}</p>
    ${block}
    <p style="margin:20px 0 0;">${escapeHtml(c.outro)}</p>
    ${renderSignoffHtml(TEAM_SIGNOFF)}
  `;
  return wrapHtml({ preheader: `An update on your extended walk request.`, bodyHtml: body });
}

async function text(data) {
  const lines = await whenLines(data);
  const c = copy(data, lines.length);
  return wrapText({
    bodyText: [
      `Hi ${data.firstName || 'there'},`,
      '',
      c.intro,
      '',
      renderBlockText({ eyebrow: c.eyebrow, rows: [{ label: 'When', value: lines.length > 1 ? '' : (lines[0] || 'As scheduled') }] }),
      ...(lines.length > 1 ? lines.map(l => `  ${l}`) : []),
      '',
      c.outro,
      '',
      TEAM_SIGNOFF,
    ].join('\n'),
  });
}

module.exports = { subject, html, text };

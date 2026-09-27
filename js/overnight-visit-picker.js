// overnight-visit-picker.js — the "Drop-In Visits" picker on both overnight
// request forms (service-request.html, portal-request-extras.html).
//
// Every night of a stay comes with one drop-in visit. Rather than making the
// customer fill in an "included" grid and a separate "extra" grid, they set
// one number per day — the total visits they want that day — and the picker
// labels them: the first N visits in date order (N = nights) are Included,
// anything past that is Extra at the drop-in price. Defaults match admin's
// Included Drop-In Visits grid: one visit per day, zero on the return day.
//
// split() turns that into the two lists admin's review screen seeds its two
// grids from (admin/dashboard.html): requestedIncludedDropIns (every day,
// zeros included, so admin's defaults don't refill a day the customer
// cleared) and requestedAddOnDropIns (only days with extras — priced by
// pricing.js calculateAddOnDropInTotal). Times are never asked for here;
// admin picks them after the meet & greet.

import { SERVICE_PRICES } from '/pricing.js';

const MAX_PER_DAY = 6;
const STYLE_ID = 'ovp-styles';
const CSS = `
.ovp-note { font-size: 13px; color: #7A7A7A; margin: 0 0 6px; line-height: 1.5; }
.ovp-meter { font-size: 13px; font-weight: 500; color: #7A7A7A; margin-bottom: 2px; }
.ovp-meter.done { color: #2D6A40; }
.ovp-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 10px 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
.ovp-day { font-size: 14px; }
.ovp-day small { color: #9A9A9A; font-size: 12px; }
.ovp-tags { margin-top: 4px; display: flex; flex-wrap: wrap; gap: 4px; }
.ovp-tag { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 4px; }
.ovp-tag.inc { background: #EBF5EF; color: #2D6A40; }
.ovp-tag.ext { background: #FEF3C7; color: #92400E; }
.ovp-none { font-size: 12px; color: #9A9A9A; }
.ovp-step { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.ovp-step button { width: 34px; height: 34px; border: 1px solid rgba(0,0,0,0.15); border-radius: 6px; background: white; font-size: 18px; line-height: 1; color: #0D1B2A; cursor: pointer; padding: 0; font-family: inherit; }
.ovp-step button:disabled { opacity: 0.35; cursor: default; }
.ovp-step span { min-width: 16px; text-align: center; font-size: 15px; font-weight: 500; }
`;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.appendChild(el);
}

function dayLabel(d) {
  return new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

// field: the wrapper to show/hide. container: where the rows render.
// onChange: called after any count change (the page recomputes its summary).
export function createOvernightVisitPicker({ field, container, onChange }) {
  ensureStyles();
  let dates = [];
  let counts = {};

  const nights = () => Math.max(dates.length - 1, 0);

  function split() {
    let remaining = nights();
    const included = [];
    const extras = [];
    dates.forEach(d => {
      const total = counts[d] || 0;
      const inc = Math.min(total, remaining);
      remaining -= inc;
      included.push({ date: d, visits: inc });
      if (total > inc) extras.push({ date: d, visits: total - inc });
    });
    return { included, extras, nights: nights(), placed: nights() - remaining };
  }

  function render() {
    const n = nights();
    const price = SERVICE_PRICES['drop-in-visit'].price;
    const { placed } = split();
    let left = n;
    const rows = dates.map((d, i) => {
      const total = counts[d] || 0;
      let tags = '';
      for (let k = 0; k < total; k++) {
        if (left > 0) { tags += '<span class="ovp-tag inc">Included</span>'; left--; }
        else tags += `<span class="ovp-tag ext">Extra +$${price}</span>`;
      }
      const hint = i === 0 ? ' <small>(start)</small>' : i === dates.length - 1 ? ' <small>(return day)</small>' : '';
      return `<div class="ovp-row">
        <div>
          <div class="ovp-day">${dayLabel(d)}${hint}</div>
          <div class="ovp-tags">${tags || '<span class="ovp-none">No visits</span>'}</div>
        </div>
        <div class="ovp-step">
          <button type="button" data-date="${d}" data-delta="-1" aria-label="Remove a visit on ${dayLabel(d)}" ${total <= 0 ? 'disabled' : ''}>&minus;</button>
          <span>${total}</span>
          <button type="button" data-date="${d}" data-delta="1" aria-label="Add a visit on ${dayLabel(d)}" ${total >= MAX_PER_DAY ? 'disabled' : ''}>+</button>
        </div>
      </div>`;
    }).join('');
    const plural = n === 1 ? '' : 's';
    container.innerHTML = `
      <p class="ovp-note">Your ${n} night${plural} come${n === 1 ? 's' : ''} with ${n} drop-in visit${plural}. Put them on the days you need. Any beyond that are $${price} each. We'll confirm the times with you.</p>
      <div class="ovp-meter${placed === n ? ' done' : ''}">${placed} of ${n} included visit${plural} placed</div>
      ${rows}`;
  }

  container.addEventListener('click', e => {
    const btn = e.target.closest('button[data-date]');
    if (!btn || btn.disabled) return;
    const d = btn.dataset.date;
    counts[d] = Math.min(MAX_PER_DAY, Math.max(0, (counts[d] || 0) + Number(btn.dataset.delta)));
    render();
    onChange?.();
  });

  // Rebuilds the day list for a new date range, keeping counts already set
  // for days still in it. Hides the field until there's at least one night.
  function sync(startStr, endStr) {
    if (!startStr || !endStr || endStr <= startStr) {
      reset();
      return;
    }
    const next = [];
    const cursor = new Date(`${startStr}T12:00:00`);
    const end = new Date(`${endStr}T12:00:00`);
    while (cursor <= end) {
      next.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }
    const last = next[next.length - 1];
    const prevLast = dates[dates.length - 1];
    const nextCounts = {};
    next.forEach(d => {
      // Pages call sync() on every summary refresh, so an unchanged range
      // must keep every count as-is. When the range changes, days already
      // set keep their count — except the old return day turning into a
      // mid-stay day, which gets the mid-stay default of 1 rather than
      // staying at the return day's 0.
      const wasOldReturnDay = d === prevLast && d !== last;
      nextCounts[d] = counts[d] !== undefined && !wasOldReturnDay ? counts[d] : (d === last ? 0 : 1);
    });
    dates = next;
    counts = nextCounts;
    field.style.display = 'flex';
    render();
  }

  function reset() {
    dates = [];
    counts = {};
    field.style.display = 'none';
    container.innerHTML = '';
  }

  return { sync, split, reset };
}

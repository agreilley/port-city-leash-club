// visit-time-picker.js — the drop-in picker on both pet-sitting request forms
// (service-request.html, portal-request-extras.html). Replaced the per-day
// counts (js/overnight-visit-picker.js and each page's own grid) 2026-11-24.
//
// Customers tap time-of-day NAMES for each day; how many they tap is how many
// visits they get. Hours are never shown: admin and walkers see the window
// behind each name (visit-slots.js), customers only the name.
//
//   mode 'dropin'    — all five names, nothing selected to start.
//   mode 'overnight' — Midday, Afternoon and Evening only (the 12-hour night
//     covers bedtime and morning; admin can still add either). Midday is
//     selected to start on every day but the return day. Every night comes
//     with one drop-in: N visits are Included (N = nights), one per day first
//     and then any left over in date order. The rest are Extra at the drop-in
//     price.
//
// A request, not a booking: admin's review screen pre-fills from it and
// everything can change before confirming.

import { SERVICE_PRICES } from '/pricing.js';
import { VISIT_SLOTS, VISIT_SLOT_LABELS } from '/visit-slots.js';

const OVERNIGHT_SLOTS = ['midday', 'afternoon', 'evening'];
const STYLE_ID = 'vtp-styles';
const CSS = `
.vtp-note { font-size: 13px; color: #7A7A7A; margin: 0 0 8px; line-height: 1.5; }
.vtp-meter { font-size: 13px; font-weight: 500; color: #7A7A7A; margin-bottom: 2px; }
.vtp-meter.done { color: #2D6A40; }
.vtp-day { padding: 12px 0; border-bottom: 1px solid rgba(0,0,0,0.06); }
.vtp-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 8px; font-size: 14px; }
.vtp-head small { color: #7A7A7A; font-size: 12px; }
.vtp-count { font-size: 12px; color: #7A7A7A; text-align: right; }
.vtp-count .extra { color: #92400E; font-weight: 500; }
.vtp-slots { display: flex; flex-wrap: wrap; gap: 8px; }
.vtp-slots button { min-height: 40px; padding: 8px 14px; border: 1px solid rgba(0,0,0,0.18); border-radius: 20px; background: white; color: #0D1B2A; font-family: inherit; font-size: 14px; cursor: pointer; }
.vtp-slots button[aria-pressed="true"] { background: #0D1B2A; border-color: #0D1B2A; color: white; }
.vtp-copy { margin-top: 10px; padding: 0; border: 0; background: none; color: #0D1B2A; font-family: inherit; font-size: 13px; text-decoration: underline; cursor: pointer; }
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

const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;

// field: the wrapper to show/hide. container: where the rows render.
// onChange: called after any change (the page recomputes its summary).
export function createVisitTimePicker({ field, container, mode, onChange }) {
  ensureStyles();
  const overnight = mode === 'overnight';
  const options = overnight ? OVERNIGHT_SLOTS : VISIT_SLOTS;
  let dates = [];
  let picks = {}; // 'YYYY-MM-DD' -> [slot], in time order

  const nights = () => Math.max(dates.length - 1, 0);
  const total = () => dates.reduce((n, d) => n + picks[d].length, 0);

  // [{ date, visits, slots }], every day of the range (zeros included).
  function schedule() {
    return dates.map(date => ({ date, visits: picks[date].length, slots: [...picks[date]] }));
  }

  // { 'YYYY-MM-DD': visits } for calculateDropInScheduleTotal (pricing.js).
  function counts() {
    return Object.fromEntries(dates.map(d => [d, picks[d].length]));
  }

  // Overnight only: the same days split into each night's included visit and
  // the paid extras. Included lists every day, zeros too, so admin's grid
  // doesn't refill a day the customer cleared; extras only days that have one.
  function split() {
    let left = nights();
    const days = schedule();
    // One included visit per day first, then any left over in date order.
    const inc = days.map(d => { const n = d.visits && left ? 1 : 0; left -= n; return n; });
    days.forEach((d, i) => { const n = Math.min(d.visits - inc[i], left); inc[i] += n; left -= n; });
    const part = (d, slots) => ({ date: d.date, visits: slots.length, slots });
    const included = days.map((d, i) => part(d, d.slots.slice(0, inc[i])));
    const extras = days.map((d, i) => part(d, d.slots.slice(inc[i]))).filter(d => d.visits);
    return { included, extras, nights: nights(), placed: nights() - left };
  }

  function render() {
    const price = SERVICE_PRICES['drop-in-visit'].price;
    const { included, extras, placed } = split();
    const n = nights();
    const rows = dates.map((d, i) => {
      const last = i === dates.length - 1;
      const hint = !overnight ? '' : i === 0 ? ' <small>(start)</small>' : last ? ' <small>(return day)</small>' : '';
      const inc = included[i].visits;
      const ext = extras.find(e => e.date === d)?.visits || 0;
      const count = !picks[d].length ? 'No visits'
        : !overnight ? plural(picks[d].length, 'visit')
        : [inc && `${inc} included`, ext && `<span class="extra">${ext} extra +$${ext * price}</span>`].filter(Boolean).join(', ');
      const buttons = options.map(s => `<button type="button" data-date="${d}" data-slot="${s}" aria-pressed="${picks[d].includes(s)}">${VISIT_SLOT_LABELS[s]}</button>`).join('');
      const copy = i === 0 && dates.length > (overnight ? 2 : 1)
        ? `<button type="button" class="vtp-copy" data-copy>${overnight ? 'Use for every day before the return day' : 'Use for every day'}</button>` : '';
      return `<div class="vtp-day" role="group" aria-label="${dayLabel(d)}">
        <div class="vtp-head"><span>${dayLabel(d)}${hint}</span><span class="vtp-count">${count}</span></div>
        <div class="vtp-slots">${buttons}</div>${copy}
      </div>`;
    }).join('');
    const match = "We'll do our best to match these times and confirm them with you.";
    const note = overnight
      ? `Your ${plural(n, 'night')} come${n === 1 ? 's' : ''} with ${plural(n, 'drop-in visit')}. Choose the days and times you need. Any beyond that are $${price} each. ${match}`
      : `Choose when you'd like a visit each day. Visits are $${price} each. ${match}`;
    container.innerHTML = `<p class="vtp-note">${note}</p>
      ${overnight ? `<div class="vtp-meter${placed === n ? ' done' : ''}">${placed} of ${plural(n, 'included visit')} placed</div>` : ''}
      ${rows}`;
  }

  container.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-copy')) {
      const targets = overnight ? dates.slice(0, -1) : dates;
      targets.forEach(d => { picks[d] = [...picks[dates[0]]]; });
    } else {
      const { date, slot } = btn.dataset;
      if (!picks[date]) return;
      const on = new Set(picks[date]);
      if (on.has(slot)) on.delete(slot); else on.add(slot);
      picks[date] = VISIT_SLOTS.filter(s => on.has(s));
    }
    const focus = btn.hasAttribute('data-copy') ? '[data-copy]' : `[data-date="${btn.dataset.date}"][data-slot="${btn.dataset.slot}"]`;
    render();
    container.querySelector(focus)?.focus({ preventScroll: true });
    onChange?.();
  });

  // Rebuilds the day list for a new date range, keeping what's already set
  // for days still in it. Pages call this on every summary refresh, so an
  // unchanged range must change nothing. Hides the field until the range is
  // valid (an overnight needs at least one night).
  function sync(startStr, endStr) {
    if (!startStr || !endStr || endStr < startStr || (overnight && endStr === startStr)) { reset(); return; }
    const next = [];
    const cursor = new Date(`${startStr}T12:00:00`);
    const end = new Date(`${endStr}T12:00:00`);
    while (cursor <= end) {
      next.push(cursor.toISOString().slice(0, 10));
      cursor.setDate(cursor.getDate() + 1);
    }
    if (dates.length && next.join() === dates.join()) { field.style.display = 'flex'; return; }
    const last = next[next.length - 1];
    const prevLast = dates[dates.length - 1];
    const nextPicks = {};
    next.forEach(d => {
      // The old return day turning into a mid-stay day takes the mid-stay
      // default rather than staying empty.
      const keep = picks[d] !== undefined && !(overnight && d === prevLast && d !== last && !picks[d].length);
      nextPicks[d] = keep ? picks[d] : (overnight && d !== last ? ['midday'] : []);
    });
    dates = next;
    picks = nextPicks;
    field.style.display = 'flex';
    render();
  }

  function reset() {
    dates = [];
    picks = {};
    field.style.display = 'none';
    container.innerHTML = '';
  }

  return { sync, reset, schedule, counts, total, split };
}

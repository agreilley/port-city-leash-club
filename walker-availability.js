// walker-availability.js
// A walker's weekly availability, hour by hour — walkers/{id}.hourlyAvailability
// ({ mon: [7, 8, 13, ...], ... }), each number the START of a one-hour
// block they're free for (7 = 7–8am, 21 = 9–10pm). Walkers fill it in once
// from their dashboard (submitWalkerAvailability, functions/index.js); after
// that only admin changes it (walker detail modal, admin/dashboard.html).
//
// The older walk-slot field, walkers/{id}.availability ({ mon: ['morning',
// ...] }), still drives walk suggestions and the admin Availability tab.
// Once hourly availability exists it's DERIVED from it (walkSlotsFromHours)
// on every save, so those readers keep working unchanged.
//
// MIRRORED INTO functions/walker-availability.js by firebase.json's
// predeploy hook — edit here, never there.

import { WALK_TIME_SLOTS, WALK_TIME_SLOT_RANGES } from './time-slots.js';
import { VISIT_SLOT_RANGES } from './visit-slots.js';

export const AVAILABILITY_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const AVAILABILITY_DAY_LABELS = {
  mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

// 7am through 10pm — late enough to cover Last Out drop-ins (8–10pm).
export const AVAILABILITY_HOURS = Array.from({ length: 15 }, (_, i) => 7 + i);

// 7 -> "7am", 12 -> "12pm", 21 -> "9pm"
export function hourLabel(h) {
  const n = h % 12 === 0 ? 12 : h % 12;
  return `${n}${h < 12 ? 'am' : 'pm'}`;
}

// "7–8am" style label for the one-hour block starting at h.
export function hourBlockLabel(h) {
  const a = hourLabel(h), b = hourLabel(h + 1);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -2)}–${b}` : `${a}–${b}`;
}

// A range string like "8–11am", "11am–2pm", "12–3pm" -> the start hours of
// the one-hour blocks it spans, e.g. "12–3pm" -> [12, 13, 14]. Parsed from
// the same strings the calendars show, so changing a window in
// time-slots.js / visit-slots.js can't leave availability checks behind.
export function rangeHours(range) {
  const m = /^(\d{1,2})(am|pm)?[–-](\d{1,2})(am|pm)$/.exec(String(range || '').trim());
  if (!m) return [];
  const to24 = (n, ap) => (ap === 'am' ? (n === 12 ? 0 : n) : (n === 12 ? 12 : n + 12));
  const end = to24(Number(m[3]), m[4]);
  let start = to24(Number(m[1]), m[2] || m[4]);
  // "11–2pm" style (no start suffix, would land after the end) is morning.
  if (!m[2] && start > end) start = to24(Number(m[1]), 'am');
  const hours = [];
  for (let h = start; h < end; h++) hours.push(h);
  return hours;
}

// Walk slots a day's hours fully cover — a walk can land anywhere in its
// window, so partial coverage doesn't count.
export function walkSlotsFromHours(hours) {
  const set = new Set(hours || []);
  return WALK_TIME_SLOTS.filter(slot => {
    const need = rangeHours(WALK_TIME_SLOT_RANGES[slot]);
    return need.length && need.every(h => set.has(h));
  });
}

// How well a day's hours cover a drop-in visit window: 'full', 'partial'
// (free for some of it — worth a call) or 'none'.
export function visitSlotCoverage(hours, slot) {
  const set = new Set(hours || []);
  const need = rangeHours(VISIT_SLOT_RANGES[slot]);
  if (!need.length) return 'full';
  const have = need.filter(h => set.has(h)).length;
  return have === need.length ? 'full' : have ? 'partial' : 'none';
}

// 'YYYY-MM-DD' or a Date -> 'mon'..'sun'
export function availabilityDayKey(val) {
  const d = typeof val === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(val) ? new Date(`${val}T12:00:00`)
    : val?.toDate ? val.toDate() : new Date(val);
  if (isNaN(d)) return null;
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d.getDay()];
}

// [7, 8, 9, 13, 14] -> "7–10am, 1–3pm"
export function summarizeHours(hours) {
  const sorted = [...new Set(hours || [])].sort((a, b) => a - b);
  const runs = [];
  sorted.forEach(h => {
    const last = runs[runs.length - 1];
    if (last && last[1] === h) last[1] = h + 1;
    else runs.push([h, h + 1]);
  });
  return runs.map(([a, b]) => {
    const la = hourLabel(a), lb = hourLabel(b);
    return la.slice(-2) === lb.slice(-2) ? `${la.slice(0, -2)}–${lb}` : `${la}–${lb}`;
  }).join(', ');
}

// Cleans and checks a submitted { hourlyAvailability, overnightAvailability }.
// Returns { hourlyAvailability, overnightAvailability, availability } ready
// to write, or throws an Error with a readable message.
export function normalizeAvailability(hourly, overnight) {
  if (!hourly || typeof hourly !== 'object') throw new Error('Hourly availability is missing.');
  const hourlyAvailability = {};
  const overnightAvailability = {};
  const availability = {};
  AVAILABILITY_DAYS.forEach(day => {
    const list = Array.isArray(hourly[day]) ? hourly[day] : [];
    if (!list.every(h => AVAILABILITY_HOURS.includes(h))) throw new Error(`Unexpected hour on ${AVAILABILITY_DAY_LABELS[day]}.`);
    hourlyAvailability[day] = [...new Set(list)].sort((a, b) => a - b);
    overnightAvailability[day] = !!overnight?.[day];
    availability[day] = walkSlotsFromHours(hourlyAvailability[day]);
  });
  return { hourlyAvailability, overnightAvailability, availability };
}

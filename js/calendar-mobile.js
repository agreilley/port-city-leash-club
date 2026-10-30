// calendar-mobile.js — phone view for the admin and walker month calendars.
//
// Usage (call right after a calendar render sets container.innerHTML):
//   import { enhanceCalendar } from '/js/calendar-mobile.js';
//   enhanceCalendar({ container, list, year, month, chipSelector, dotClass });
//
// On a phone a day cell is ~50px wide, too narrow for readable chips. Each
// page's mobile CSS hides the chips in the grid and shows the dots this adds
// instead (one per chip, colored by dotClass), and shows `list` under the
// grid: the tapped day's chips at full width. The list holds clones of the
// grid's own chips, so tapping one opens the same modal it does on desktop.
// On desktop the page CSS hides the dots and the list, so nothing changes.

const MAX_DOTS = 3;
const state = new WeakMap(); // container -> { key: 'YYYY-M', day }

function renderList(container, list, year, month, chipSelector) {
  const s = state.get(container);
  if (!s.day) {
    list.innerHTML = '<div class="cal-day-list-empty">Tap a day to see what’s scheduled.</div>';
    return;
  }
  container.querySelectorAll('.calendar-day.selected').forEach(c => c.classList.remove('selected'));
  const cell = container.querySelector(`.calendar-day[data-day="${s.day}"]`);
  if (!cell) return;
  cell.classList.add('selected');
  const heading = new Date(year, month, s.day).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const chips = [...cell.querySelectorAll(chipSelector)];
  list.innerHTML = '';
  const h = document.createElement('div');
  h.className = 'cal-day-list-title';
  h.textContent = heading;
  list.appendChild(h);
  if (!chips.length) {
    const empty = document.createElement('div');
    empty.className = 'cal-day-list-empty';
    empty.textContent = 'Nothing scheduled.';
    list.appendChild(empty);
    return;
  }
  chips.forEach(c => list.appendChild(c.cloneNode(true)));
}

export function enhanceCalendar({ container, list, year, month, chipSelector, dotClass }) {
  if (!container || !list) return;
  const key = `${year}-${month}`;
  let s = state.get(container);
  if (!s || s.key !== key) {
    // New month: start on today if it's in view, else nothing selected.
    const today = new Date();
    const day = today.getFullYear() === year && today.getMonth() === month ? today.getDate() : null;
    s = { key, day };
    state.set(container, s);
  }

  // Number the current-month cells and add their dots. The other-month
  // padding cells carry no chips and aren't selectable.
  let day = 0;
  container.querySelectorAll('.calendar-day').forEach(cell => {
    if (cell.classList.contains('other-month')) return;
    day += 1;
    cell.dataset.day = String(day);
    const chips = [...cell.querySelectorAll(chipSelector)];
    if (!chips.length) return;
    const dots = document.createElement('div');
    dots.className = 'cal-dots';
    chips.slice(0, MAX_DOTS).forEach(c => {
      const dot = document.createElement('span');
      dot.className = `cal-dot ${dotClass(c)}`;
      dots.appendChild(dot);
    });
    if (chips.length > MAX_DOTS) {
      const more = document.createElement('span');
      more.className = 'cal-dot-more';
      more.textContent = `+${chips.length - MAX_DOTS}`;
      dots.appendChild(more);
    }
    cell.appendChild(dots);
  });

  // One delegated listener per container (it survives innerHTML re-renders).
  // Chips are hidden in the grid on phones, so a tap lands on the cell; on
  // desktop a chip click still opens its modal and the list stays hidden.
  if (!container.dataset.calMobile) {
    container.dataset.calMobile = '1';
    container.addEventListener('click', (e) => {
      const cell = e.target.closest('.calendar-day[data-day]');
      if (!cell) return;
      const cur = state.get(container);
      cur.day = Number(cell.dataset.day);
      renderList(container, list, cur.year, cur.month, cur.chipSelector);
    });
  }
  Object.assign(s, { year, month, chipSelector });
  renderList(container, list, year, month, chipSelector);
}

// meet-greet-calendar.js
// Shared meet & greet scheduling widget — used by both membership-request.html
// and service-request.html. Both pages must include the same calendar markup
// (ids: mgMonthTitle, mgCalDays, mgTimePanel, mgSelectedDisplay, mgSelectedText,
// meetGreetDateTime, mgLoadingMsg) and then call initMeetGreetCalendar().
//
// Keeping this logic in one file means availability rules, booking-conflict
// buffers, and time slots only need to be updated in one place for both forms
// to stay in sync.

let mgYear = new Date().getFullYear();
let mgMonth = new Date().getMonth();
let mgAvailability = {};
let mgBookings = {};
let mgSelected = null;

// Recurring weekly schedule — mirrors admin WEEKLY_SCHEDULE
const WEEKLY_SCHEDULE = {
  0: ['1:00pm','1:30pm','2:00pm','2:30pm','3:00pm','3:30pm'],
  1: ['5:00pm','5:30pm','6:00pm','6:30pm','7:00pm','7:30pm'],
  2: ['5:00pm','5:30pm','6:00pm','6:30pm','7:00pm','7:30pm'],
  3: ['5:00pm','5:30pm','6:00pm','6:30pm','7:00pm','7:30pm'],
  4: ['5:00pm','5:30pm','6:00pm','6:30pm','7:00pm','7:30pm'],
  5: ['5:00pm','5:30pm','6:00pm','6:30pm','7:00pm','7:30pm'],
  6: ['10:00am','10:30am','11:00am','11:30am','12:00pm','12:30pm','1:00pm','1:30pm','2:00pm','2:30pm'],
};

function slotToMins(slot) {
  const [time, ampm] = slot.split(/(am|pm)/i);
  let [h, m] = time.split(':').map(Number);
  if (!m) m = 0;
  if (ampm.toLowerCase() === 'pm' && h !== 12) h += 12;
  if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
  return h * 60 + m;
}

function getMgAvailableSlots(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  const dow = date.getDay();
  const override = mgAvailability[dateStr];
  const allSlots = override ? override.slots || [] : (WEEKLY_SCHEDULE[dow] || []);
  const booked = (override?.bookings || []).concat(mgBookings[dateStr] || []);
  if (!booked.length) return allSlots;
  const bookedMins = booked.map(slotToMins);
  return allSlots.filter(slot => !bookedMins.some(bm => Math.abs(slotToMins(slot) - bm) < 60));
}

async function loadMeetGreetAvailability() {
  try {
    const { getFirestore, collection, getDocs } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
    const { initializeApp, getApps } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
    const cfg = {
      apiKey: "AIzaSyC9xuNrH15BOxVEpUzCD4mAJudUNXsUveY",
      authDomain: "port-city-leash-club-839bc.firebaseapp.com",
      projectId: "port-city-leash-club-839bc",
      storageBucket: "port-city-leash-club-839bc.firebasestorage.app",
      messagingSenderId: "649385306352",
      appId: "1:649385306352:web:8e8a6fcbe8a7eff29dfa35"
    };
    const app = getApps().length ? getApps()[0] : initializeApp(cfg);
    const db = getFirestore(app);
    // Load overrides
    const snap = await getDocs(collection(db, 'meet_greet_availability'));
    snap.forEach(doc => { mgAvailability[doc.id] = doc.data(); });
    // Load existing bookings for buffer (across both membership and service requests)
    const subSnap = await getDocs(collection(db, 'submissions'));
    subSnap.forEach(doc => {
      const d = doc.data();
      if (d.meetGreetDateTime) {
        const [dateStr, ...rest] = d.meetGreetDateTime.split(' ');
        const slot = rest.join(' ');
        if (!mgBookings[dateStr]) mgBookings[dateStr] = [];
        mgBookings[dateStr].push(slot);
      }
    });
  } catch(e) { console.log('Loading default schedule'); }
  const loadingMsg = document.getElementById('mgLoadingMsg');
  if (loadingMsg) loadingMsg.style.display = 'none';
  renderMgCalendar();
}

function renderMgCalendar() {
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  document.getElementById('mgMonthTitle').textContent = `${months[mgMonth]} ${mgYear}`;
  const container = document.getElementById('mgCalDays');
  const firstDay = new Date(mgYear, mgMonth, 1).getDay();
  const daysInMonth = new Date(mgYear, mgMonth + 1, 0).getDate();
  const daysInPrev = new Date(mgYear, mgMonth, 0).getDate();
  const today = new Date(); today.setHours(0,0,0,0);
  let html = '';
  for (let i = firstDay - 1; i >= 0; i--) {
    html += `<div style="padding:10px;text-align:center;font-size:13px;color:rgba(0,0,0,0.2);background:rgba(0,0,0,0.02);">${daysInPrev - i}</div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${mgYear}-${String(mgMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const dateObj = new Date(mgYear, mgMonth, d);
    const isPast = dateObj < today;
    const available = getMgAvailableSlots(dateStr);
    const isSelected = mgSelected && mgSelected.startsWith(dateStr);
    let bg = 'white', color = 'rgba(0,0,0,0.3)', cursor = 'default';
    if (!isPast && isSelected) { bg = 'var(--rust)'; color = 'white'; cursor = 'pointer'; }
    else if (!isPast && available.length) { bg = '#EBF5EF'; color = '#1A5C30'; cursor = 'pointer'; }
    else if (isPast) { bg = 'rgba(0,0,0,0.02)'; }
    html += `<div onclick="${available.length && !isPast ? `mgSelectDate('${dateStr}')` : ''}" style="padding:10px;text-align:center;font-size:13px;font-weight:${available.length?'500':'400'};background:${bg};color:${color};cursor:${cursor};border-bottom:1px solid rgba(0,0,0,0.04);transition:all 0.15s;">${d}</div>`;
  }
  const totalCells = Math.ceil((firstDay + daysInMonth) / 7) * 7;
  for (let i = 1; i <= totalCells - firstDay - daysInMonth; i++) {
    html += `<div style="padding:10px;text-align:center;font-size:13px;color:rgba(0,0,0,0.2);background:rgba(0,0,0,0.02);">${i}</div>`;
  }
  container.innerHTML = html;
}

function mgSelectDate(dateStr) {
  const slots = getMgAvailableSlots(dateStr);
  const date = new Date(dateStr + 'T00:00:00');
  const label = date.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'});
  const panel = document.getElementById('mgTimePanel');
  mgSelected = null;
  document.getElementById('mgSelectedDisplay').style.display = 'none';
  document.getElementById('meetGreetDateTime').value = '';
  renderMgCalendar();
  panel.innerHTML = `<div style="font-size:12px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-light);margin-bottom:12px;">${label}</div>` +
    slots.map(slot => `
      <div onclick="mgSelectSlot('${dateStr}', '${slot}')" style="padding:10px 14px;margin-bottom:8px;background:white;border:1px solid rgba(0,0,0,0.1);border-radius:5px;font-size:14px;cursor:pointer;transition:all 0.15s;" onmouseover="this.style.borderColor='var(--seafoam)'" onmouseout="this.style.borderColor='rgba(0,0,0,0.1)'">${slot}</div>
    `).join('');
}

function mgSelectSlot(dateStr, slot) {
  mgSelected = `${dateStr} ${slot}`;
  document.getElementById('meetGreetDateTime').value = mgSelected;
  const date = new Date(dateStr + 'T00:00:00');
  const label = date.toLocaleDateString('en-US', {weekday:'long', month:'long', day:'numeric'});
  document.getElementById('mgSelectedText').textContent = `${label} at ${slot}`;
  document.getElementById('mgSelectedDisplay').style.display = 'block';
  renderMgCalendar();
  const slots = getMgAvailableSlots(dateStr);
  const panel = document.getElementById('mgTimePanel');
  panel.innerHTML = `<div style="font-size:12px;font-weight:500;letter-spacing:0.06em;text-transform:uppercase;color:var(--text-light);margin-bottom:12px;">${label}</div>` +
    slots.map(s => `
      <div onclick="mgSelectSlot('${dateStr}', '${s}')" style="padding:10px 14px;margin-bottom:8px;background:${s===slot?'var(--rust)':'white'};color:${s===slot?'white':'inherit'};border:1px solid ${s===slot?'var(--rust)':'rgba(0,0,0,0.1)'};border-radius:5px;font-size:14px;cursor:pointer;transition:all 0.15s;">${s}</div>
    `).join('');
}

export function initMeetGreetCalendar() {
  window.mgPrevMonth = () => { mgMonth--; if (mgMonth < 0) { mgMonth = 11; mgYear--; } renderMgCalendar(); };
  window.mgNextMonth = () => { mgMonth++; if (mgMonth > 11) { mgMonth = 0; mgYear++; } renderMgCalendar(); };
  window.mgSelectDate = mgSelectDate;
  window.mgSelectSlot = mgSelectSlot;
  loadMeetGreetAvailability();
}

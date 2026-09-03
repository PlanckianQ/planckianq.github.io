// ============================================================================
// Planckian Hot Desk Booking — front end
// Data pipe is a Google Form (writes) + published Sheet CSV (reads).
// See config.js for the endpoints, README.md for setup.
// ============================================================================

const ROOMS = [
  {
    id: "A",
    name: "Room A",
    formRoom: "Room A", // exact value the Google Form's "Room" question expects
    elId: "desks-A",
    desks: [
      { id: "A1", label: "Desk 1", fixedOccupant: "Alessio" },
      { id: "A2", label: "Desk 2" },
      { id: "A3", label: "Desk 3" },
      { id: "A4", label: "Desk 4" },
    ],
  },
  {
    id: "B",
    name: "Room B",
    formRoom: "Room B",
    elId: "desks-B",
    desks: [
      { id: "B1", label: "Desk 1" },
      { id: "B2", label: "Desk 2" },
      { id: "B3", label: "Desk 3" },
      { id: "B4", label: "Desk 4" },
    ],
  },
  {
    id: "X",
    name: "Extra Spots",
    formRoom: "Extra",
    elId: "desks-X",
    desks: [
      { id: "X1", label: "Extra 1" },
      { id: "X2", label: "Extra 2" },
      { id: "X3", label: "Extra 3" },
    ],
  },
];

function formRoomForDesk(deskId) {
  const room = ROOMS.find((r) => r.desks.some((d) => d.id === deskId));
  return room ? room.formRoom : "";
}

const PENDING_KEY = "hotdesk_pending_bookings_v1";

// Add n business days to `base`, skipping Saturday/Sunday entirely — so from
// a Friday, +1 lands on Monday and +2 lands on Tuesday.
function addBusinessDays(base, n) {
  const d = new Date(base);
  let added = 0;
  while (added < n) {
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}

// The two selectable booking targets: "day after" and "day after tomorrow",
// both business-day-aware (weekends skipped).
function targetDateOptions() {
  const today = new Date();
  return [
    { label: "day after", date: addBusinessDays(today, 1) },
    { label: "day after tomorrow", date: addBusinessDays(today, 2) },
  ];
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Reverse of isoDate() — built from local Y/M/D components so it doesn't
// shift a day when the browser is behind UTC (unlike `new Date(isoString)`).
function parseIsoLocal(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function friendlyDate(d) {
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

// Google's native "Date" question type is submitted as 3 separate fields
// (entry.<id>_year / _month / _day), not one plain value.
function dateFieldsForEntry(entryId, dateObj) {
  return {
    [`${entryId}_year`]: dateObj.getFullYear(),
    [`${entryId}_month`]: dateObj.getMonth() + 1,
    [`${entryId}_day`]: dateObj.getDate(),
  };
}

// The Sheet renders that native Date answer back as locale-formatted text
// (e.g. "4/9/2026") rather than ISO, so parse it defensively rather than
// comparing strings directly against our own ISO booking-date value.
function parseSheetDateToIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) {
    const [, y, m, d] = iso;
    return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }

  const parts = s.split(/[\/.\-]/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 3) {
    const nums = parts.map((p) => parseInt(p, 10));
    if (nums.every((n) => !isNaN(n))) {
      let year, month, day;
      if (String(parts[0]).length === 4) {
        [year, month, day] = nums; // Y-M-D
      } else {
        const [a, b, c] = nums;
        year = c < 100 ? 2000 + c : c;
        if (a > 12 && b <= 12) { day = a; month = b; }
        else if (b > 12 && a <= 12) { day = b; month = a; }
        else { day = a; month = b; } // ambiguous: assume D/M/Y (most locales)
      }
      if (year && month && day) {
        return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      }
    }
  }

  const d = new Date(s);
  return isNaN(d.getTime()) ? null : isoDate(d);
}

function sameDate(rawCell, targetIso) {
  return parseSheetDateToIso(rawCell) === targetIso;
}

// ---- tiny CSV parser (handles quoted fields with commas/newlines) --------
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field); field = "";
        rows.push(row); row = [];
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((c) => c.trim() !== "")).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = (r[idx] || "").trim(); });
    return obj;
  });
}

// ---- pending (optimistic) bookings, kept in localStorage -----------------
function loadPending() {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}
function savePending(list) {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(list)); } catch {}
}
function addPending(entry) {
  const list = loadPending();
  list.push(entry);
  savePending(list);
}
function prunePending(confirmedRows, forDate) {
  const list = loadPending().filter((p) => {
    if (p.date !== forDate) return true; // leave other days alone
    const stillPending = !confirmedRows.some(
      (r) => r.Desk === p.desk && sameDate(r.Date, p.date)
    );
    // also drop pending entries older than 10 minutes even if unconfirmed,
    // so a failed submit doesn't block the desk forever
    const tooOld = Date.now() - p.ts > 10 * 60 * 1000;
    return stillPending && !tooOld;
  });
  savePending(list);
}

// ---- data fetch ------------------------------------------------------------
async function fetchBookings() {
  const url = CONFIG.CSV_URL + (CONFIG.CSV_URL.includes("?") ? "&" : "?") + "_ts=" + Date.now();
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Sheet fetch failed: ${res.status}`);
  const text = await res.text();
  return parseCSV(text);
}

// ---- rendering -------------------------------------------------------------

// Who (if anyone) holds a given When-slot for a desk: a confirmed Sheet row
// wins over a merely-pending local one; null means that slot is free.
function slotOccupant(deskRows, deskPending, slotName) {
  const real = deskRows.find((r) => r.When === slotName);
  if (real) return { name: real.Name, pending: false };
  const pend = deskPending.find((p) => p.when === slotName);
  if (pend) return { name: pend.name, pending: true };
  return null;
}

function renderHalf(desk, slotName, occupant) {
  if (occupant) {
    return `
      <div class="half booked${occupant.pending ? " pending" : ""}">
        <span class="half-name">${slotName}${occupant.pending ? " · booking…" : ""}</span>
        <span class="who">${escapeHtml(occupant.name)}</span>
      </div>
    `;
  }
  return `
    <div class="half free">
      <span class="half-name">${slotName} · free</span>
      <button class="mini-book-btn" data-desk="${desk.id}" data-label="${desk.label}" data-slot="${slotName}">Book</button>
    </div>
  `;
}

function render(rows, forDate) {
  const pending = loadPending().filter((p) => p.date === forDate);

  for (const room of ROOMS) {
    const container = document.getElementById(room.elId);
    container.innerHTML = "";
    for (const desk of room.desks) {
      const card = document.createElement("div");
      card.className = "desk-card";

      if (desk.fixedOccupant) {
        card.classList.add("fixed");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          <span class="pill fixed">Always occupied</span>
          <div class="desk-occupant"><span class="who">${desk.fixedOccupant}</span></div>
        `;
        container.appendChild(card);
        continue;
      }

      const deskRows = rows.filter((r) => r.Desk === desk.id && sameDate(r.Date, forDate));
      const deskPending = pending.filter((p) => p.desk === desk.id);

      const wholeDay = slotOccupant(deskRows, deskPending, "Whole day");
      const morning = slotOccupant(deskRows, deskPending, "Morning");
      const afternoon = slotOccupant(deskRows, deskPending, "Afternoon");

      if (wholeDay) {
        // A whole-day booking (confirmed or pending) occupies both halves —
        // show one solid booked card, same as before half-splitting existed.
        card.classList.add("booked");
        if (wholeDay.pending) card.classList.add("pending");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          <span class="pill booked">${wholeDay.pending ? "Booking…" : "Booked"}</span>
          <div class="desk-occupant">
            <span class="who">${escapeHtml(wholeDay.name)}</span>
            <span class="when">Whole day</span>
          </div>
        `;
      } else if (!morning && !afternoon) {
        card.classList.add("free");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          <span class="pill free">Free</span>
          <button class="book-btn" data-desk="${desk.id}" data-label="${desk.label}">Book</button>
        `;
      } else {
        // Exactly one half taken — split the card so the other half stays
        // independently bookable.
        card.classList.add("split");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          ${renderHalf(desk, "Morning", morning)}
          ${renderHalf(desk, "Afternoon", afternoon)}
        `;
      }
      container.appendChild(card);
    }
  }

  document.querySelectorAll(".book-btn").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.dataset.desk, btn.dataset.label));
  });
  document.querySelectorAll(".mini-book-btn").forEach((btn) => {
    btn.addEventListener("click", () =>
      openModalForSlot(btn.dataset.desk, btn.dataset.label, btn.dataset.slot)
    );
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ---- booking submission (hidden-iframe POST to the Google Form) ----------
function submitToGoogleForm(fields) {
  return new Promise((resolve) => {
    const iframeName = "hidden_submit_" + Date.now();
    const iframe = document.createElement("iframe");
    iframe.name = iframeName;
    iframe.style.display = "none";
    document.body.appendChild(iframe);

    const form = document.createElement("form");
    form.action = CONFIG.FORM_ACTION_URL;
    form.method = "POST";
    form.target = iframeName;
    form.style.display = "none";

    for (const [key, value] of Object.entries(fields)) {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = key;
      input.value = value;
      form.appendChild(input);
    }

    document.body.appendChild(form);
    form.submit();

    setTimeout(() => {
      form.remove();
      iframe.remove();
      resolve();
    }, 800);
  });
}

// ---- modal -----------------------------------------------------------------
let activeDesk = null;
let presetWhen = null; // set when booking a single free half of a split desk

function openModalCommon(deskId, deskLabel) {
  activeDesk = deskId;
  const forDateObj = parseIsoLocal(getSelectedDateIso());
  document.getElementById("modalTitle").textContent = `Book ${deskLabel} — ${friendlyDate(forDateObj)}`;
  document.getElementById("nameInput").value = "";
  document.getElementById("modalError").textContent = "";
  document.getElementById("modalBackdrop").classList.add("open");
  document.getElementById("nameInput").focus();
}

// Whole desk is free: let the visitor choose Morning / Afternoon / Whole day.
function openModal(deskId, deskLabel) {
  presetWhen = null;
  openModalCommon(deskId, deskLabel);
  document.getElementById("whenField").hidden = false;
  document.getElementById("whenInput").value = "";
  document.getElementById("whenPreset").hidden = true;
}

// Only one half of the desk is free: skip the choice, lock it to that half.
function openModalForSlot(deskId, deskLabel, slotName) {
  presetWhen = slotName;
  openModalCommon(deskId, deskLabel);
  document.getElementById("whenField").hidden = true;
  const presetEl = document.getElementById("whenPreset");
  presetEl.innerHTML = `When: <strong>${escapeHtml(slotName)}</strong> (the other half of this desk is already booked)`;
  presetEl.hidden = false;
}

function closeModal() {
  activeDesk = null;
  presetWhen = null;
  document.getElementById("modalBackdrop").classList.remove("open");
}

async function confirmBooking() {
  const name = document.getElementById("nameInput").value.trim();
  const when = presetWhen || document.getElementById("whenInput").value;
  const errEl = document.getElementById("modalError");

  if (!name) { errEl.textContent = "Please enter your name."; return; }
  if (!when) { errEl.textContent = "Please select Morning, Afternoon or Whole day."; return; }

  const forDate = getSelectedDateIso();
  const forDateObj = parseIsoLocal(forDate);
  const confirmBtn = document.getElementById("confirmBtn");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Booking…";

  try {
    await submitToGoogleForm({
      [CONFIG.ENTRY_IDS.name]: name,
      [CONFIG.ENTRY_IDS.desk]: activeDesk,
      [CONFIG.ENTRY_IDS.room]: formRoomForDesk(activeDesk),
      [CONFIG.ENTRY_IDS.when]: when,
      ...dateFieldsForEntry(CONFIG.ENTRY_IDS.date, forDateObj),
    });
    addPending({ desk: activeDesk, name, when, date: forDate, ts: Date.now() });
    closeModal();
    setStatus("Booking sent — refreshing…");
    await refresh();
  } catch (e) {
    errEl.textContent = "Something went wrong sending the booking. Try again.";
  } finally {
    confirmBtn.disabled = false;
    confirmBtn.textContent = "Book it";
  }
}

function setStatus(msg) {
  document.getElementById("statusMsg").textContent = msg;
}

// ---- date picker (day after / day after tomorrow) --------------------------
// Repopulates the <select>, keeping whatever the visitor currently has
// picked if it's still one of the two valid options (it will be, in almost
// all cases — options only shift at midnight).
function populateDateSelect() {
  const sel = document.getElementById("targetDateSelect");
  const prevValue = sel.value;
  const options = targetDateOptions();

  sel.innerHTML = "";
  for (const opt of options) {
    const iso = isoDate(opt.date);
    const el = document.createElement("option");
    el.value = iso;
    el.textContent = `${friendlyDate(opt.date)} (${opt.label})`;
    sel.appendChild(el);
  }

  const stillValid = Array.from(sel.options).some((o) => o.value === prevValue);
  sel.value = stillValid ? prevValue : sel.options[0].value;
}

function getSelectedDateIso() {
  const sel = document.getElementById("targetDateSelect");
  if (!sel.value) populateDateSelect();
  return sel.value;
}

// ---- main refresh loop ------------------------------------------------------
async function refresh() {
  populateDateSelect(); // keep options current (e.g. across a midnight rollover)
  const forDate = getSelectedDateIso();
  setStatus("Loading bookings…");
  try {
    const rows = await fetchBookings();
    prunePending(rows, forDate);
    render(rows, forDate);
    setStatus("Up to date · " + new Date().toLocaleTimeString());
  } catch (e) {
    console.error(e);
    render([], forDate); // still show the board with local pending state
    setStatus("Couldn't load the shared sheet (check config.js). Showing local state only.");
  }
}

function init() {
  populateDateSelect();
  document.getElementById("targetDateSelect").addEventListener("change", refresh);

  document.getElementById("refreshBtn").addEventListener("click", refresh);
  document.getElementById("cancelBtn").addEventListener("click", closeModal);
  document.getElementById("confirmBtn").addEventListener("click", confirmBooking);
  document.getElementById("modalBackdrop").addEventListener("click", (e) => {
    if (e.target.id === "modalBackdrop") closeModal();
  });

  refresh();
  setInterval(refresh, CONFIG.POLL_INTERVAL_MS || 60000);
}

document.addEventListener("DOMContentLoaded", init);

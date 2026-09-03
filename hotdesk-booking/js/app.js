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

function tomorrowDate() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d;
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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
// comparing strings directly against our own ISO "tomorrow" value.
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

      const match = rows.find((r) => r.Desk === desk.id && sameDate(r.Date, forDate));
      const pendingMatch = !match && pending.find((p) => p.desk === desk.id);

      if (match) {
        card.classList.add("booked");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          <span class="pill booked">Booked</span>
          <div class="desk-occupant">
            <span class="who">${escapeHtml(match.Name || "?")}</span>
            <span class="when">${escapeHtml(match.When || "")}</span>
          </div>
        `;
      } else if (pendingMatch) {
        card.classList.add("booked", "pending");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          <span class="pill booked">Booking…</span>
          <div class="desk-occupant">
            <span class="who">${escapeHtml(pendingMatch.name)}</span>
            <span class="when">${escapeHtml(pendingMatch.when)}</span>
          </div>
        `;
      } else {
        card.classList.add("free");
        card.innerHTML = `
          <span class="desk-label">${desk.label}</span>
          <span class="pill free">Free</span>
          <button class="book-btn" data-desk="${desk.id}" data-label="${desk.label}">Book</button>
        `;
      }
      container.appendChild(card);
    }
  }

  document.querySelectorAll(".book-btn").forEach((btn) => {
    btn.addEventListener("click", () => openModal(btn.dataset.desk, btn.dataset.label));
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

function openModal(deskId, deskLabel) {
  activeDesk = deskId;
  document.getElementById("modalTitle").textContent = `Book ${deskLabel}`;
  document.getElementById("nameInput").value = "";
  document.getElementById("whenInput").value = "";
  document.getElementById("modalError").textContent = "";
  document.getElementById("modalBackdrop").classList.add("open");
  document.getElementById("nameInput").focus();
}

function closeModal() {
  activeDesk = null;
  document.getElementById("modalBackdrop").classList.remove("open");
}

async function confirmBooking() {
  const name = document.getElementById("nameInput").value.trim();
  const when = document.getElementById("whenInput").value;
  const errEl = document.getElementById("modalError");

  if (!name) { errEl.textContent = "Please enter your name."; return; }
  if (!when) { errEl.textContent = "Please select Morning, Afternoon or Whole day."; return; }

  const forDateObj = tomorrowDate();
  const forDate = isoDate(forDateObj);
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

// ---- main refresh loop ------------------------------------------------------
async function refresh() {
  const forDate = isoDate(tomorrowDate());
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
  const tmr = tomorrowDate();
  document.getElementById("tomorrowLabel").textContent = "Booking for: " + friendlyDate(tmr);

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

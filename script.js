const CATEGORIES = [
  "Drafts to Drive",
  "Programming • Figma • CAD",
  "School",
  "Reading",
  "TDs",
];

const SOL_EPOCH = { month: 4, day: 22 }; // May 22 (0-indexed month)
const STORAGE_KEY = "habit-tracker-mvp:rows";

const state = {
  rows: [],
  dragIndex: null,
};

const logEl = document.getElementById("log");
const rowsEl = document.getElementById("rows");
const dateCell = document.getElementById("date-cell");
const solCell = document.getElementById("sol-cell");
const totalTimeHeader = document.getElementById("total-time-header");
const form = document.getElementById("composer");
const categorySelect = document.getElementById("category");
const durationInput = document.getElementById("duration");

let timestampPopupEl = null;

function formatDate(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${m}.${d}.${y}`;
}

function daysSinceMay22(date = new Date()) {
  const year = date.getFullYear();
  const start = new Date(year, SOL_EPOCH.month, SOL_EPOCH.day);
  start.setHours(0, 0, 0, 0);

  const today = new Date(date);
  today.setHours(0, 0, 0, 0);

  // If before May 22 this year, count from May 22 of previous year
  if (today < start) {
    start.setFullYear(year - 1);
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((today - start) / msPerDay);
}

/** Display duration as 1h 33m or 45m. */
function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** 24h clock time for the timestamp popup. */
function formatClock24(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Parse sloppy duration text into total minutes.
 * Rule 1: explicit units win
 * Rule 2: two bare numbers → hours + minutes
 * Rule 3: one bare number → minutes
 */
function parseDuration(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase().replace(/,/g, "");
  if (!text) return null;

  const hasUnit = /h|hr|hour|hours|m|min|mins|minute|minutes|:/.test(text);

  if (hasUnit) {
    return parseExplicitDuration(text);
  }

  const bare = text.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/);
  if (bare) {
    const hours = Number(bare[1]);
    const minutes = Number(bare[2]);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
    if (hours < 0 || minutes < 0 || minutes > 59) return null;
    return hours * 60 + minutes;
  }

  const single = text.match(/^(\d+(?:\.\d+)?)$/);
  if (single) {
    const value = Number(single[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    if (!Number.isInteger(value)) return null;
    return value;
  }

  return null;
}

function parseExplicitDuration(text) {
  // 1:40 or 1:40:00 (ignore seconds if present)
  const colon = text.match(/^(\d+)\s*:\s*(\d{1,2})(?:\s*:\s*\d{1,2})?$/);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    if (minutes > 59) return null;
    return hours * 60 + minutes;
  }

  let remaining = text
    .replace(/\bhours?\b/g, "h")
    .replace(/\bhrs?\b/g, "h")
    .replace(/\bminutes?\b/g, "m")
    .replace(/\bmins?\b/g, "m");

  remaining = remaining.replace(/\s+/g, " ").trim();

  let hours = 0;
  let minutes = 0;
  let matchedHour = false;
  let matchedMin = false;
  let matchedTrailing = false;

  const hourMatch = remaining.match(/(\d+(?:\.\d+)?)\s*h/);
  if (hourMatch) {
    hours = Number(hourMatch[1]);
    if (!Number.isFinite(hours) || hours < 0) return null;
    remaining = remaining.replace(hourMatch[0], " ");
    matchedHour = true;
  }

  const minMatch = remaining.match(/(\d+(?:\.\d+)?)\s*m\b/);
  if (minMatch) {
    minutes = Number(minMatch[1]);
    if (!Number.isFinite(minutes) || minutes < 0) return null;
    remaining = remaining.replace(minMatch[0], " ");
    matchedMin = true;
  }

  // "1h 14" / "1 hr 14" with bare trailing minutes
  const trailing = remaining.match(/(\d+(?:\.\d+)?)/);
  if (trailing && matchedHour && !matchedMin) {
    minutes = Number(trailing[1]);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
    remaining = remaining.replace(trailing[0], " ");
    matchedTrailing = true;
  }

  remaining = remaining.replace(/\s+/g, "").trim();
  if ((!matchedHour && !matchedMin) || remaining.length > 0) return null;

  // Decimal hours without separate minutes: 1.5h
  if (matchedHour && !matchedMin && !matchedTrailing && !Number.isInteger(hours)) {
    return Math.round(hours * 60);
  }

  if (!Number.isInteger(hours) && matchedMin) return null;
  if (!Number.isInteger(minutes)) return null;

  return Math.round(hours) * 60 + minutes;
}

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function ensureHeader() {
  const now = new Date();
  dateCell.textContent = formatDate(now);
  solCell.textContent = `Sol ${daysSinceMay22(now)}`;
  if (totalTimeHeader) totalTimeHeader.textContent = "Total time";
}

function findRowIndex(category) {
  return state.rows.findIndex((row) => row.category === category);
}

function normalizeDuration(entry) {
  if (!entry || typeof entry !== "object") return null;
  const minutes = Number(entry.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const loggedAt =
    typeof entry.loggedAt === "string" && entry.loggedAt
      ? entry.loggedAt
      : new Date().toISOString();
  return { minutes: Math.round(minutes), loggedAt };
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.category !== "string" || !row.category.trim()) return null;
  if (!Array.isArray(row.durations)) return null;

  const durations = row.durations.map(normalizeDuration).filter(Boolean);
  if (durations.length === 0) return null;

  return {
    id: typeof row.id === "string" && row.id ? row.id : crypto.randomUUID(),
    category: row.category.trim(),
    durations,
  };
}

function loadRows() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeRow).filter(Boolean);
  } catch {
    return [];
  }
}

function saveRows() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.rows));
}

function upsertDuration(category, minutes) {
  const entry = {
    minutes,
    loggedAt: new Date().toISOString(),
  };
  const index = findRowIndex(category);

  if (index === -1) {
    state.rows.push({
      id: crypto.randomUUID(),
      category,
      durations: [entry],
    });
    return;
  }

  state.rows[index].durations.push(entry);
}

function runningTotals(durations) {
  let sum = 0;
  return durations.map((entry) => {
    sum += entry.minutes;
    return sum;
  });
}

function hideTimestampPopup() {
  if (timestampPopupEl) {
    timestampPopupEl.remove();
    timestampPopupEl = null;
  }
}

function showTimestampPopup(clientX, clientY, loggedAt) {
  hideTimestampPopup();

  const date = new Date(loggedAt);
  const label = Number.isNaN(date.getTime()) ? "—" : formatClock24(date);

  const popup = document.createElement("div");
  popup.className = "timestamp-popup";
  popup.setAttribute("role", "tooltip");
  popup.textContent = label;
  document.body.appendChild(popup);

  const pad = 8;
  const rect = popup.getBoundingClientRect();
  let left = clientX + pad;
  let top = clientY + pad;

  if (left + rect.width > window.innerWidth - pad) {
    left = clientX - rect.width - pad;
  }
  if (top + rect.height > window.innerHeight - pad) {
    top = clientY - rect.height - pad;
  }
  left = Math.max(pad, left);
  top = Math.max(pad, top);

  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
  timestampPopupEl = popup;
}

function onDurationClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const loggedAt = button.dataset.loggedAt;
  if (!loggedAt) return;

  showTimestampPopup(event.clientX, event.clientY, loggedAt);
}

function renderRows() {
  ensureHeader();
  hideTimestampPopup();
  saveRows();

  if (state.rows.length === 0) {
    logEl.hidden = true;
    rowsEl.innerHTML = "";
    return;
  }

  logEl.hidden = false;
  rowsEl.innerHTML = state.rows
    .map((row, index) => {
      const totals = runningTotals(row.durations);
      const durationLines = row.durations
        .map(
          (entry, i) =>
            `<button type="button" class="duration-entry" data-row="${index}" data-entry="${i}" data-logged-at="${escapeHtml(entry.loggedAt)}">${escapeHtml(formatDuration(entry.minutes))}</button>`,
        )
        .join("");
      const totalLines = totals
        .map((total) => `<div class="total-line">${escapeHtml(formatDuration(total))}</div>`)
        .join("");

      return `
        <tr
          class="log-row"
          draggable="true"
          data-index="${index}"
        >
          <td>
            <div class="category-label">
              <span class="drag-hint" aria-hidden="true">⠿</span>
              <span>${escapeHtml(row.category)}</span>
            </div>
          </td>
          <td>
            <div class="duration-lines">${durationLines}</div>
          </td>
          <td>
            <div class="total-lines">${totalLines}</div>
          </td>
        </tr>
      `;
    })
    .join("");

  bindDragHandlers();
  bindDurationClicks();
}

function bindDurationClicks() {
  rowsEl.querySelectorAll(".duration-entry").forEach((button) => {
    button.addEventListener("click", onDurationClick);
    // Keep row drag from starting when interacting with a duration
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("dragstart", (event) => event.preventDefault());
  });
}

function bindDragHandlers() {
  const rowNodes = rowsEl.querySelectorAll(".log-row");

  rowNodes.forEach((row) => {
    row.addEventListener("dragstart", onDragStart);
    row.addEventListener("dragend", onDragEnd);
    row.addEventListener("dragover", onDragOver);
    row.addEventListener("dragleave", onDragLeave);
    row.addEventListener("drop", onDrop);
  });
}

function onDragStart(event) {
  if (event.target.closest(".duration-entry")) {
    event.preventDefault();
    return;
  }
  const index = Number(event.currentTarget.dataset.index);
  state.dragIndex = index;
  event.currentTarget.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", String(index));
}

function onDragEnd(event) {
  event.currentTarget.classList.remove("is-dragging");
  rowsEl
    .querySelectorAll(".is-drag-over")
    .forEach((el) => el.classList.remove("is-drag-over"));
  state.dragIndex = null;
}

function onDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = "move";
  event.currentTarget.classList.add("is-drag-over");
}

function onDragLeave(event) {
  event.currentTarget.classList.remove("is-drag-over");
}

function onDrop(event) {
  event.preventDefault();
  const toIndex = Number(event.currentTarget.dataset.index);
  const fromIndex = state.dragIndex;

  event.currentTarget.classList.remove("is-drag-over");

  if (fromIndex === null || Number.isNaN(toIndex) || fromIndex === toIndex) {
    return;
  }

  const [moved] = state.rows.splice(fromIndex, 1);
  state.rows.splice(toIndex, 0, moved);
  renderRows();
}

function onSubmit(event) {
  event.preventDefault();

  const category = categorySelect.value.trim();
  const raw = durationInput.value.trim();

  if (!CATEGORIES.includes(category) || !raw) {
    return;
  }

  const minutes = parseDuration(raw);
  if (minutes === null) {
    durationInput.setCustomValidity("Couldn’t read that time");
    durationInput.reportValidity();
    return;
  }

  durationInput.setCustomValidity("");
  upsertDuration(category, minutes);
  durationInput.value = "";
  durationInput.focus();
  renderRows();
}

form.addEventListener("submit", onSubmit);

durationInput.addEventListener("input", () => {
  durationInput.setCustomValidity("");
});

document.addEventListener("click", (event) => {
  if (!timestampPopupEl) return;
  if (event.target.closest(".duration-entry")) return;
  if (event.target.closest(".timestamp-popup")) return;
  hideTimestampPopup();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideTimestampPopup();
});

state.rows = loadRows();
renderRows();
durationInput.focus();

const CATEGORIES = [
  "Drafts to Drive",
  "Programming • Figma • CAD",
  "School",
  "Reading",
  "TDs",
];

const SOL_EPOCH = { month: 4, day: 22 }; // May 22 (0-indexed month)
const STORAGE_KEY = "habit-tracker-mvp:rows";
const BOOKS_STORAGE_KEY = "habit-tracker-mvp:reading-books";

const state = {
  rows: [],
  dragIndex: null,
  books: {
    activeBookId: null,
    books: [],
  },
};

const logEl = document.getElementById("log");
const rowsEl = document.getElementById("rows");
const dateCell = document.getElementById("date-cell");
const solCell = document.getElementById("sol-cell");
const totalTimeHeader = document.getElementById("total-time-header");
const form = document.getElementById("composer");
const categorySelect = document.getElementById("category");
const durationInput = document.getElementById("duration");
const readingFields = document.getElementById("reading-fields");
const readingPanel = document.getElementById("reading-panel");
const readingProgressFill = document.getElementById("reading-progress-fill");
const readingProgressLabel = document.getElementById("reading-progress-label");
const editTotalBtn = document.getElementById("edit-total-btn");
const newBookBtn = document.getElementById("new-book-btn");
const pageFromInput = document.getElementById("page-from");
const pageToInput = document.getElementById("page-to");
const bookDialog = document.getElementById("book-dialog");
const bookDialogForm = document.getElementById("book-dialog-form");
const bookDialogTitle = document.getElementById("book-dialog-title");
const bookTotalPagesInput = document.getElementById("book-total-pages");

let timestampPopupEl = null;
let bookDialogMode = "new"; // "new" | "edit"

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

  const trailing = remaining.match(/(\d+(?:\.\d+)?)/);
  if (trailing && matchedHour && !matchedMin) {
    minutes = Number(trailing[1]);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
    remaining = remaining.replace(trailing[0], " ");
    matchedTrailing = true;
  }

  remaining = remaining.replace(/\s+/g, "").trim();
  if ((!matchedHour && !matchedMin) || remaining.length > 0) return null;

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

function parsePageNumber(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1) return null;
  return value;
}

/** True when no longer page ≤ totalPages can be formed by adding digits. */
function isPageNumberComplete(digits, totalPages) {
  if (!digits || !Number.isInteger(totalPages) || totalPages < 1) return false;
  if (!/^\d+$/.test(digits)) return false;
  const value = Number(digits);
  if (value < 1) return false;
  if (value > totalPages) return false;
  // If appending any digit 0–9 would still be ≤ totalPages, not complete yet.
  for (let d = 0; d <= 9; d += 1) {
    const next = value * 10 + d;
    if (next <= totalPages) return false;
  }
  return true;
}

function digitsOnly(value) {
  return String(value ?? "").replace(/\D/g, "");
}

// --- Books storage ---

function normalizeBook(book) {
  if (!book || typeof book !== "object") return null;
  const totalPages = Number(book.totalPages);
  if (!Number.isInteger(totalPages) || totalPages < 1) return null;
  let lastFinishedPage = Number(book.lastFinishedPage);
  if (!Number.isInteger(lastFinishedPage) || lastFinishedPage < 0) {
    lastFinishedPage = 0;
  }
  if (lastFinishedPage > totalPages) lastFinishedPage = totalPages;
  const status = book.status === "finished" ? "finished" : "active";
  return {
    id: typeof book.id === "string" && book.id ? book.id : crypto.randomUUID(),
    title: typeof book.title === "string" ? book.title : "",
    totalPages,
    lastFinishedPage,
    status,
  };
}

function normalizeBooksState(raw) {
  if (!raw || typeof raw !== "object") {
    return { activeBookId: null, books: [] };
  }
  const books = Array.isArray(raw.books)
    ? raw.books.map(normalizeBook).filter(Boolean)
    : [];
  let activeBookId =
    typeof raw.activeBookId === "string" && raw.activeBookId
      ? raw.activeBookId
      : null;
  if (activeBookId && !books.some((b) => b.id === activeBookId)) {
    activeBookId = null;
  }
  if (!activeBookId) {
    const active = books.find((b) => b.status === "active");
    activeBookId = active ? active.id : null;
  }
  return { activeBookId, books };
}

function loadBooks() {
  try {
    const raw = localStorage.getItem(BOOKS_STORAGE_KEY);
    if (!raw) return { activeBookId: null, books: [] };
    return normalizeBooksState(JSON.parse(raw));
  } catch {
    return { activeBookId: null, books: [] };
  }
}

function saveBooks() {
  localStorage.setItem(BOOKS_STORAGE_KEY, JSON.stringify(state.books));
}

function getActiveBook() {
  if (!state.books.activeBookId) return null;
  return state.books.books.find((b) => b.id === state.books.activeBookId) || null;
}

function createBook(totalPages) {
  const book = {
    id: crypto.randomUUID(),
    title: "",
    totalPages,
    lastFinishedPage: 0,
    status: "active",
  };
  for (const existing of state.books.books) {
    if (existing.status === "active") existing.status = "finished";
  }
  state.books.books.push(book);
  state.books.activeBookId = book.id;
  saveBooks();
  return book;
}

function updateActiveBookTotal(totalPages) {
  const book = getActiveBook();
  if (!book) return null;
  book.totalPages = totalPages;
  if (book.lastFinishedPage > totalPages) {
    book.lastFinishedPage = totalPages;
  }
  saveBooks();
  return book;
}

function updateActiveBookBookmark(pageTo) {
  const book = getActiveBook();
  if (!book) return;
  book.lastFinishedPage = Math.max(book.lastFinishedPage, pageTo);
  if (book.lastFinishedPage > book.totalPages) {
    book.lastFinishedPage = book.totalPages;
  }
  saveBooks();
}

function suggestedPageFrom(book) {
  if (!book || book.lastFinishedPage < 1) return null;
  const next = book.lastFinishedPage + 1;
  if (next > book.totalPages) return null;
  return next;
}

function prefillPageFrom() {
  const suggested = suggestedPageFrom(getActiveBook());
  pageFromInput.value = suggested != null ? String(suggested) : "";
}

// --- Rows / durations ---

function ensureHeader() {
  const now = new Date();
  dateCell.textContent = formatDate(now);
  solCell.textContent = `Sol ${daysSinceMay22(now)}`;
  if (totalTimeHeader) totalTimeHeader.textContent = "Total time";
}

function findRowIndex(category) {
  return state.rows.findIndex((row) => row.category === category);
}

function normalizeDuration(entry, category) {
  if (!entry || typeof entry !== "object") return null;
  const minutes = Number(entry.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  const loggedAt =
    typeof entry.loggedAt === "string" && entry.loggedAt
      ? entry.loggedAt
      : new Date().toISOString();

  const normalized = { minutes: Math.round(minutes), loggedAt };

  if (category === "Reading") {
    const pageFrom = Number(entry.pageFrom);
    const pageTo = Number(entry.pageTo);
    if (
      !Number.isInteger(pageFrom) ||
      !Number.isInteger(pageTo) ||
      pageFrom < 1 ||
      pageTo < pageFrom
    ) {
      return null;
    }
    normalized.pageFrom = pageFrom;
    normalized.pageTo = pageTo;
    if (typeof entry.bookId === "string" && entry.bookId) {
      normalized.bookId = entry.bookId;
    }
  }

  return normalized;
}

function normalizeRow(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.category !== "string" || !row.category.trim()) return null;
  if (!Array.isArray(row.durations)) return null;

  const category = row.category.trim();
  const durations = row.durations
    .map((entry) => normalizeDuration(entry, category))
    .filter(Boolean);
  if (durations.length === 0) return null;

  return {
    id: typeof row.id === "string" && row.id ? row.id : crypto.randomUUID(),
    category,
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

function upsertDuration(category, entry) {
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

function formatReadingEntry(entry) {
  return `${formatDuration(entry.minutes)} ${entry.pageFrom}-${entry.pageTo}`;
}

function formatEntryLabel(row, entry) {
  if (row.category === "Reading" && entry.pageFrom != null && entry.pageTo != null) {
    return formatReadingEntry(entry);
  }
  return formatDuration(entry.minutes);
}

// --- Timestamp popup ---

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

// --- Composer / Reading UI ---

function isReadingCategory() {
  return categorySelect.value === "Reading";
}

function updateProgressUI() {
  const book = getActiveBook();
  if (!book) {
    readingProgressFill.style.width = "0%";
    readingProgressLabel.textContent = "";
    return;
  }
  const pct =
    book.totalPages > 0
      ? Math.min(100, (book.lastFinishedPage / book.totalPages) * 100)
      : 0;
  readingProgressFill.style.width = `${pct}%`;
  readingProgressLabel.textContent = `${book.lastFinishedPage} / ${book.totalPages}`;
}

function updateComposerMode() {
  const reading = isReadingCategory();
  const book = getActiveBook();

  readingFields.hidden = !reading;
  readingPanel.hidden = !reading;
  editTotalBtn.hidden = !book;
  editTotalBtn.disabled = !book;

  if (reading) {
    form.classList.add("composer-reading");
    if (book) {
      updateProgressUI();
    } else {
      readingProgressFill.style.width = "0%";
      readingProgressLabel.textContent = "No book yet";
    }
  } else {
    form.classList.remove("composer-reading");
  }
}

function openBookDialog(mode) {
  bookDialogMode = mode;
  bookDialogTitle.textContent = mode === "edit" ? "Edit total pages" : "New book";
  const book = getActiveBook();
  bookTotalPagesInput.value =
    mode === "edit" && book ? String(book.totalPages) : "";
  bookTotalPagesInput.setCustomValidity("");
  if (typeof bookDialog.showModal === "function") {
    bookDialog.showModal();
  } else {
    bookDialog.setAttribute("open", "");
  }
  bookTotalPagesInput.focus();
  bookTotalPagesInput.select();
}

function closeBookDialog() {
  if (typeof bookDialog.close === "function") {
    bookDialog.close();
  } else {
    bookDialog.removeAttribute("open");
  }
}

function maybeAutoAdvance(inputEl, nextEl) {
  const book = getActiveBook();
  if (!book) return;
  const digits = digitsOnly(inputEl.value);
  if (digits !== inputEl.value) {
    inputEl.value = digits;
  }
  if (isPageNumberComplete(digits, book.totalPages)) {
    nextEl.focus();
    if (typeof nextEl.select === "function") nextEl.select();
  }
}

function onPageFromInput() {
  pageFromInput.setCustomValidity("");
  let value = pageFromInput.value;
  if (value.includes("-")) {
    pageFromInput.value = digitsOnly(value.split("-")[0]);
    pageToInput.focus();
    return;
  }
  pageFromInput.value = digitsOnly(value);
  maybeAutoAdvance(pageFromInput, pageToInput);
}

function onPageToInput() {
  pageToInput.setCustomValidity("");
  pageToInput.value = digitsOnly(pageToInput.value);
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
            `<button type="button" class="duration-entry" data-row="${index}" data-entry="${i}" data-logged-at="${escapeHtml(entry.loggedAt)}">${escapeHtml(formatEntryLabel(row, entry))}</button>`,
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

  if (category === "Reading") {
    const book = getActiveBook();
    if (!book) {
      openBookDialog("new");
      return;
    }

    const pageFrom = parsePageNumber(pageFromInput.value);
    const pageTo = parsePageNumber(pageToInput.value);

    if (pageFrom === null) {
      pageFromInput.setCustomValidity("Enter a start page");
      pageFromInput.reportValidity();
      return;
    }

    if (pageTo === null) {
      pageToInput.setCustomValidity("Enter an end page");
      pageToInput.reportValidity();
      return;
    }

    if (pageFrom > pageTo) {
      pageToInput.setCustomValidity("End page must be ≥ start");
      pageToInput.reportValidity();
      return;
    }

    if (pageTo > book.totalPages || pageFrom > book.totalPages) {
      pageToInput.setCustomValidity(`Book only has ${book.totalPages} pages`);
      pageToInput.reportValidity();
      return;
    }

    pageToInput.setCustomValidity("");
    pageFromInput.setCustomValidity("");

    const entry = {
      minutes,
      loggedAt: new Date().toISOString(),
      pageFrom,
      pageTo,
      bookId: book.id,
    };

    upsertDuration(category, entry);
    updateActiveBookBookmark(pageTo);

    durationInput.value = "";
    pageToInput.value = "";
    prefillPageFrom();

    updateComposerMode();
    durationInput.focus();
    renderRows();
    return;
  }

  upsertDuration(category, {
    minutes,
    loggedAt: new Date().toISOString(),
  });
  durationInput.value = "";
  durationInput.focus();
  renderRows();
}

function onCategoryChange() {
  updateComposerMode();

  if (isReadingCategory()) {
    prefillPageFrom();
    durationInput.focus();
  }
}

function onBookDialogSubmit(event) {
  event.preventDefault();
  const total = parsePageNumber(bookTotalPagesInput.value);
  if (total === null) {
    bookTotalPagesInput.setCustomValidity("Enter a whole number of pages");
    bookTotalPagesInput.reportValidity();
    return;
  }
  bookTotalPagesInput.setCustomValidity("");

  if (bookDialogMode === "edit" && getActiveBook()) {
    updateActiveBookTotal(total);
  } else {
    createBook(total);
  }

  closeBookDialog();
  updateComposerMode();
  if (isReadingCategory()) {
    prefillPageFrom();
    durationInput.focus();
  }
}

// --- Events ---

form.addEventListener("submit", onSubmit);

categorySelect.addEventListener("change", onCategoryChange);

durationInput.addEventListener("input", () => {
  durationInput.setCustomValidity("");
});

pageFromInput.addEventListener("input", onPageFromInput);

pageFromInput.addEventListener("keydown", (event) => {
  if (event.key === "-" || event.key === "–") {
    event.preventDefault();
    pageFromInput.value = digitsOnly(pageFromInput.value);
    pageToInput.focus();
  }
});

pageToInput.addEventListener("input", onPageToInput);

newBookBtn.addEventListener("click", () => {
  openBookDialog("new");
});

editTotalBtn.addEventListener("click", () => {
  if (!getActiveBook()) {
    openBookDialog("new");
    return;
  }
  openBookDialog("edit");
});

bookDialogForm.addEventListener("submit", onBookDialogSubmit);

document.getElementById("book-dialog-cancel").addEventListener("click", () => {
  bookTotalPagesInput.setCustomValidity("");
  closeBookDialog();
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
state.books = loadBooks();
renderRows();
updateComposerMode();
if (isReadingCategory() && getActiveBook()) {
  prefillPageFrom();
}
durationInput.focus();

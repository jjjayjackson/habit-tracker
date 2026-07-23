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
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

const state = {
  days: {},
  dragDayKey: null,
  dragIndex: null,
  books: {
    activeBookId: null,
    books: [],
  },
};

const logEl = document.getElementById("log");
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
let contextMenuEl = null;
let bookDialogMode = "new"; // "new" | "edit"
let noteEditingKey = null; // "YYYY-MM-DD:rowIndex:entryIndex"
let noteDraft = "";
let noteHadSavedText = false;
let noteEditorDiscarding = false;
let dateEditingKey = null; // "YYYY-MM-DD"
let dateDraft = "";
let dateEditorDiscarding = false;
let activeDayKey = null;

function formatDate(date) {
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const y = String(date.getFullYear()).slice(-2);
  return `${m}.${d}.${y}`;
}

/** Local calendar day key: YYYY-MM-DD */
function localDayKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromDayKey(dayKey) {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Parse display dates into a local day key.
 * Accepts 7.22.26 · 7/22/2026 · 2026-07-22
 */
function parseDisplayDate(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) {
    return dayKeyFromParts(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  const dotted = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/);
  if (!dotted) return null;

  const month = Number(dotted[1]);
  const day = Number(dotted[2]);
  let year = Number(dotted[3]);
  if (dotted[3].length === 2) year += 2000;
  return dayKeyFromParts(year, month, day);
}

function dayKeyFromParts(year, month, day) {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    year < 2000 ||
    year > 2100 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return null;
  }
  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return localDayKey(date);
}

function sortedDayKeys(days = state.days) {
  return Object.keys(days)
    .filter((key) => DAY_KEY_RE.test(key) && Array.isArray(days[key]) && days[key].length > 0)
    .sort();
}

function rowsFor(dayKey) {
  if (!state.days[dayKey]) state.days[dayKey] = [];
  return state.days[dayKey];
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

function findRowIndex(dayKey, category) {
  return rowsFor(dayKey).findIndex((row) => row.category === category);
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

  if (typeof entry.comment === "string") {
    const comment = entry.comment.trim();
    if (comment) normalized.comment = comment;
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

function normalizeDayRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeRow).filter(Boolean);
}

/** Split legacy flat rows across days using each entry's loggedAt. */
function migrateFlatRows(rows) {
  const days = {};
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const category = typeof row.category === "string" ? row.category.trim() : "";
    if (!category || !Array.isArray(row.durations)) continue;

    for (const entry of row.durations) {
      const normalized = normalizeDuration(entry, category);
      if (!normalized) continue;
      const dayKey = localDayKey(new Date(normalized.loggedAt));
      if (!days[dayKey]) days[dayKey] = [];
      let target = days[dayKey].find((r) => r.category === category);
      if (!target) {
        target = {
          id: typeof row.id === "string" && row.id ? row.id : crypto.randomUUID(),
          category,
          durations: [],
        };
        days[dayKey].push(target);
      }
      target.durations.push(normalized);
    }
  }
  return days;
}

function mergeDayRows(targetRows, sourceRows) {
  for (const source of sourceRows) {
    const index = targetRows.findIndex((row) => row.category === source.category);
    if (index === -1) {
      targetRows.push(source);
      continue;
    }
    targetRows[index].durations.push(...source.durations);
  }
}

function renameDay(fromKey, toKey) {
  if (!DAY_KEY_RE.test(fromKey) || !DAY_KEY_RE.test(toKey)) return false;
  if (fromKey === toKey) return false;
  if (!Array.isArray(state.days[fromKey])) return false;

  const moving = state.days[fromKey];
  delete state.days[fromKey];

  if (Array.isArray(state.days[toKey]) && state.days[toKey].length > 0) {
    mergeDayRows(state.days[toKey], moving);
  } else {
    state.days[toKey] = moving;
  }

  if (noteEditingKey?.startsWith(`${fromKey}:`)) {
    noteEditingKey = `${toKey}:${noteEditingKey.slice(fromKey.length + 1)}`;
  }
  return true;
}

function loadDays() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);

    // Legacy flat array → bucket by each entry's loggedAt calendar day
    if (Array.isArray(parsed)) {
      return migrateFlatRows(parsed);
    }

    if (!parsed || typeof parsed !== "object") return {};

    const days = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!DAY_KEY_RE.test(key)) continue;
      const rows = normalizeDayRows(value);
      if (rows.length > 0) days[key] = rows;
    }
    return days;
  } catch {
    return {};
  }
}

function saveDays() {
  const toSave = {};
  for (const key of sortedDayKeys(state.days)) {
    toSave[key] = state.days[key];
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
}

function upsertDuration(category, entry) {
  const dayKey = localDayKey();
  const rows = rowsFor(dayKey);
  const index = findRowIndex(dayKey, category);

  if (index === -1) {
    rows.push({
      id: crypto.randomUUID(),
      category,
      durations: [entry],
    });
    return;
  }

  rows[index].durations.push(entry);
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

function syncActiveDay() {
  const today = localDayKey();
  if (activeDayKey === today) return false;
  activeDayKey = today;
  return true;
}

// --- Date header editing ---

function clearDateEditorState() {
  dateEditingKey = null;
  dateDraft = "";
  dateEditorDiscarding = false;
}

function openDateEditor(dayKey) {
  if (!state.days[dayKey]) return;
  closeContextMenu();
  hideTimestampPopup();
  if (noteEditingKey) clearNoteEditorState();
  dateEditingKey = dayKey;
  dateDraft = formatDate(dateFromDayKey(dayKey));
  dateEditorDiscarding = false;
  renderRows();
}

function cancelDateEditor() {
  clearDateEditorState();
  renderRows();
}

function commitDateEditor(dayKey) {
  const nextKey = parseDisplayDate(dateDraft);
  if (!nextKey) {
    const input = logEl.querySelector(`.day-date-input[data-day="${dayKey}"]`);
    if (input) {
      input.setCustomValidity("Use a date like 7.22.26");
      input.reportValidity();
      input.focus();
    }
    return;
  }

  clearDateEditorState();
  if (nextKey !== dayKey) {
    renameDay(dayKey, nextKey);
  }
  renderRows();
}

function mountDateEditor() {
  if (!dateEditingKey || !state.days[dateEditingKey]) {
    if (dateEditingKey) clearDateEditorState();
    return;
  }

  const cell = logEl.querySelector(`.day-date-cell[data-day="${dateEditingKey}"]`);
  if (!cell) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "day-date-input";
  input.dataset.day = dateEditingKey;
  input.value = dateDraft;
  input.setAttribute("aria-label", "Edit date");
  input.autocomplete = "off";
  input.spellcheck = false;

  input.addEventListener("input", (event) => {
    dateDraft = event.target.value;
    input.setCustomValidity("");
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commitDateEditor(dateEditingKey);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelDateEditor();
    }
  });
  input.addEventListener("blur", () => {
    queueMicrotask(() => {
      if (dateEditingKey !== input.dataset.day) return;
      if (dateEditorDiscarding) return;
      commitDateEditor(dateEditingKey);
    });
  });

  cell.replaceChildren(input);
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
}

function bindDateEditors() {
  logEl.querySelectorAll(".day-date-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dayKey = button.dataset.day;
      if (!dayKey) return;
      openDateEditor(dayKey);
    });
  });
}

// --- Timestamp popup / context menu / notes ---

function entryKey(dayKey, rowIndex, entryIndex) {
  return `${dayKey}:${rowIndex}:${entryIndex}`;
}

function parseEntryKey(key) {
  if (typeof key !== "string") return null;
  const match = key.match(/^(\d{4}-\d{2}-\d{2}):(\d+):(\d+)$/);
  if (!match) return null;
  const rowIndex = Number(match[2]);
  const entryIndex = Number(match[3]);
  if (!Number.isInteger(rowIndex) || !Number.isInteger(entryIndex)) return null;
  return { dayKey: match[1], rowIndex, entryIndex };
}

function getEntry(dayKey, rowIndex, entryIndex) {
  const rows = state.days[dayKey];
  if (!rows) return null;
  const row = rows[rowIndex];
  if (!row) return null;
  const entry = row.durations[entryIndex];
  return entry || null;
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

function closeContextMenu() {
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }
}

function setEntryComment(dayKey, rowIndex, entryIndex, text) {
  const entry = getEntry(dayKey, rowIndex, entryIndex);
  if (!entry) return;
  const trimmed = text.trim();
  if (trimmed) {
    entry.comment = trimmed;
  } else {
    delete entry.comment;
  }
}

function clearNoteEditorState() {
  noteEditingKey = null;
  noteDraft = "";
  noteHadSavedText = false;
  noteEditorDiscarding = false;
}

function openNoteEditor(dayKey, rowIndex, entryIndex) {
  const entry = getEntry(dayKey, rowIndex, entryIndex);
  if (!entry) return;
  closeContextMenu();
  hideTimestampPopup();
  noteEditingKey = entryKey(dayKey, rowIndex, entryIndex);
  noteDraft = entry.comment || "";
  noteHadSavedText = Boolean(entry.comment);
  noteEditorDiscarding = false;
  renderRows();
}

function commitNoteEditor(dayKey, rowIndex, entryIndex) {
  const trimmed = noteDraft.trim();
  if (!trimmed) {
    if (noteHadSavedText) {
      deleteEntryComment(dayKey, rowIndex, entryIndex);
    } else {
      cancelNoteEditor();
    }
    return;
  }
  setEntryComment(dayKey, rowIndex, entryIndex, noteDraft);
  clearNoteEditorState();
  renderRows();
}

function cancelNoteEditor() {
  clearNoteEditorState();
  renderRows();
}

function deleteEntryComment(dayKey, rowIndex, entryIndex) {
  const key = entryKey(dayKey, rowIndex, entryIndex);
  if (noteEditingKey === key) {
    clearNoteEditorState();
  }
  setEntryComment(dayKey, rowIndex, entryIndex, "");
  renderRows();
}

function createMenuButton(label, { danger = false, onClick } = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = danger ? "btn-action btn-action-danger" : "btn-action";
  btn.textContent = label;
  btn.setAttribute("role", "menuitem");
  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    closeContextMenu();
    onClick?.();
  });
  return btn;
}

function openDurationMenu(dayKey, rowIndex, entryIndex, clientX, clientY, mode) {
  closeContextMenu();
  hideTimestampPopup();

  const entry = getEntry(dayKey, rowIndex, entryIndex);
  if (!entry) return;

  const menu = document.createElement("div");
  menu.className = "context-menu";
  menu.setAttribute("role", "menu");

  const hasComment = Boolean(entry.comment);

  if (mode === "context" && hasComment) {
    menu.append(
      createMenuButton("Edit", {
        onClick: () => openNoteEditor(dayKey, rowIndex, entryIndex),
      }),
      createMenuButton("Delete", {
        danger: true,
        onClick: () => deleteEntryComment(dayKey, rowIndex, entryIndex),
      }),
    );
  } else {
    menu.append(
      createMenuButton("Note", {
        onClick: () => openNoteEditor(dayKey, rowIndex, entryIndex),
      }),
    );
  }

  document.body.append(menu);
  contextMenuEl = menu;

  const { offsetWidth, offsetHeight } = menu;
  const x = Math.min(clientX, window.innerWidth - offsetWidth - 8);
  const y = Math.min(clientY, window.innerHeight - offsetHeight - 8);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;
}

function renderNoteComposer(dayKey, rowIndex, entryIndex) {
  const wrap = document.createElement("div");
  wrap.className = "duration-note-composer";

  const input = document.createElement("textarea");
  input.className = "duration-note-input";
  input.rows = 2;
  input.value = noteDraft;
  input.placeholder = "What did you work on?";
  input.setAttribute("aria-label", "Note");
  input.addEventListener("input", (event) => {
    noteDraft = event.target.value;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      commitNoteEditor(dayKey, rowIndex, entryIndex);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelNoteEditor();
    }
  });
  input.addEventListener("blur", () => {
    queueMicrotask(() => {
      if (noteEditingKey !== entryKey(dayKey, rowIndex, entryIndex)) return;
      if (noteEditorDiscarding) return;
      if (wrap.contains(document.activeElement)) return;
      cancelNoteEditor();
    });
  });

  const actions = document.createElement("div");
  actions.className = "duration-note-actions";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn-note";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
    noteEditorDiscarding = true;
  });
  cancelBtn.addEventListener("click", () => {
    cancelNoteEditor();
  });

  const submitBtn = document.createElement("button");
  submitBtn.type = "button";
  submitBtn.className = "btn-note btn-note-submit";
  submitBtn.textContent = "Submit";
  submitBtn.addEventListener("mousedown", (event) => {
    event.preventDefault();
  });
  submitBtn.addEventListener("click", () => {
    commitNoteEditor(dayKey, rowIndex, entryIndex);
  });

  actions.append(cancelBtn, submitBtn);
  wrap.append(input, actions);
  queueMicrotask(() => {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return wrap;
}

function syncEntryHeights() {
  logEl.querySelectorAll(".log-row").forEach((row) => {
    const durationWraps = row.querySelectorAll(".duration-entry-wrap");
    const totalWraps = row.querySelectorAll(".total-entry-wrap");
    durationWraps.forEach((durationWrap, i) => {
      const totalWrap = totalWraps[i];
      if (!totalWrap) return;
      durationWrap.style.minHeight = "";
      totalWrap.style.minHeight = "";
      const height = Math.max(durationWrap.offsetHeight, totalWrap.offsetHeight);
      durationWrap.style.minHeight = `${height}px`;
      totalWrap.style.minHeight = `${height}px`;
    });
  });
}

function onDurationClick(event) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const dayKey = button.dataset.day;
  const rowIndex = Number(button.dataset.row);
  const entryIndex = Number(button.dataset.entry);
  if (!dayKey || !Number.isInteger(rowIndex) || !Number.isInteger(entryIndex)) return;

  openDurationMenu(dayKey, rowIndex, entryIndex, event.clientX, event.clientY, "click");
}

function onDurationContextMenu(event) {
  event.preventDefault();
  event.stopPropagation();

  const button = event.currentTarget;
  const dayKey = button.dataset.day;
  const rowIndex = Number(button.dataset.row);
  const entryIndex = Number(button.dataset.entry);
  if (!dayKey || !Number.isInteger(rowIndex) || !Number.isInteger(entryIndex)) return;

  const entry = getEntry(dayKey, rowIndex, entryIndex);
  if (!entry?.comment) {
    openDurationMenu(dayKey, rowIndex, entryIndex, event.clientX, event.clientY, "click");
    return;
  }

  openDurationMenu(dayKey, rowIndex, entryIndex, event.clientX, event.clientY, "context");
}

function onDurationMouseEnter(event) {
  if (contextMenuEl || noteEditingKey) return;
  const button = event.currentTarget;
  const loggedAt = button.dataset.loggedAt;
  if (!loggedAt) return;
  showTimestampPopup(event.clientX, event.clientY, loggedAt);
}

function onDurationMouseMove(event) {
  if (contextMenuEl || noteEditingKey) return;
  if (!timestampPopupEl) return;
  const button = event.currentTarget;
  const loggedAt = button.dataset.loggedAt;
  if (!loggedAt) return;
  showTimestampPopup(event.clientX, event.clientY, loggedAt);
}

function onDurationMouseLeave() {
  hideTimestampPopup();
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

function renderDayTable(dayKey, rows) {
  const dayDate = dateFromDayKey(dayKey);
  const dateLabel = formatDate(dayDate);
  const solLabel = `Sol ${daysSinceMay22(dayDate)}`;

  const bodyHtml = rows
    .map((row, index) => {
      const totals = runningTotals(row.durations);
      const durationBlocks = row.durations
        .map((entry, i) => {
          const key = entryKey(dayKey, index, i);
          const isEditing = noteEditingKey === key;
          const noteHtml =
            !isEditing && entry.comment
              ? `<div class="duration-note">${escapeHtml(entry.comment)}</div>`
              : "";
          return `
            <div class="duration-entry-wrap" data-day="${dayKey}" data-row="${index}" data-entry="${i}">
              <button type="button" class="duration-entry" data-day="${dayKey}" data-row="${index}" data-entry="${i}" data-logged-at="${escapeHtml(entry.loggedAt)}">${escapeHtml(formatEntryLabel(row, entry))}</button>
              ${noteHtml}
            </div>
          `;
        })
        .join("");
      const totalBlocks = totals
        .map(
          (total) =>
            `<div class="total-entry-wrap"><div class="total-line">${escapeHtml(formatDuration(total))}</div></div>`,
        )
        .join("");

      return `
        <tr
          class="log-row"
          draggable="true"
          data-day="${dayKey}"
          data-index="${index}"
        >
          <td>
            <div class="category-label">
              <span class="drag-hint" aria-hidden="true">⠿</span>
              <span>${escapeHtml(row.category)}</span>
            </div>
          </td>
          <td>
            <div class="duration-lines">${durationBlocks}</div>
          </td>
          <td>
            <div class="total-lines">${totalBlocks}</div>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <table class="log-table" data-day="${dayKey}" aria-label="Daily activity log for ${escapeHtml(dateLabel)}">
      <thead>
        <tr>
          <th scope="col" class="day-date-cell" data-day="${dayKey}">
            <button type="button" class="day-date-btn" data-day="${dayKey}" title="Edit date">${escapeHtml(dateLabel)}</button>
          </th>
          <th scope="col">${escapeHtml(solLabel)}</th>
          <th scope="col">Total time</th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
    </table>
  `;
}

function renderRows() {
  syncActiveDay();
  hideTimestampPopup();
  closeContextMenu();
  saveDays();

  const dayKeys = sortedDayKeys();

  if (dayKeys.length === 0) {
    logEl.hidden = true;
    logEl.innerHTML = "";
    return;
  }

  logEl.hidden = false;
  logEl.innerHTML = dayKeys.map((key) => renderDayTable(key, state.days[key])).join("");

  bindDragHandlers();
  bindDurationInteractions();
  bindDateEditors();
  mountDateEditor();
  mountNoteComposer();
  syncEntryHeights();
}

function mountNoteComposer() {
  const parsed = parseEntryKey(noteEditingKey);
  if (!parsed) return;
  const { dayKey, rowIndex, entryIndex } = parsed;
  if (!getEntry(dayKey, rowIndex, entryIndex)) {
    clearNoteEditorState();
    return;
  }

  const wrap = logEl.querySelector(
    `.duration-entry-wrap[data-day="${dayKey}"][data-row="${rowIndex}"][data-entry="${entryIndex}"]`,
  );
  if (!wrap) return;
  wrap.append(renderNoteComposer(dayKey, rowIndex, entryIndex));
}

function bindDurationInteractions() {
  logEl.querySelectorAll(".duration-entry").forEach((button) => {
    button.addEventListener("click", onDurationClick);
    button.addEventListener("contextmenu", onDurationContextMenu);
    button.addEventListener("mouseenter", onDurationMouseEnter);
    button.addEventListener("mousemove", onDurationMouseMove);
    button.addEventListener("mouseleave", onDurationMouseLeave);
    button.addEventListener("mousedown", (event) => event.stopPropagation());
    button.addEventListener("dragstart", (event) => event.preventDefault());
  });

  logEl.querySelectorAll(".duration-note").forEach((noteEl) => {
    const wrap = noteEl.closest(".duration-entry-wrap");
    if (!wrap) return;
    const dayKey = wrap.dataset.day;
    const rowIndex = Number(wrap.dataset.row);
    const entryIndex = Number(wrap.dataset.entry);
    noteEl.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDurationMenu(dayKey, rowIndex, entryIndex, event.clientX, event.clientY, "context");
    });
    noteEl.addEventListener("mousedown", (event) => event.stopPropagation());
  });
}

function bindDragHandlers() {
  const rowNodes = logEl.querySelectorAll(".log-row");

  rowNodes.forEach((row) => {
    row.addEventListener("dragstart", onDragStart);
    row.addEventListener("dragend", onDragEnd);
    row.addEventListener("dragover", onDragOver);
    row.addEventListener("dragleave", onDragLeave);
    row.addEventListener("drop", onDrop);
  });
}

function onDragStart(event) {
  if (
    event.target.closest(".duration-entry") ||
    event.target.closest(".duration-note-composer") ||
    event.target.closest(".duration-note")
  ) {
    event.preventDefault();
    return;
  }
  const dayKey = event.currentTarget.dataset.day;
  const index = Number(event.currentTarget.dataset.index);
  state.dragDayKey = dayKey;
  state.dragIndex = index;
  event.currentTarget.classList.add("is-dragging");
  event.dataTransfer.effectAllowed = "move";
  event.dataTransfer.setData("text/plain", `${dayKey}:${index}`);
}

function onDragEnd(event) {
  event.currentTarget.classList.remove("is-dragging");
  logEl
    .querySelectorAll(".is-drag-over")
    .forEach((el) => el.classList.remove("is-drag-over"));
  state.dragDayKey = null;
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
  const dayKey = event.currentTarget.dataset.day;
  const toIndex = Number(event.currentTarget.dataset.index);
  const fromIndex = state.dragIndex;
  const fromDay = state.dragDayKey;

  event.currentTarget.classList.remove("is-drag-over");

  if (
    !dayKey ||
    fromDay !== dayKey ||
    fromIndex === null ||
    Number.isNaN(toIndex) ||
    fromIndex === toIndex
  ) {
    return;
  }

  const rows = rowsFor(dayKey);
  const [moved] = rows.splice(fromIndex, 1);
  rows.splice(toIndex, 0, moved);
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
  if (contextMenuEl && !contextMenuEl.contains(event.target)) {
    closeContextMenu();
  }
  if (!timestampPopupEl) return;
  if (event.target.closest(".duration-entry")) return;
  if (event.target.closest(".timestamp-popup")) return;
  hideTimestampPopup();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeContextMenu();
    hideTimestampPopup();
    if (dateEditingKey) {
      dateEditorDiscarding = true;
      cancelDateEditor();
    }
  }
});

window.addEventListener("scroll", () => {
  closeContextMenu();
  hideTimestampPopup();
}, true);

window.addEventListener("resize", () => {
  closeContextMenu();
  hideTimestampPopup();
  syncEntryHeights();
});

state.days = loadDays();
state.books = loadBooks();
activeDayKey = localDayKey();
saveDays(); // persist migration from legacy flat array if needed
renderRows();
updateComposerMode();
if (isReadingCategory() && getActiveBook()) {
  prefillPageFrom();
}
durationInput.focus();

function onPossibleDayChange() {
  if (!syncActiveDay()) return;
  renderRows();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onPossibleDayChange();
});
window.addEventListener("focus", onPossibleDayChange);

/**
 * Categories are renameable, so every lookup goes through a fixed `id` while the
 * `name` is only ever a label. Ids must never change — the Reading page-tracking
 * flow and the saved dropdown selection both key off them.
 */
const DEFAULT_CATEGORIES = [
  { id: "drafts-to-drive", name: "Drafts to Drive" },
  { id: "programming-figma-cad", name: "Programming • Figma • CAD" },
  { id: "reading", name: "Reading" },
  { id: "school", name: "School" },
  { id: "tds", name: "TDs" },
];
const READING_CATEGORY_ID = "reading";
const MAX_CATEGORY_NAME_LENGTH = 40;

const SOL_EPOCH = { month: 4, day: 22 }; // May 22 (0-indexed month)
const STORAGE_KEY = "habit-tracker-mvp:rows";
const BOOKS_STORAGE_KEY = "habit-tracker-mvp:reading-books";
const STOPWATCHES_STORAGE_KEY = "habit-tracker-mvp:stopwatches";
const BRIDGE_STOPWATCH_STORAGE_KEY = "habit-tracker-mvp:bridge-stopwatch";
const COLLAPSED_DAYS_STORAGE_KEY = "habit-tracker-mvp:collapsed-days";
const CATEGORIES_STORAGE_KEY = "habit-tracker-mvp:categories";
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Open next-book URL once when finished pages ÷ total ≥ this (0.8 = 80%). */
const NEXT_BOOK_OPEN_THRESHOLD = 0.8;
const PERSIST_DEBOUNCE_MS = 400;

const supabase = window.supabase.createClient(
  window.HABIT_SUPABASE.url,
  window.HABIT_SUPABASE.anonKey,
  {
    // No auth in this MVP — skip session storage so Tracking Prevention
    // (Safari/Edge) can't block the client when the library is third-party.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
      },
    },
  },
);

let daysPersistTimer = null;
let booksPersistTimer = null;
let stopwatchesPersistTimer = null;
let categoriesPersistTimer = null;
let collapsedDaysPersistTimer = null;
let daysPersistChain = Promise.resolve();
let booksPersistChain = Promise.resolve();
let stopwatchesPersistChain = Promise.resolve();
let categoriesPersistChain = Promise.resolve();
let collapsedDaysPersistChain = Promise.resolve();

const state = {
  days: {},
  collapsedDays: new Set(),
  categories: defaultCategories(),
  books: {
    activeBookId: null,
    books: [],
    nextBookUrl: "",
    openThreshold: NEXT_BOOK_OPEN_THRESHOLD,
    thresholdHistory: [],
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

/** Display duration as 1h 33m or 45m (whole minutes). */
function formatDuration(totalMinutes) {
  const minutes = Math.max(0, Math.floor(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours === 0) return `${mins}m`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** Exact duration for hover / sub-minute detail: 2s, 1m 5s, 1h 2m 3s. */
function formatExactDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) {
    if (mins === 0 && secs === 0) return `${hours}h`;
    if (secs === 0) return `${hours}h ${mins}m`;
    return `${hours}h ${mins}m ${secs}s`;
  }
  if (mins > 0) {
    if (secs === 0) return `${mins}m`;
    return `${mins}m ${secs}s`;
  }
  return `${secs}s`;
}

/** Entry / running-total label: sub-minute stays vague; otherwise whole minutes. */
function formatLoggedDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return "Less than a minute";
  return formatDuration(seconds / 60);
}

function entrySeconds(entry) {
  if (!entry || typeof entry !== "object") return 0;
  if (Number.isInteger(entry.seconds) && entry.seconds >= 0) return entry.seconds;
  const minutes = Number(entry.minutes);
  if (!Number.isFinite(minutes) || minutes < 0) return 0;
  return Math.round(minutes * 60);
}

/** 24h clock time for the timestamp popup. */
function formatClock24(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/**
 * Parse sloppy duration text into total seconds.
 * Rule 1: explicit units win (including seconds)
 * Rule 2: two bare numbers → hours + minutes
 * Rule 3: one bare number → minutes
 */
function parseDuration(raw) {
  if (typeof raw !== "string") return null;
  const text = raw.trim().toLowerCase().replace(/,/g, "");
  if (!text) return null;

  const hasUnit = /h|hr|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds|:/.test(
    text,
  );

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
    return (hours * 60 + minutes) * 60;
  }

  const single = text.match(/^(\d+(?:\.\d+)?)$/);
  if (single) {
    const value = Number(single[1]);
    if (!Number.isFinite(value) || value < 0) return null;
    if (!Number.isInteger(value)) return null;
    return value * 60;
  }

  return null;
}

function parseExplicitDuration(text) {
  const colon = text.match(/^(\d+)\s*:\s*(\d{1,2})(?:\s*:\s*(\d{1,2}))?$/);
  if (colon) {
    const hours = Number(colon[1]);
    const minutes = Number(colon[2]);
    const seconds = colon[3] != null ? Number(colon[3]) : 0;
    if (minutes > 59 || seconds > 59) return null;
    return hours * 3600 + minutes * 60 + seconds;
  }

  let remaining = text
    .replace(/\bhours?\b/g, "h")
    .replace(/\bhrs?\b/g, "h")
    .replace(/\bminutes?\b/g, "m")
    .replace(/\bmins?\b/g, "m")
    .replace(/\bseconds?\b/g, "s")
    .replace(/\bsecs?\b/g, "s");

  remaining = remaining.replace(/\s+/g, " ").trim();

  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  let matchedHour = false;
  let matchedMin = false;
  let matchedSec = false;
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

  const secMatch = remaining.match(/(\d+(?:\.\d+)?)\s*s\b/);
  if (secMatch) {
    seconds = Number(secMatch[1]);
    if (!Number.isFinite(seconds) || seconds < 0) return null;
    remaining = remaining.replace(secMatch[0], " ");
    matchedSec = true;
  }

  const trailing = remaining.match(/(\d+(?:\.\d+)?)/);
  if (trailing && matchedHour && !matchedMin && !matchedSec) {
    minutes = Number(trailing[1]);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 59) return null;
    remaining = remaining.replace(trailing[0], " ");
    matchedTrailing = true;
  }

  remaining = remaining.replace(/\s+/g, "").trim();
  if ((!matchedHour && !matchedMin && !matchedSec) || remaining.length > 0) return null;

  if (matchedHour && !matchedMin && !matchedSec && !matchedTrailing && !Number.isInteger(hours)) {
    return Math.round(hours * 3600);
  }

  if (!Number.isInteger(hours) && (matchedMin || matchedSec)) return null;
  if (!Number.isInteger(minutes)) return null;
  if (!Number.isInteger(seconds)) return null;

  return Math.round(hours) * 3600 + minutes * 60 + seconds;
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
    purchaseOpened: book.purchaseOpened === true,
  };
}

function emptyBooksState() {
  return {
    activeBookId: null,
    books: [],
    nextBookUrl: "",
    openThreshold: NEXT_BOOK_OPEN_THRESHOLD,
    thresholdHistory: [],
  };
}

function normalizeOpenThreshold(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 1) return NEXT_BOOK_OPEN_THRESHOLD;
  return n;
}

function normalizeThresholdHistory(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const percent = Number(item.percent);
    const at = typeof item.at === "string" ? item.at : "";
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) continue;
    if (!at) continue;
    entries.push({ at, percent });
  }
  return entries.slice(-3);
}

function normalizeBooksState(raw) {
  if (!raw || typeof raw !== "object") {
    return emptyBooksState();
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
  const nextBookUrl =
    typeof raw.nextBookUrl === "string" ? raw.nextBookUrl.trim() : "";
  return {
    activeBookId,
    books,
    nextBookUrl,
    openThreshold: normalizeOpenThreshold(raw.openThreshold),
    thresholdHistory: normalizeThresholdHistory(raw.thresholdHistory),
  };
}

function loadBooksFromLocal() {
  try {
    const raw = localStorage.getItem(BOOKS_STORAGE_KEY);
    if (!raw) return emptyBooksState();
    return normalizeBooksState(JSON.parse(raw));
  } catch {
    return emptyBooksState();
  }
}

function writeBooksLocal(booksState = state.books) {
  localStorage.setItem(BOOKS_STORAGE_KEY, JSON.stringify(booksState));
}

function bookRowFromState(book) {
  return {
    id: book.id,
    title: book.title || "",
    total_pages: book.totalPages,
    last_finished_page: book.lastFinishedPage,
    status: book.status,
    purchase_opened: book.purchaseOpened === true,
  };
}

function bookFromRow(row) {
  return normalizeBook({
    id: row.id,
    title: row.title,
    totalPages: row.total_pages,
    lastFinishedPage: row.last_finished_page,
    status: row.status,
    purchaseOpened: row.purchase_opened,
  });
}

async function loadBooksFromSupabase() {
  const [{ data: bookRows, error: booksError }, { data: settings, error: settingsError }] =
    await Promise.all([
      supabase.from("habit_tracker_books").select("*").order("created_at", { ascending: true }),
      supabase.from("habit_tracker_reading_settings").select("*").eq("id", 1).maybeSingle(),
    ]);

  if (booksError) throw booksError;
  if (settingsError) throw settingsError;

  const books = (bookRows || []).map(bookFromRow).filter(Boolean);
  const customizedSettings =
    !!settings &&
    (!!settings.active_book_id ||
      !!(settings.next_book_url && String(settings.next_book_url).trim()) ||
      (Array.isArray(settings.threshold_history) &&
        settings.threshold_history.length > 0) ||
      (typeof settings.open_threshold === "number" &&
        settings.open_threshold !== NEXT_BOOK_OPEN_THRESHOLD));

  // Empty seeded settings row alone does not count as remote data.
  if (books.length === 0 && !customizedSettings) return null;

  return normalizeBooksState({
    activeBookId: settings?.active_book_id ?? null,
    books,
    nextBookUrl: settings?.next_book_url ?? "",
    openThreshold: settings?.open_threshold ?? NEXT_BOOK_OPEN_THRESHOLD,
    thresholdHistory: settings?.threshold_history ?? [],
  });
}

async function loadBooks() {
  try {
    const remote = await loadBooksFromSupabase();
    if (remote) {
      writeBooksLocal(remote);
      return remote;
    }
  } catch (err) {
    console.error("Failed to load books from Supabase:", err);
  }
  return loadBooksFromLocal();
}

async function persistBooksToSupabase(booksState = state.books) {
  const desiredIds = new Set(booksState.books.map((b) => b.id));
  const { data: existing, error: existingError } = await supabase
    .from("habit_tracker_books")
    .select("id");
  if (existingError) throw existingError;

  const toDelete = (existing || [])
    .map((row) => row.id)
    .filter((id) => !desiredIds.has(id));
  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("habit_tracker_books")
      .delete()
      .in("id", toDelete);
    if (deleteError) throw deleteError;
  }

  if (booksState.books.length > 0) {
    const { error: upsertError } = await supabase
      .from("habit_tracker_books")
      .upsert(booksState.books.map(bookRowFromState));
    if (upsertError) throw upsertError;
  }

  const { error: settingsError } = await supabase.from("habit_tracker_reading_settings").upsert({
    id: 1,
    active_book_id: booksState.activeBookId,
    next_book_url: booksState.nextBookUrl || "",
    open_threshold: booksState.openThreshold,
    threshold_history: booksState.thresholdHistory || [],
    updated_at: new Date().toISOString(),
  });
  if (settingsError) throw settingsError;
}

function saveBooks() {
  writeBooksLocal();
  if (booksPersistTimer) clearTimeout(booksPersistTimer);
  booksPersistTimer = setTimeout(() => {
    booksPersistTimer = null;
    const snapshot = structuredClone(state.books);
    booksPersistChain = booksPersistChain
      .then(() => persistBooksToSupabase(snapshot))
      .catch((err) => console.error("Failed to save books to Supabase:", err));
  }, PERSIST_DEBOUNCE_MS);
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
    purchaseOpened: false,
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
  maybeOpenNextBookPurchase(book);
  return book;
}

function bookProgress(book) {
  if (!book || !(book.totalPages > 0)) return 0;
  return book.lastFinishedPage / book.totalPages;
}

/**
 * First automation: when progress crosses the threshold, open the saved
 * next-book URL once, then clear it so you pick the following book yourself.
 */
function maybeOpenNextBookPurchase(book) {
  if (!book || book.purchaseOpened) return;
  if (bookProgress(book) < state.books.openThreshold) return;

  const url = typeof state.books.nextBookUrl === "string"
    ? state.books.nextBookUrl.trim()
    : "";
  if (!url) return;

  const win = window.open(url, "_blank", "noopener,noreferrer");
  if (!win) return;

  book.purchaseOpened = true;
  state.books.nextBookUrl = "";
  saveBooks();
  syncNextBookUrlInput();
}

function updateActiveBookBookmark(pageTo) {
  const book = getActiveBook();
  if (!book) return;
  book.lastFinishedPage = Math.max(book.lastFinishedPage, pageTo);
  if (book.lastFinishedPage > book.totalPages) {
    book.lastFinishedPage = book.totalPages;
  }
  saveBooks();
  maybeOpenNextBookPurchase(book);
}

function maxFinishedPageForBook(bookId) {
  let max = 0;
  for (const rows of Object.values(state.days)) {
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!Array.isArray(row.durations)) continue;
      for (const entry of row.durations) {
        if (entry.bookId !== bookId) continue;
        if (Number.isInteger(entry.pageTo)) {
          max = Math.max(max, entry.pageTo);
        }
      }
    }
  }
  return max;
}

function recomputeBookBookmark(bookId) {
  const book = state.books.books.find((b) => b.id === bookId);
  if (!book) return;
  book.lastFinishedPage = maxFinishedPageForBook(bookId);
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

// --- Categories ---

function defaultCategories() {
  return DEFAULT_CATEGORIES.map((category) => ({ ...category }));
}

function normalizeCategoryName(raw) {
  return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
}

/** Saved names are merged onto the defaults by id, so the set of categories is fixed. */
function mergeCategoryEntries(entries) {
  const savedNames = new Map();
  for (const entry of entries || []) {
    if (!entry || typeof entry.id !== "string") continue;
    const name = normalizeCategoryName(entry.name);
    if (name) savedNames.set(entry.id, name);
  }

  const loaded = defaultCategories().map((category) => ({
    ...category,
    name: savedNames.get(category.id) || category.name,
  }));

  // A duplicate name would make two categories share one logged row.
  const seen = new Set();
  for (const category of loaded) {
    if (seen.has(category.name)) {
      category.name = DEFAULT_CATEGORIES.find((d) => d.id === category.id).name;
    }
    seen.add(category.name);
  }
  return loaded;
}

function categoriesAreCustomized(categories) {
  const defaults = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.name]));
  return (categories || []).some((c) => defaults.get(c.id) !== c.name);
}

function writeCategoriesLocal(categories = state.categories) {
  try {
    localStorage.setItem(CATEGORIES_STORAGE_KEY, JSON.stringify(categories));
  } catch {
    /* ignore quota / private mode */
  }
}

function loadCategoriesFromLocal() {
  try {
    const raw = localStorage.getItem(CATEGORIES_STORAGE_KEY);
    if (!raw) return defaultCategories();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return defaultCategories();
    return mergeCategoryEntries(parsed);
  } catch {
    return defaultCategories();
  }
}

async function loadCategoriesFromSupabase() {
  const { data, error } = await supabase
    .from("habit_tracker_categories")
    .select("id, name")
    .order("id", { ascending: true });
  if (error) throw error;
  if (!data || data.length === 0) return null;
  return mergeCategoryEntries(data);
}

async function persistCategoriesToSupabase(categories = state.categories) {
  const now = new Date().toISOString();
  const rows = categories.map((category) => ({
    id: category.id,
    name: category.name,
    updated_at: now,
  }));
  const { error } = await supabase.from("habit_tracker_categories").upsert(rows);
  if (error) throw error;
}

async function loadCategories() {
  const local = loadCategoriesFromLocal();
  try {
    const remote = await loadCategoriesFromSupabase();
    if (remote) {
      // Local renames beat a still-default remote seed (first sync after this feature).
      if (categoriesAreCustomized(local) && !categoriesAreCustomized(remote)) {
        await persistCategoriesToSupabase(local);
        writeCategoriesLocal(local);
        return local;
      }
      writeCategoriesLocal(remote);
      return remote;
    }
  } catch (err) {
    console.error("Failed to load categories from Supabase:", err);
  }
  return local;
}

function saveCategories() {
  writeCategoriesLocal();
  if (categoriesPersistTimer) clearTimeout(categoriesPersistTimer);
  categoriesPersistTimer = setTimeout(() => {
    categoriesPersistTimer = null;
    const snapshot = structuredClone(state.categories);
    categoriesPersistChain = categoriesPersistChain
      .then(() => persistCategoriesToSupabase(snapshot))
      .catch((err) =>
        console.error("Failed to save categories to Supabase:", err),
      );
  }, PERSIST_DEBOUNCE_MS);
}

function sortedCategories() {
  return [...state.categories].sort((a, b) => a.name.localeCompare(b.name));
}

function categoryById(id) {
  return state.categories.find((category) => category.id === id) || null;
}

function categoryNameError(id, rawName) {
  const name = normalizeCategoryName(rawName);
  if (!name) return "Name can’t be empty";
  if (name.length > MAX_CATEGORY_NAME_LENGTH) {
    return `Keep it under ${MAX_CATEGORY_NAME_LENGTH} characters`;
  }
  if (state.categories.some((other) => other.id !== id && other.name === name)) {
    return "Another category already has that name";
  }
  return null;
}

/** Logged rows store the display name, so renaming has to rewrite past entries. */
function relabelLoggedCategory(fromName, toName) {
  for (const rows of Object.values(state.days)) {
    if (!Array.isArray(rows)) continue;
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      const row = rows[i];
      if (row.category !== fromName) continue;
      const existing = rows.find((other) => other !== row && other.category === toName);
      if (existing) {
        existing.durations.push(...row.durations);
        rows.splice(i, 1);
      } else {
        row.category = toName;
      }
    }
  }
}

function renameCategory(id, rawName) {
  const category = categoryById(id);
  if (!category) return false;
  const name = normalizeCategoryName(rawName);
  if (name === category.name) return false;
  if (categoryNameError(id, name)) return false;

  const previousName = category.name;
  category.name = name;
  saveCategories();
  relabelLoggedCategory(previousName, name);
  return true;
}

// --- Rows / durations ---

function findRowIndex(dayKey, category) {
  return rowsFor(dayKey).findIndex((row) => row.category === category);
}

function normalizeDuration(entry) {
  if (!entry || typeof entry !== "object") return null;

  let seconds;
  if (Number.isInteger(entry.seconds) && entry.seconds >= 0) {
    seconds = entry.seconds;
  } else {
    const minutes = Number(entry.minutes);
    if (!Number.isFinite(minutes) || minutes < 0) return null;
    seconds = Math.round(minutes * 60);
  }
  if (!Number.isInteger(seconds) || seconds < 0) return null;

  const loggedAt =
    typeof entry.loggedAt === "string" && entry.loggedAt
      ? entry.loggedAt
      : new Date().toISOString();

  const normalized = {
    minutes: Math.floor(seconds / 60),
    seconds,
    loggedAt,
  };

  // Page data is kept whenever it's valid rather than when the category is named
  // "Reading", so renaming that category can't strip reading history on reload.
  const pageFrom = Number(entry.pageFrom);
  const pageTo = Number(entry.pageTo);
  if (
    Number.isInteger(pageFrom) &&
    Number.isInteger(pageTo) &&
    pageFrom >= 1 &&
    pageTo >= pageFrom
  ) {
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
  const durations = row.durations.map(normalizeDuration).filter(Boolean);
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
      const normalized = normalizeDuration(entry);
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

  if (state.collapsedDays.delete(fromKey)) {
    state.collapsedDays.add(toKey);
    saveCollapsedDays();
  }
  return true;
}

function loadDaysFromLocal() {
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

function daysPayload(days = state.days) {
  const toSave = {};
  for (const key of sortedDayKeys(days)) {
    toSave[key] = days[key];
  }
  return toSave;
}

function writeDaysLocal(days = state.days) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(daysPayload(days)));
}

async function loadDaysFromSupabase() {
  const { data, error } = await supabase
    .from("habit_tracker_log_days")
    .select("day_key, rows");
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const days = {};
  for (const row of data) {
    const key =
      typeof row.day_key === "string"
        ? row.day_key.slice(0, 10)
        : String(row.day_key).slice(0, 10);
    if (!DAY_KEY_RE.test(key)) continue;
    const rows = normalizeDayRows(row.rows);
    if (rows.length > 0) days[key] = rows;
  }
  return days;
}

async function loadDays() {
  try {
    const remote = await loadDaysFromSupabase();
    if (remote) {
      writeDaysLocal(remote);
      return remote;
    }
  } catch (err) {
    console.error("Failed to load days from Supabase:", err);
  }
  return loadDaysFromLocal();
}

async function persistDaysToSupabase(days = state.days) {
  const payload = daysPayload(days);
  const keepKeys = Object.keys(payload);

  const { data: existing, error: existingError } = await supabase
    .from("habit_tracker_log_days")
    .select("day_key");
  if (existingError) throw existingError;

  const keep = new Set(keepKeys);
  const toDelete = (existing || [])
    .map((row) =>
      typeof row.day_key === "string"
        ? row.day_key.slice(0, 10)
        : String(row.day_key).slice(0, 10),
    )
    .filter((key) => !keep.has(key));

  if (toDelete.length > 0) {
    const { error: deleteError } = await supabase
      .from("habit_tracker_log_days")
      .delete()
      .in("day_key", toDelete);
    if (deleteError) throw deleteError;
  }

  if (keepKeys.length === 0) return;

  const now = new Date().toISOString();
  const rows = keepKeys.map((day_key) => ({
    day_key,
    rows: payload[day_key],
    updated_at: now,
  }));
  const { error: upsertError } = await supabase
    .from("habit_tracker_log_days")
    .upsert(rows);
  if (upsertError) throw upsertError;
}

function saveDays() {
  writeDaysLocal();
  if (daysPersistTimer) clearTimeout(daysPersistTimer);
  daysPersistTimer = setTimeout(() => {
    daysPersistTimer = null;
    const snapshot = structuredClone(daysPayload());
    daysPersistChain = daysPersistChain
      .then(() => persistDaysToSupabase(snapshot))
      .catch((err) => console.error("Failed to save days to Supabase:", err));
  }, PERSIST_DEBOUNCE_MS);
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
  let sumSeconds = 0;
  return durations.map((entry) => {
    sumSeconds += entrySeconds(entry);
    return sumSeconds;
  });
}

/** Sum of every logged entry across all categories for one day. */
function dayTotalSeconds(rows) {
  let sum = 0;
  for (const row of rows || []) {
    if (!Array.isArray(row.durations)) continue;
    for (const entry of row.durations) {
      sum += entrySeconds(entry);
    }
  }
  return sum;
}

function formatReadingEntry(entry) {
  return `${formatLoggedDuration(entrySeconds(entry))} ${entry.pageFrom}-${entry.pageTo}`;
}

function formatEntryLabel(entry) {
  if (entry.pageFrom != null && entry.pageTo != null) {
    return formatReadingEntry(entry);
  }
  return formatLoggedDuration(entrySeconds(entry));
}

function syncActiveDay() {
  const today = localDayKey();
  if (activeDayKey === today) return false;
  activeDayKey = today;
  return true;
}

// --- Collapsed days (synced UI preference) ---

function normalizeCollapsedDayKeys(keys) {
  if (!Array.isArray(keys)) return [];
  return [...new Set(keys.filter((key) => typeof key === "string" && DAY_KEY_RE.test(key)))].sort();
}

function writeCollapsedDaysLocal(keys = [...state.collapsedDays]) {
  try {
    localStorage.setItem(
      COLLAPSED_DAYS_STORAGE_KEY,
      JSON.stringify(normalizeCollapsedDayKeys(keys)),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function loadCollapsedDaysFromLocal() {
  try {
    const raw = localStorage.getItem(COLLAPSED_DAYS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(normalizeCollapsedDayKeys(parsed));
  } catch {
    return new Set();
  }
}

async function loadCollapsedDaysFromSupabase() {
  const { data, error } = await supabase
    .from("habit_tracker_ui_settings")
    .select("collapsed_days")
    .eq("id", 1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return new Set(normalizeCollapsedDayKeys(data.collapsed_days));
}

async function persistCollapsedDaysToSupabase(keys = [...state.collapsedDays]) {
  const collapsed_days = normalizeCollapsedDayKeys(keys);
  const { error } = await supabase.from("habit_tracker_ui_settings").upsert({
    id: 1,
    collapsed_days,
    updated_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function loadCollapsedDays() {
  const local = loadCollapsedDaysFromLocal();
  try {
    const remote = await loadCollapsedDaysFromSupabase();
    if (remote) {
      // First sync after this feature: keep any local folds if remote is still empty.
      if (local.size > 0 && remote.size === 0) {
        await persistCollapsedDaysToSupabase([...local]);
        writeCollapsedDaysLocal([...local]);
        return local;
      }
      writeCollapsedDaysLocal([...remote]);
      return remote;
    }
  } catch (err) {
    console.error("Failed to load collapsed days from Supabase:", err);
  }
  return local;
}

function saveCollapsedDays() {
  writeCollapsedDaysLocal();
  if (collapsedDaysPersistTimer) clearTimeout(collapsedDaysPersistTimer);
  collapsedDaysPersistTimer = setTimeout(() => {
    collapsedDaysPersistTimer = null;
    const snapshot = [...state.collapsedDays];
    collapsedDaysPersistChain = collapsedDaysPersistChain
      .then(() => persistCollapsedDaysToSupabase(snapshot))
      .catch((err) =>
        console.error("Failed to save collapsed days to Supabase:", err),
      );
  }, PERSIST_DEBOUNCE_MS);
}

function isDayCollapsed(dayKey) {
  return state.collapsedDays.has(dayKey);
}

function toggleDayCollapsed(dayKey) {
  if (state.collapsedDays.has(dayKey)) {
    state.collapsedDays.delete(dayKey);
  } else {
    state.collapsedDays.add(dayKey);
  }
  saveCollapsedDays();
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

  const dateBtn = cell.querySelector(".day-date-btn");
  if (dateBtn) {
    dateBtn.replaceWith(input);
  } else {
    cell.prepend(input);
  }
  queueMicrotask(() => {
    input.focus();
    input.select();
  });
}

function bindDayHeaderControls() {
  logEl.querySelectorAll(".day-date-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dayKey = button.dataset.day;
      if (!dayKey) return;
      openDateEditor(dayKey);
    });
  });

  logEl.querySelectorAll(".day-collapse-btn").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const dayKey = button.dataset.day;
      if (!dayKey) return;
      toggleDayCollapsed(dayKey);
      renderRows();
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

function showTimestampPopup(clientX, clientY, entry) {
  hideTimestampPopup();

  const date = new Date(entry?.loggedAt);
  const timeLabel = Number.isNaN(date.getTime()) ? "—" : formatClock24(date);
  const seconds = entrySeconds(entry);

  const popup = document.createElement("div");
  popup.className = "timestamp-popup";
  popup.setAttribute("role", "tooltip");

  const timeEl = document.createElement("div");
  timeEl.className = "timestamp-popup-time";
  timeEl.textContent = timeLabel;
  popup.append(timeEl);

  // Exact duration is only useful when the log says "Less than a minute".
  if (seconds < 60) {
    const actualEl = document.createElement("div");
    actualEl.className = "timestamp-popup-actual";
    actualEl.textContent = formatExactDuration(seconds);
    popup.append(actualEl);
  }

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

function deleteEntry(dayKey, rowIndex, entryIndex) {
  const rows = state.days[dayKey];
  if (!rows) return;
  const row = rows[rowIndex];
  if (!row || !Array.isArray(row.durations)) return;
  const entry = row.durations[entryIndex];
  if (!entry) return;

  if (noteEditingKey) clearNoteEditorState();

  const bookId = typeof entry.bookId === "string" && entry.bookId ? entry.bookId : null;
  row.durations.splice(entryIndex, 1);

  if (row.durations.length === 0) {
    rows.splice(rowIndex, 1);
  }
  if (rows.length === 0) {
    delete state.days[dayKey];
    if (state.collapsedDays.delete(dayKey)) saveCollapsedDays();
  }

  if (bookId) {
    recomputeBookBookmark(bookId);
    if (isReadingCategory()) {
      prefillPageFrom();
      updateComposerMode();
    }
  }

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
      createMenuButton("Delete note", {
        danger: true,
        onClick: () => deleteEntryComment(dayKey, rowIndex, entryIndex),
      }),
    );
  } else {
    menu.append(
      createMenuButton("Note", {
        onClick: () => openNoteEditor(dayKey, rowIndex, entryIndex),
      }),
      createMenuButton("Delete", {
        danger: true,
        onClick: () => deleteEntry(dayKey, rowIndex, entryIndex),
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
  const dayKey = button.dataset.day;
  const rowIndex = Number(button.dataset.row);
  const entryIndex = Number(button.dataset.entry);
  if (!dayKey || !Number.isInteger(rowIndex) || !Number.isInteger(entryIndex)) return;
  const entry = getEntry(dayKey, rowIndex, entryIndex);
  if (!entry) return;
  showTimestampPopup(event.clientX, event.clientY, entry);
}

function onDurationMouseMove(event) {
  if (contextMenuEl || noteEditingKey) return;
  if (!timestampPopupEl) return;
  const button = event.currentTarget;
  const dayKey = button.dataset.day;
  const rowIndex = Number(button.dataset.row);
  const entryIndex = Number(button.dataset.entry);
  if (!dayKey || !Number.isInteger(rowIndex) || !Number.isInteger(entryIndex)) return;
  const entry = getEntry(dayKey, rowIndex, entryIndex);
  if (!entry) return;
  showTimestampPopup(event.clientX, event.clientY, entry);
}

function onDurationMouseLeave() {
  hideTimestampPopup();
}

// --- Composer / Reading UI ---

/** The dropdown's option values are category ids, so renames don't disturb it. */
function syncCategoryOptions() {
  const selectedId = categorySelect.value;
  categorySelect.replaceChildren();
  for (const category of sortedCategories()) {
    const option = document.createElement("option");
    option.value = category.id;
    option.textContent = category.name;
    categorySelect.append(option);
  }
  categorySelect.value = categoryById(selectedId)
    ? selectedId
    : (sortedCategories()[0]?.id ?? "");
}

function isReadingCategory() {
  return categorySelect.value === READING_CATEGORY_ID;
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
              <button type="button" class="duration-entry" data-day="${dayKey}" data-row="${index}" data-entry="${i}" data-logged-at="${escapeHtml(entry.loggedAt)}">${escapeHtml(formatEntryLabel(entry))}</button>
              ${noteHtml}
            </div>
          `;
        })
        .join("");
      const totalBlocks = totals
        .map(
          (totalSeconds) =>
            `<div class="total-entry-wrap"><div class="total-line">${escapeHtml(formatLoggedDuration(totalSeconds))}</div></div>`,
        )
        .join("");

      return `
        <tr
          class="log-row"
          data-day="${dayKey}"
          data-index="${index}"
        >
          <td>
            <div class="category-label">
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

  const collapsed = isDayCollapsed(dayKey);
  const dayTotal = dayTotalSeconds(rows);

  return `
    <table class="log-table${collapsed ? " is-collapsed" : ""}" data-day="${dayKey}" aria-label="Daily activity log for ${escapeHtml(dateLabel)}">
      <thead>
        <tr>
          <th scope="col" class="day-date-cell" data-day="${dayKey}">
            <button type="button" class="day-date-btn" data-day="${dayKey}" title="Edit date">${escapeHtml(dateLabel)}</button>
            <button
              type="button"
              class="day-collapse-btn"
              data-day="${dayKey}"
              aria-expanded="${collapsed ? "false" : "true"}"
              aria-label="${collapsed ? "Show" : "Hide"} entries for ${escapeHtml(dateLabel)}"
            ><span class="day-collapse-caret" aria-hidden="true">▾</span></button>
          </th>
          <th scope="col">${escapeHtml(solLabel)}</th>
          <th scope="col">Total time</th>
        </tr>
      </thead>
      <tbody>${bodyHtml}</tbody>
      <tfoot>
        <tr class="day-total-row">
          <td></td>
          <td></td>
          <td>
            <div class="day-total" title="Total for this day">${escapeHtml(formatLoggedDuration(dayTotal))}</div>
          </td>
        </tr>
      </tfoot>
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

  bindDurationInteractions();
  bindDayHeaderControls();
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

function commitDuration(categoryId, totalSeconds) {
  const category = categoryById(categoryId);
  if (!category || !Number.isFinite(totalSeconds) || totalSeconds < 1) {
    return false;
  }

  const seconds = Math.floor(totalSeconds);
  const minutes = Math.floor(seconds / 60);

  if (categoryId === READING_CATEGORY_ID) {
    const book = getActiveBook();
    if (!book) {
      categorySelect.value = READING_CATEGORY_ID;
      updateComposerMode();
      openBookDialog("new");
      return false;
    }

    const pageFrom = parsePageNumber(pageFromInput.value);
    const pageTo = parsePageNumber(pageToInput.value);

    if (pageFrom === null) {
      categorySelect.value = READING_CATEGORY_ID;
      updateComposerMode();
      pageFromInput.setCustomValidity("Enter a start page");
      pageFromInput.reportValidity();
      return false;
    }

    if (pageTo === null) {
      categorySelect.value = READING_CATEGORY_ID;
      updateComposerMode();
      pageToInput.setCustomValidity("Enter an end page");
      pageToInput.reportValidity();
      return false;
    }

    if (pageFrom > pageTo) {
      categorySelect.value = READING_CATEGORY_ID;
      updateComposerMode();
      pageToInput.setCustomValidity("End page must be ≥ start");
      pageToInput.reportValidity();
      return false;
    }

    if (pageTo > book.totalPages || pageFrom > book.totalPages) {
      categorySelect.value = READING_CATEGORY_ID;
      updateComposerMode();
      pageToInput.setCustomValidity(`Book only has ${book.totalPages} pages`);
      pageToInput.reportValidity();
      return false;
    }

    pageToInput.setCustomValidity("");
    pageFromInput.setCustomValidity("");

    upsertDuration(category.name, {
      minutes,
      seconds,
      loggedAt: new Date().toISOString(),
      pageFrom,
      pageTo,
      bookId: book.id,
    });
    updateActiveBookBookmark(pageTo);

    pageToInput.value = "";
    prefillPageFrom();
    updateComposerMode();
    renderRows();
    return true;
  }

  upsertDuration(category.name, {
    minutes,
    seconds,
    loggedAt: new Date().toISOString(),
  });
  renderRows();
  return true;
}

function onSubmit(event) {
  event.preventDefault();

  const categoryId = categorySelect.value;
  const raw = durationInput.value.trim();

  if (!categoryById(categoryId) || !raw) {
    return;
  }

  const seconds = parseDuration(raw);
  if (seconds === null || seconds < 1) {
    durationInput.setCustomValidity("Couldn’t read that time");
    durationInput.reportValidity();
    return;
  }
  durationInput.setCustomValidity("");

  if (!commitDuration(categoryId, seconds)) return;

  durationInput.value = "";
  durationInput.focus();
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

  if (pendingReadingTransferId != null) {
    const sw = stopwatches[pendingReadingTransferId];
    pendingReadingTransferId = null;
    if (sw) {
      setActiveSideTab("timers");
      showReadingTransferFields(sw);
      return;
    }
  }

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
  pendingReadingTransferId = null;
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

state.days = {};
state.books = emptyBooksState();
state.collapsedDays = loadCollapsedDaysFromLocal();
activeDayKey = localDayKey();

function onPossibleDayChange() {
  if (!syncActiveDay()) return;
  renderRows();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") onPossibleDayChange();
});
window.addEventListener("focus", onPossibleDayChange);

/* —— Right-side tool rail + stopwatches —— */
const sideTabs = document.querySelectorAll(".side-tab");
const sidePanels = document.querySelectorAll(".side-panel");
const timersPanel = document.getElementById("panel-timers");
const stopwatchListEl = document.getElementById("stopwatch-list");
const stopwatchAddBtn = document.getElementById("stopwatch-add");
const stopwatchRemoveBtn = document.getElementById("stopwatch-remove");
const bridgeStopwatchRoot = document.getElementById("bridge-stopwatch");
const bridgeStopwatchPicker = document.getElementById("bridge-stopwatch-picker");
const stopwatchAdjustMinutes = document.getElementById("stopwatch-adjust-minutes");
const stopwatchAdjustSeconds = document.getElementById("stopwatch-adjust-seconds");
const stopwatchAdjustPicker = document.getElementById("stopwatch-adjust-picker");
const nextBookUrlInput = document.getElementById("next-book-url");
const nextBookPasteBtn = document.getElementById("next-book-paste");
const openThresholdInput = document.getElementById("open-threshold-input");
const openThresholdUpdateBtn = document.getElementById("open-threshold-update");
const thresholdHistoryEl = document.getElementById("threshold-history");
const categoryEditorEl = document.getElementById("category-editor");

const MIN_STOPWATCHES = 1;
const MAX_STOPWATCHES = 4;

/** @type {{ id: number, elapsedMs: number, running: boolean, startedAt: number|null, intervalId: number|null, root: HTMLElement }[]} */
let stopwatches = [];

/** Dedicated adjust stopwatch — measure overlap, then add/subtract onto a numbered timer. */
/** @type {{ elapsedMs: number, running: boolean, startedAt: number|null, intervalId: number|null, root: HTMLElement|null }} */
let bridgeStopwatch = {
  elapsedMs: 0,
  running: false,
  startedAt: null,
  intervalId: null,
  root: bridgeStopwatchRoot,
};

/** Pending time adjust: positive = add, negative = subtract (ms). null = picker hidden. */
let pendingAdjustDeltaMs = null;
/** Which picker owns the pending adjust: "manual" | "bridge" | null */
let pendingAdjustSource = null;

const DEFAULT_DOCUMENT_TITLE = document.title || "Daily Log";

/** Stopwatch waiting on a new book before showing Reading page fields. */
let pendingReadingTransferId = null;

function setActiveSideTab(tabId) {
  for (const tab of sideTabs) {
    const selected = tab.dataset.tab === tabId;
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of sidePanels) {
    panel.hidden = panel.dataset.panel !== tabId;
  }
  if (tabId !== "timers") {
    closeTransferMenus();
    hideStopwatchReadingFields();
    hideStopwatchAdjustPicker();
  }
  if (tabId !== "categories") {
    // Drop any half-typed rename so the panel reopens showing saved names.
    renderCategoryEditor();
  }
}

/* —— Category renaming panel —— */

function showCategoryNameError(row, message) {
  const error = row.querySelector(".category-error");
  if (!error) return;
  error.textContent = message || "";
  error.hidden = !message;
  row.classList.toggle("has-error", Boolean(message));
}

function commitCategoryRename(id, input, row) {
  const category = categoryById(id);
  if (!category) return;

  const nextName = normalizeCategoryName(input.value);
  if (nextName === category.name) {
    input.value = category.name;
    showCategoryNameError(row, "");
    return;
  }

  const error = categoryNameError(id, nextName);
  if (error) {
    showCategoryNameError(row, error);
    return;
  }

  showCategoryNameError(row, "");
  if (!renameCategory(id, nextName)) return;

  syncCategoryOptions();
  buildTransferMenus();
  renderCategoryEditor();
  renderRows();
  updateComposerMode();
}

function renderCategoryEditor() {
  if (!categoryEditorEl) return;
  categoryEditorEl.replaceChildren();

  for (const category of sortedCategories()) {
    const row = document.createElement("div");
    row.className = "category-editor-row";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "composer-input category-name-input";
    input.value = category.name;
    input.maxLength = MAX_CATEGORY_NAME_LENGTH;
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-label", `Rename ${category.name}`);

    const error = document.createElement("p");
    error.className = "category-error";
    error.hidden = true;

    input.addEventListener("input", () => showCategoryNameError(row, ""));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commitCategoryRename(category.id, input, row);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        input.value = categoryById(category.id)?.name ?? "";
        showCategoryNameError(row, "");
      }
    });
    input.addEventListener("blur", () => {
      commitCategoryRename(category.id, input, row);
    });

    row.append(input, error);
    categoryEditorEl.append(row);
  }
}

function syncNextBookUrlInput() {
  if (!nextBookUrlInput) return;
  nextBookUrlInput.value = state.books.nextBookUrl || "";
}

function syncOpenThresholdInput() {
  if (!openThresholdInput) return;
  const percent = Math.round((state.books.openThreshold || NEXT_BOOK_OPEN_THRESHOLD) * 100);
  openThresholdInput.value = String(percent);
}

function formatThresholdHistoryAt(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function renderThresholdHistory() {
  if (!thresholdHistoryEl) return;
  thresholdHistoryEl.replaceChildren();
  const history = Array.isArray(state.books.thresholdHistory)
    ? state.books.thresholdHistory
    : [];
  for (const entry of history) {
    const li = document.createElement("li");
    li.className = "threshold-history-item";
    li.textContent = `${entry.percent}% · ${formatThresholdHistoryAt(entry.at)}`;
    thresholdHistoryEl.append(li);
  }
}

function updateOpenThresholdFromInput() {
  if (!openThresholdInput) return;
  const raw = digitsOnly(openThresholdInput.value);
  openThresholdInput.value = raw;
  const percent = Number(raw);
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    openThresholdInput.setCustomValidity("Enter a whole number from 1 to 100");
    openThresholdInput.reportValidity();
    return;
  }
  openThresholdInput.setCustomValidity("");

  state.books.openThreshold = percent / 100;
  const entry = { at: new Date().toISOString(), percent };
  const prev = Array.isArray(state.books.thresholdHistory)
    ? state.books.thresholdHistory
    : [];
  state.books.thresholdHistory = [...prev, entry].slice(-3);
  saveBooks();
  syncOpenThresholdInput();
  renderThresholdHistory();
}

function saveNextBookUrlFromInput() {
  if (!nextBookUrlInput) return;
  state.books.nextBookUrl = nextBookUrlInput.value.trim();
  saveBooks();
}

async function pasteNextBookUrl() {
  if (!nextBookUrlInput) return;
  try {
    const text = await navigator.clipboard.readText();
    nextBookUrlInput.value = text.trim();
    saveNextBookUrlFromInput();
    nextBookUrlInput.focus();
    if (typeof nextBookUrlInput.select === "function") nextBookUrlInput.select();
  } catch {
    nextBookUrlInput.focus();
    nextBookUrlInput.setCustomValidity("Couldn’t read clipboard — paste with ⌘V / Ctrl+V");
    nextBookUrlInput.reportValidity();
    nextBookUrlInput.setCustomValidity("");
  }
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function createStopwatchElement(id) {
  const root = document.createElement("div");
  root.className = "stopwatch";
  root.dataset.stopwatch = String(id);
  root.innerHTML = `
    <div class="stopwatch-display" aria-live="polite">
      <span class="stopwatch-hours">00</span>
      <span class="stopwatch-sep" aria-hidden="true">:</span>
      <span class="stopwatch-minutes">00</span>
      <span class="stopwatch-sep" aria-hidden="true">:</span>
      <span class="stopwatch-seconds">00</span>
    </div>
    <div class="stopwatch-actions">
      <button type="button" class="stopwatch-btn" data-action="toggle">Start</button>
      <button type="button" class="stopwatch-btn" data-action="reset">Reset</button>
    </div>
    <div class="stopwatch-transfer">
      <button
        type="button"
        class="stopwatch-btn stopwatch-transfer-btn"
        data-action="transfer"
        aria-haspopup="menu"
        aria-expanded="false"
      >
        Transfer
      </button>
      <div class="stopwatch-transfer-menu" role="menu" hidden></div>
      <div class="stopwatch-reading-fields" hidden>
        <label class="sr-only" for="sw-${id}-page-from">Page from</label>
        <input
          id="sw-${id}-page-from"
          class="composer-input page-input stopwatch-page-input"
          type="text"
          inputmode="numeric"
          placeholder="from"
          autocomplete="off"
          data-page-from
        />
        <span class="page-range-sep" aria-hidden="true">–</span>
        <label class="sr-only" for="sw-${id}-page-to">Page to</label>
        <input
          id="sw-${id}-page-to"
          class="composer-input page-input stopwatch-page-input"
          type="text"
          inputmode="numeric"
          placeholder="to"
          autocomplete="off"
          data-page-to
        />
      </div>
    </div>
  `;
  return root;
}

function syncStopwatchManageButtons() {
  if (stopwatchAddBtn) {
    stopwatchAddBtn.disabled = stopwatches.length >= MAX_STOPWATCHES;
  }
  if (stopwatchRemoveBtn) {
    stopwatchRemoveBtn.disabled = stopwatches.length <= MIN_STOPWATCHES;
  }
}

function reindexStopwatches() {
  stopwatches.forEach((sw, index) => {
    sw.id = index;
    if (!sw.root) return;
    sw.root.dataset.stopwatch = String(index);
    const from = sw.root.querySelector("[data-page-from]");
    const to = sw.root.querySelector("[data-page-to]");
    const fromLabel = sw.root.querySelector(`label[for^="sw-"][for$="-page-from"]`);
    const toLabel = sw.root.querySelector(`label[for^="sw-"][for$="-page-to"]`);
    if (from) from.id = `sw-${index}-page-from`;
    if (to) to.id = `sw-${index}-page-to`;
    if (fromLabel) fromLabel.setAttribute("for", `sw-${index}-page-from`);
    if (toLabel) toLabel.setAttribute("for", `sw-${index}-page-to`);
  });
}

function bindOneStopwatchReadingFields(sw) {
  const inputs = getStopwatchPageInputs(sw);
  if (!inputs) return;

  inputs.pageFrom.addEventListener("input", onStopwatchPageFromInput);
  inputs.pageTo.addEventListener("input", onStopwatchPageToInput);

  inputs.pageFrom.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== "-" && event.key !== " ") return;
    event.preventDefault();
    inputs.pageFrom.value = digitsOnly(inputs.pageFrom.value);
    inputs.pageTo.focus();
  });

  inputs.pageTo.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    completeReadingTransfer(sw);
  });
}

function buildOneTransferMenu(sw) {
  const menu = sw.root?.querySelector(".stopwatch-transfer-menu");
  if (!menu) return;
  menu.replaceChildren();
  for (const category of sortedCategories()) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "stopwatch-transfer-option";
    option.setAttribute("role", "menuitem");
    option.dataset.categoryId = category.id;
    option.textContent = category.name;
    menu.append(option);
  }
}

function createStopwatch(initial = {}) {
  const id = stopwatches.length;
  const root = createStopwatchElement(id);
  if (stopwatchListEl) stopwatchListEl.append(root);

  const sw = {
    id,
    elapsedMs: Number(initial.elapsedMs) > 0 ? Number(initial.elapsedMs) : 0,
    running: false,
    startedAt: null,
    intervalId: null,
    root,
  };
  stopwatches.push(sw);
  buildOneTransferMenu(sw);
  bindOneStopwatchReadingFields(sw);

  const startedAt = Number(initial.startedAt);
  if (initial.running && Number.isFinite(startedAt) && startedAt > 0) {
    sw.running = true;
    sw.startedAt = startedAt;
    tickStopwatch(sw);
  }

  renderStopwatch(sw);
  syncStopwatchManageButtons();
  return sw;
}

function addStopwatch() {
  if (stopwatches.length >= MAX_STOPWATCHES) return;
  createStopwatch();
  hideStopwatchAdjustPicker();
  saveStopwatches();
}

function removeLastStopwatch() {
  if (stopwatches.length <= MIN_STOPWATCHES) return;
  const sw = stopwatches[stopwatches.length - 1];
  if (sw.running) {
    sw.elapsedMs = getStopwatchElapsed(sw);
    sw.running = false;
    sw.startedAt = null;
  }
  if (sw.intervalId != null) {
    clearInterval(sw.intervalId);
    sw.intervalId = null;
  }
  if (pendingReadingTransferId === sw.id) pendingReadingTransferId = null;
  sw.root?.remove();
  stopwatches.pop();
  reindexStopwatches();
  hideStopwatchAdjustPicker();
  updateDocumentTitleFromStopwatches();
  syncStopwatchManageButtons();
  saveStopwatches();
}

function clearAllStopwatches() {
  for (const sw of stopwatches) {
    if (sw.intervalId != null) clearInterval(sw.intervalId);
    sw.root?.remove();
  }
  stopwatches = [];
  pendingReadingTransferId = null;
  if (stopwatchListEl) stopwatchListEl.replaceChildren();
  syncStopwatchManageButtons();
}

function ensureStopwatchCount(count, savedEntries = []) {
  const target = Math.min(
    MAX_STOPWATCHES,
    Math.max(MIN_STOPWATCHES, Number(count) || MIN_STOPWATCHES),
  );
  clearAllStopwatches();
  for (let i = 0; i < target; i++) {
    createStopwatch(savedEntries[i] || {});
  }
}

function parseAdjustDurationMs() {
  const minutesRaw = digitsOnly(stopwatchAdjustMinutes?.value || "");
  const secondsRaw = digitsOnly(stopwatchAdjustSeconds?.value || "");
  if (stopwatchAdjustMinutes) stopwatchAdjustMinutes.value = minutesRaw;
  if (stopwatchAdjustSeconds) stopwatchAdjustSeconds.value = secondsRaw;

  const minutes = minutesRaw === "" ? 0 : Number(minutesRaw);
  const seconds = secondsRaw === "" ? 0 : Number(secondsRaw);

  if (!Number.isInteger(minutes) || minutes < 0) {
    stopwatchAdjustMinutes?.setCustomValidity("Enter whole minutes (0+)");
    stopwatchAdjustMinutes?.reportValidity();
    return null;
  }
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 59) {
    stopwatchAdjustSeconds?.setCustomValidity("Enter seconds 0–59");
    stopwatchAdjustSeconds?.reportValidity();
    return null;
  }
  stopwatchAdjustMinutes?.setCustomValidity("");
  stopwatchAdjustSeconds?.setCustomValidity("");

  const totalMs = (minutes * 60 + seconds) * 1000;
  if (totalMs <= 0) {
    stopwatchAdjustMinutes?.setCustomValidity("Enter some time to adjust");
    stopwatchAdjustMinutes?.reportValidity();
    return null;
  }
  return totalMs;
}

function hideStopwatchAdjustPicker() {
  pendingAdjustDeltaMs = null;
  pendingAdjustSource = null;
  if (stopwatchAdjustPicker) {
    stopwatchAdjustPicker.hidden = true;
    stopwatchAdjustPicker.replaceChildren();
  }
  if (bridgeStopwatchPicker) {
    bridgeStopwatchPicker.hidden = true;
    bridgeStopwatchPicker.replaceChildren();
  }
}

function fillAdjustPicker(pickerEl, deltaMs, source) {
  pendingAdjustDeltaMs = deltaMs;
  pendingAdjustSource = source;
  if (!pickerEl) return;
  pickerEl.replaceChildren();
  stopwatches.forEach((sw, index) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "stopwatch-btn";
    btn.dataset.action = "adjust-target";
    btn.dataset.stopwatchIndex = String(index);
    btn.textContent = `#${index + 1}`;
    pickerEl.append(btn);
  });
  pickerEl.hidden = false;
}

function showStopwatchAdjustPicker(deltaMs) {
  if (bridgeStopwatchPicker) {
    bridgeStopwatchPicker.hidden = true;
    bridgeStopwatchPicker.replaceChildren();
  }
  fillAdjustPicker(stopwatchAdjustPicker, deltaMs, "manual");
}

function beginStopwatchAdjust(sign) {
  const ms = parseAdjustDurationMs();
  if (ms == null) return;
  showStopwatchAdjustPicker(sign * ms);
}

function beginBridgeAdjust(sign) {
  // Fold running time so the delta matches what the display shows.
  if (bridgeStopwatch.running && bridgeStopwatch.startedAt != null) {
    bridgeStopwatch.elapsedMs = getStopwatchElapsed(bridgeStopwatch);
    bridgeStopwatch.startedAt = Date.now();
  }
  const ms = Math.floor(getStopwatchElapsed(bridgeStopwatch));
  if (ms <= 0) return;
  if (stopwatchAdjustPicker) {
    stopwatchAdjustPicker.hidden = true;
    stopwatchAdjustPicker.replaceChildren();
  }
  fillAdjustPicker(bridgeStopwatchPicker, sign * ms, "bridge");
}

function applyStopwatchAdjust(index) {
  if (pendingAdjustDeltaMs == null) return;
  const sw = stopwatches[index];
  if (!sw) return;

  // Fold running time into elapsedMs first so the delta sticks cleanly.
  if (sw.running && sw.startedAt != null) {
    sw.elapsedMs = getStopwatchElapsed(sw);
    sw.startedAt = Date.now();
  }

  sw.elapsedMs = Math.max(0, sw.elapsedMs + pendingAdjustDeltaMs);
  renderStopwatch(sw);
  saveStopwatches();
  hideStopwatchAdjustPicker();
}

function getStopwatchElapsed(sw) {
  if (!sw.running || sw.startedAt == null) return sw.elapsedMs;
  return sw.elapsedMs + (Date.now() - sw.startedAt);
}

/** Whole seconds for transfer (sub-minute allowed; still accumulates). */
function getStopwatchTransferSeconds(sw) {
  return Math.floor(getStopwatchElapsed(sw) / 1000);
}

function writeStopwatchesLocal(payload) {
  localStorage.setItem(STOPWATCHES_STORAGE_KEY, JSON.stringify(payload));
}

function stopwatchesPayload() {
  return stopwatches.map((sw) => ({
    elapsedMs: sw.elapsedMs,
    running: sw.running,
    startedAt: sw.running ? sw.startedAt : null,
  }));
}

function saveStopwatches() {
  const payload = stopwatchesPayload();
  writeStopwatchesLocal(payload);
  if (stopwatchesPersistTimer) clearTimeout(stopwatchesPersistTimer);
  stopwatchesPersistTimer = setTimeout(() => {
    stopwatchesPersistTimer = null;
    const snapshot = structuredClone(payload);
    stopwatchesPersistChain = stopwatchesPersistChain
      .then(() => persistStopwatchesToSupabase(snapshot))
      .catch((err) =>
        console.error("Failed to save stopwatches to Supabase:", err),
      );
  }, PERSIST_DEBOUNCE_MS);
}

function loadStopwatchesFromLocal() {
  try {
    const raw = localStorage.getItem(STOPWATCHES_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function loadStopwatchesFromSupabase() {
  const { data, error } = await supabase
    .from("habit_tracker_stopwatches")
    .select("id, elapsed_ms, running, started_at")
    .order("id", { ascending: true });
  if (error) throw error;
  if (!data || data.length === 0) return null;

  const hasState = data.some(
    (row) =>
      Number(row.elapsed_ms) > 0 ||
      row.running === true ||
      row.started_at != null,
  );
  if (!hasState) return null;

  const maxId = Math.max(...data.map((row) => Number(row.id)), 0);
  const payload = Array.from({ length: maxId + 1 }, () => ({
    elapsedMs: 0,
    running: false,
    startedAt: null,
  }));
  for (const row of data) {
    const id = Number(row.id);
    if (!Number.isInteger(id) || id < 0) continue;
    payload[id] = {
      elapsedMs: Number(row.elapsed_ms) || 0,
      running: row.running === true,
      startedAt: row.started_at == null ? null : Number(row.started_at),
    };
  }
  return payload;
}

async function loadStopwatches() {
  try {
    const remote = await loadStopwatchesFromSupabase();
    if (remote) {
      writeStopwatchesLocal(remote);
      return remote;
    }
  } catch (err) {
    console.error("Failed to load stopwatches from Supabase:", err);
  }
  return loadStopwatchesFromLocal();
}

async function persistStopwatchesToSupabase(payload) {
  if (!Array.isArray(payload)) return;
  const now = new Date().toISOString();
  const rows = payload.map((entry, id) => ({
    id,
    elapsed_ms: Number(entry?.elapsedMs) || 0,
    running: entry?.running === true,
    started_at:
      entry?.running === true && Number.isFinite(Number(entry?.startedAt))
        ? Number(entry.startedAt)
        : null,
    updated_at: now,
  }));
  const { error } = await supabase.from("habit_tracker_stopwatches").upsert(rows);
  if (error) throw error;

  // Drop orphaned rows when the user removed a stopwatch.
  const { error: deleteError } = await supabase
    .from("habit_tracker_stopwatches")
    .delete()
    .gte("id", payload.length);
  if (deleteError) throw deleteError;
}

async function restoreStopwatches() {
  const saved = await loadStopwatches();
  if (!saved || !Array.isArray(saved) || saved.length === 0) {
    ensureStopwatchCount(MIN_STOPWATCHES);
    return;
  }
  ensureStopwatchCount(saved.length, saved);
}

function tickStopwatch(sw) {
  if (sw.intervalId != null) clearInterval(sw.intervalId);
  sw.intervalId = setInterval(() => renderStopwatch(sw), 250);
}

function formatStopwatchTime(sw) {
  const elapsed = getStopwatchElapsed(sw);
  const totalSeconds = Math.floor(elapsed / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(Math.min(hours, 99))}:${pad2(minutes)}:${pad2(seconds)}`;
}

function updateDocumentTitleFromStopwatches() {
  const runningTimes = stopwatches
    .filter((sw) => sw.running)
    .map((sw) => formatStopwatchTime(sw));
  document.title = runningTimes.length
    ? `${DEFAULT_DOCUMENT_TITLE} · ${runningTimes.join(" · ")}`
    : DEFAULT_DOCUMENT_TITLE;
}

function renderStopwatch(sw) {
  if (!sw?.root) return;
  const time = formatStopwatchTime(sw);
  const [hours, minutes, seconds] = time.split(":");
  const hoursEl = sw.root.querySelector(".stopwatch-hours");
  const minutesEl = sw.root.querySelector(".stopwatch-minutes");
  const secondsEl = sw.root.querySelector(".stopwatch-seconds");
  const toggleBtn = sw.root.querySelector('[data-action="toggle"]');
  if (hoursEl) hoursEl.textContent = hours;
  if (minutesEl) minutesEl.textContent = minutes;
  if (secondsEl) secondsEl.textContent = seconds;
  if (toggleBtn) {
    toggleBtn.textContent = sw.running ? "Stop" : "Start";
    toggleBtn.classList.toggle("is-running", sw.running);
  }
  updateDocumentTitleFromStopwatches();
}

function startStopwatch(sw) {
  if (sw.running) return;
  sw.running = true;
  sw.startedAt = Date.now();
  tickStopwatch(sw);
  renderStopwatch(sw);
  saveStopwatches();
}

function stopStopwatch(sw) {
  if (!sw.running) return;
  sw.elapsedMs = getStopwatchElapsed(sw);
  sw.running = false;
  sw.startedAt = null;
  if (sw.intervalId != null) {
    clearInterval(sw.intervalId);
    sw.intervalId = null;
  }
  renderStopwatch(sw);
  saveStopwatches();
}

function resetStopwatch(sw) {
  stopStopwatch(sw);
  sw.elapsedMs = 0;
  renderStopwatch(sw);
  saveStopwatches();
}

function bridgePayload() {
  return {
    elapsedMs: bridgeStopwatch.elapsedMs,
    running: bridgeStopwatch.running,
    startedAt: bridgeStopwatch.running ? bridgeStopwatch.startedAt : null,
  };
}

function saveBridgeStopwatch() {
  try {
    localStorage.setItem(
      BRIDGE_STOPWATCH_STORAGE_KEY,
      JSON.stringify(bridgePayload()),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

function loadBridgeStopwatchFromLocal() {
  try {
    const raw = localStorage.getItem(BRIDGE_STOPWATCH_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      elapsedMs: Number(parsed.elapsedMs) || 0,
      running: parsed.running === true,
      startedAt:
        parsed.startedAt == null ? null : Number(parsed.startedAt),
    };
  } catch {
    return null;
  }
}

function renderBridgeStopwatch() {
  const sw = bridgeStopwatch;
  if (!sw?.root) return;
  const time = formatStopwatchTime(sw);
  const [hours, minutes, seconds] = time.split(":");
  const hoursEl = sw.root.querySelector(".stopwatch-hours");
  const minutesEl = sw.root.querySelector(".stopwatch-minutes");
  const secondsEl = sw.root.querySelector(".stopwatch-seconds");
  const toggleBtn = sw.root.querySelector('[data-action="bridge-toggle"]');
  if (hoursEl) hoursEl.textContent = hours;
  if (minutesEl) minutesEl.textContent = minutes;
  if (secondsEl) secondsEl.textContent = seconds;
  if (toggleBtn) {
    toggleBtn.textContent = sw.running ? "Stop" : "Start";
    toggleBtn.classList.toggle("is-running", sw.running);
  }
}

function tickBridgeStopwatch() {
  if (bridgeStopwatch.intervalId != null) clearInterval(bridgeStopwatch.intervalId);
  bridgeStopwatch.intervalId = setInterval(renderBridgeStopwatch, 250);
}

function startBridgeStopwatch() {
  if (bridgeStopwatch.running) return;
  bridgeStopwatch.running = true;
  bridgeStopwatch.startedAt = Date.now();
  tickBridgeStopwatch();
  renderBridgeStopwatch();
  saveBridgeStopwatch();
}

function stopBridgeStopwatch() {
  if (!bridgeStopwatch.running) return;
  bridgeStopwatch.elapsedMs = getStopwatchElapsed(bridgeStopwatch);
  bridgeStopwatch.running = false;
  bridgeStopwatch.startedAt = null;
  if (bridgeStopwatch.intervalId != null) {
    clearInterval(bridgeStopwatch.intervalId);
    bridgeStopwatch.intervalId = null;
  }
  renderBridgeStopwatch();
  saveBridgeStopwatch();
}

function resetBridgeStopwatch() {
  stopBridgeStopwatch();
  bridgeStopwatch.elapsedMs = 0;
  hideStopwatchAdjustPicker();
  renderBridgeStopwatch();
  saveBridgeStopwatch();
}

function restoreBridgeStopwatch() {
  const saved = loadBridgeStopwatchFromLocal();
  if (saved) {
    bridgeStopwatch.elapsedMs = saved.elapsedMs;
    bridgeStopwatch.running = saved.running;
    bridgeStopwatch.startedAt = saved.startedAt;
  }
  if (bridgeStopwatch.running && bridgeStopwatch.startedAt != null) {
    tickBridgeStopwatch();
  }
  renderBridgeStopwatch();
}

function closeTransferMenus(exceptRoot = null) {
  for (const sw of stopwatches) {
    if (!sw.root || sw.root === exceptRoot) continue;
    const menu = sw.root.querySelector(".stopwatch-transfer-menu");
    const btn = sw.root.querySelector('[data-action="transfer"]');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute("aria-expanded", "false");
  }
}

function hideStopwatchReadingFields(exceptRoot = null) {
  for (const sw of stopwatches) {
    if (!sw.root || sw.root === exceptRoot) continue;
    const fields = sw.root.querySelector(".stopwatch-reading-fields");
    if (!fields) continue;
    fields.hidden = true;
    fields.querySelectorAll("input").forEach((input) => {
      input.setCustomValidity("");
      input.value = "";
    });
  }
}

function getStopwatchPageInputs(sw) {
  const fields = sw.root.querySelector(".stopwatch-reading-fields");
  if (!fields) return null;
  return {
    fields,
    pageFrom: fields.querySelector("[data-page-from]"),
    pageTo: fields.querySelector("[data-page-to]"),
  };
}

function showReadingTransferFields(sw) {
  closeTransferMenus();
  hideStopwatchReadingFields(sw.root);

  if (!getActiveBook()) {
    pendingReadingTransferId = sw.id;
    categorySelect.value = READING_CATEGORY_ID;
    updateComposerMode();
    openBookDialog("new");
    return;
  }

  pendingReadingTransferId = null;
  const inputs = getStopwatchPageInputs(sw);
  if (!inputs) return;

  inputs.fields.hidden = false;
  const suggested = suggestedPageFrom(getActiveBook());
  inputs.pageFrom.value = suggested != null ? String(suggested) : "";
  inputs.pageTo.value = "";
  inputs.pageFrom.setCustomValidity("");
  inputs.pageTo.setCustomValidity("");
  inputs.pageFrom.focus();
  if (typeof inputs.pageFrom.select === "function" && inputs.pageFrom.value) {
    inputs.pageFrom.select();
  }
}

function completeReadingTransfer(sw) {
  if (sw.running) stopStopwatch(sw);

  const seconds = getStopwatchTransferSeconds(sw);
  if (seconds < 1) {
    const transferBtn = sw.root.querySelector('[data-action="transfer"]');
    if (transferBtn) {
      const prev = transferBtn.textContent;
      transferBtn.textContent = "Need time";
      transferBtn.disabled = true;
      setTimeout(() => {
        transferBtn.textContent = prev;
        transferBtn.disabled = false;
      }, 1200);
    }
    return;
  }

  const inputs = getStopwatchPageInputs(sw);
  if (!inputs || inputs.fields.hidden) {
    showReadingTransferFields(sw);
    return;
  }

  const book = getActiveBook();
  if (!book) {
    openBookDialog("new");
    return;
  }

  const pageFrom = parsePageNumber(inputs.pageFrom.value);
  const pageTo = parsePageNumber(inputs.pageTo.value);

  if (pageFrom === null) {
    inputs.pageFrom.setCustomValidity("Enter a start page");
    inputs.pageFrom.reportValidity();
    inputs.pageFrom.focus();
    return;
  }
  if (pageTo === null) {
    inputs.pageTo.setCustomValidity("Enter an end page");
    inputs.pageTo.reportValidity();
    inputs.pageTo.focus();
    return;
  }
  if (pageFrom > pageTo) {
    inputs.pageTo.setCustomValidity("End page must be ≥ start");
    inputs.pageTo.reportValidity();
    inputs.pageTo.focus();
    return;
  }
  if (pageTo > book.totalPages || pageFrom > book.totalPages) {
    inputs.pageTo.setCustomValidity(`Book only has ${book.totalPages} pages`);
    inputs.pageTo.reportValidity();
    inputs.pageTo.focus();
    return;
  }

  inputs.pageFrom.setCustomValidity("");
  inputs.pageTo.setCustomValidity("");

  // Keep composer page fields in sync for the shared Reading flow.
  pageFromInput.value = String(pageFrom);
  pageToInput.value = String(pageTo);
  categorySelect.value = READING_CATEGORY_ID;
  updateComposerMode();

  if (!commitDuration(READING_CATEGORY_ID, seconds)) return;

  hideStopwatchReadingFields();
  resetStopwatch(sw);
  closeTransferMenus();
}

function toggleTransferMenu(sw) {
  const menu = sw.root.querySelector(".stopwatch-transfer-menu");
  const btn = sw.root.querySelector('[data-action="transfer"]');
  if (!menu || !btn) return;
  const nextOpen = menu.hidden;
  closeTransferMenus(nextOpen ? sw.root : null);
  if (nextOpen) hideStopwatchReadingFields();
  menu.hidden = !nextOpen;
  btn.setAttribute("aria-expanded", nextOpen ? "true" : "false");
}

function bindStopwatchReadingFields() {
  for (const sw of stopwatches) {
    bindOneStopwatchReadingFields(sw);
  }
}

function buildTransferMenus() {
  for (const sw of stopwatches) {
    buildOneTransferMenu(sw);
  }
}

function transferStopwatch(sw, categoryId) {
  if (categoryId === READING_CATEGORY_ID) {
    if (sw.running) stopStopwatch(sw);
    showReadingTransferFields(sw);
    return;
  }

  hideStopwatchReadingFields();
  if (sw.running) stopStopwatch(sw);

  const seconds = getStopwatchTransferSeconds(sw);
  if (seconds < 1) {
    closeTransferMenus();
    const transferBtn = sw.root.querySelector('[data-action="transfer"]');
    if (transferBtn) {
      const prev = transferBtn.textContent;
      transferBtn.textContent = "Need time";
      transferBtn.disabled = true;
      setTimeout(() => {
        transferBtn.textContent = prev;
        transferBtn.disabled = false;
      }, 1200);
    }
    return;
  }

  if (!commitDuration(categoryId, seconds)) {
    closeTransferMenus();
    return;
  }

  resetStopwatch(sw);
  closeTransferMenus();
}

function onStopwatchPageFromInput(event) {
  const input = event.currentTarget;
  input.setCustomValidity("");
  let value = input.value;
  const root = input.closest("[data-stopwatch]");
  const toInput = root?.querySelector("[data-page-to]");
  if (value.includes("-") && toInput) {
    input.value = digitsOnly(value.split("-")[0]);
    toInput.focus();
    return;
  }
  input.value = digitsOnly(value);
  if (!toInput) return;
  const book = getActiveBook();
  if (!book) return;
  const digits = digitsOnly(input.value);
  if (isPageNumberComplete(digits, book.totalPages)) {
    toInput.focus();
    if (typeof toInput.select === "function") toInput.select();
  }
}

function onStopwatchPageToInput(event) {
  const input = event.currentTarget;
  input.setCustomValidity("");
  input.value = digitsOnly(input.value);
}

for (const tab of sideTabs) {
  tab.addEventListener("click", () => {
    setActiveSideTab(tab.dataset.tab);
  });
}

if (nextBookUrlInput) {
  nextBookUrlInput.addEventListener("change", saveNextBookUrlFromInput);
  nextBookUrlInput.addEventListener("input", () => {
    nextBookUrlInput.setCustomValidity("");
  });
}

if (nextBookPasteBtn) {
  nextBookPasteBtn.addEventListener("click", () => {
    pasteNextBookUrl();
  });
}

if (openThresholdInput) {
  openThresholdInput.addEventListener("input", () => {
    openThresholdInput.setCustomValidity("");
    openThresholdInput.value = digitsOnly(openThresholdInput.value);
  });
  openThresholdInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    updateOpenThresholdFromInput();
  });
}

if (openThresholdUpdateBtn) {
  openThresholdUpdateBtn.addEventListener("click", () => {
    updateOpenThresholdFromInput();
  });
}

if (timersPanel) {
  timersPanel.addEventListener("click", (event) => {
    const option = event.target.closest(".stopwatch-transfer-option");
    if (option) {
      event.preventDefault();
      event.stopPropagation();
      const root = option.closest("[data-stopwatch]");
      const sw = stopwatches[Number(root?.dataset.stopwatch)];
      if (sw) transferStopwatch(sw, option.dataset.categoryId);
      return;
    }

    const btn = event.target.closest("[data-action]");
    if (!btn) return;

    const action = btn.dataset.action;
    if (action === "add-stopwatch") {
      addStopwatch();
      return;
    }
    if (action === "remove-stopwatch") {
      removeLastStopwatch();
      return;
    }
    if (action === "adjust-add") {
      beginStopwatchAdjust(1);
      return;
    }
    if (action === "adjust-subtract") {
      beginStopwatchAdjust(-1);
      return;
    }
    if (action === "adjust-target") {
      applyStopwatchAdjust(Number(btn.dataset.stopwatchIndex));
      return;
    }
    if (action === "bridge-toggle") {
      if (bridgeStopwatch.running) stopBridgeStopwatch();
      else startBridgeStopwatch();
      return;
    }
    if (action === "bridge-reset") {
      resetBridgeStopwatch();
      return;
    }
    if (action === "bridge-add") {
      beginBridgeAdjust(1);
      return;
    }
    if (action === "bridge-subtract") {
      beginBridgeAdjust(-1);
      return;
    }

    const root = btn.closest("[data-stopwatch]");
    if (!root) return;
    const sw = stopwatches[Number(root.dataset.stopwatch)];
    if (!sw) return;
    if (action === "toggle") {
      if (sw.running) stopStopwatch(sw);
      else startStopwatch(sw);
    } else if (action === "reset") {
      resetStopwatch(sw);
    } else if (action === "transfer") {
      event.stopPropagation();
      toggleTransferMenu(sw);
    }
  });
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".stopwatch-transfer")) return;
  if (event.target.closest("#panel-timers")) return;
  closeTransferMenus();
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (pendingAdjustDeltaMs != null) {
    hideStopwatchAdjustPicker();
    return;
  }
  const anyMenuOpen = stopwatches.some(
    (sw) => !sw.root?.querySelector(".stopwatch-transfer-menu")?.hidden
  );
  const anyReadingFields = stopwatches.some(
    (sw) => !sw.root?.querySelector(".stopwatch-reading-fields")?.hidden
  );
  if (anyMenuOpen) {
    closeTransferMenus();
    return;
  }
  if (anyReadingFields) {
    hideStopwatchReadingFields();
  }
});

if (stopwatchAdjustMinutes) {
  stopwatchAdjustMinutes.addEventListener("input", () => {
    stopwatchAdjustMinutes.setCustomValidity("");
    stopwatchAdjustMinutes.value = digitsOnly(stopwatchAdjustMinutes.value);
  });
}
if (stopwatchAdjustSeconds) {
  stopwatchAdjustSeconds.addEventListener("input", () => {
    stopwatchAdjustSeconds.setCustomValidity("");
    stopwatchAdjustSeconds.value = digitsOnly(stopwatchAdjustSeconds.value);
  });
}

// Fresh paint before async restore — one empty stopwatch.
ensureStopwatchCount(MIN_STOPWATCHES);
renderBridgeStopwatch();
syncNextBookUrlInput();
syncOpenThresholdInput();
renderThresholdHistory();

async function flushAllPendingPersists() {
  if (daysPersistTimer) {
    clearTimeout(daysPersistTimer);
    daysPersistTimer = null;
    const snapshot = structuredClone(daysPayload());
    daysPersistChain = daysPersistChain
      .then(() => persistDaysToSupabase(snapshot))
      .catch((err) => console.error("Failed to save days to Supabase:", err));
  }
  if (booksPersistTimer) {
    clearTimeout(booksPersistTimer);
    booksPersistTimer = null;
    const snapshot = structuredClone(state.books);
    booksPersistChain = booksPersistChain
      .then(() => persistBooksToSupabase(snapshot))
      .catch((err) => console.error("Failed to save books to Supabase:", err));
  }
  if (stopwatchesPersistTimer) {
    clearTimeout(stopwatchesPersistTimer);
    stopwatchesPersistTimer = null;
    const snapshot = structuredClone(stopwatchesPayload());
    stopwatchesPersistChain = stopwatchesPersistChain
      .then(() => persistStopwatchesToSupabase(snapshot))
      .catch((err) =>
        console.error("Failed to save stopwatches to Supabase:", err),
      );
  }
  if (categoriesPersistTimer) {
    clearTimeout(categoriesPersistTimer);
    categoriesPersistTimer = null;
    const snapshot = structuredClone(state.categories);
    categoriesPersistChain = categoriesPersistChain
      .then(() => persistCategoriesToSupabase(snapshot))
      .catch((err) =>
        console.error("Failed to save categories to Supabase:", err),
      );
  }
  if (collapsedDaysPersistTimer) {
    clearTimeout(collapsedDaysPersistTimer);
    collapsedDaysPersistTimer = null;
    const snapshot = [...state.collapsedDays];
    collapsedDaysPersistChain = collapsedDaysPersistChain
      .then(() => persistCollapsedDaysToSupabase(snapshot))
      .catch((err) =>
        console.error("Failed to save collapsed days to Supabase:", err),
      );
  }
  await Promise.all([
    daysPersistChain,
    booksPersistChain,
    stopwatchesPersistChain,
    categoriesPersistChain,
    collapsedDaysPersistChain,
  ]);
}

async function remoteHasHabitData() {
  const [{ count: dayCount, error: dayError }, { count: bookCount, error: bookError }] =
    await Promise.all([
      supabase
        .from("habit_tracker_log_days")
        .select("day_key", { count: "exact", head: true }),
      supabase.from("habit_tracker_books").select("id", { count: "exact", head: true }),
    ]);
  if (dayError) throw dayError;
  if (bookError) throw bookError;
  return (dayCount || 0) > 0 || (bookCount || 0) > 0;
}

async function migrateFromLocalStorageIfNeeded() {
  const localDays = loadDaysFromLocal();
  const localBooks = loadBooksFromLocal();
  const localStopwatches = loadStopwatchesFromLocal();
  const localCategories = loadCategoriesFromLocal();
  const localCollapsedDays = loadCollapsedDaysFromLocal();
  const hasLocal =
    Object.keys(localDays).length > 0 ||
    localBooks.books.length > 0 ||
    categoriesAreCustomized(localCategories) ||
    localCollapsedDays.size > 0 ||
    (Array.isArray(localStopwatches) &&
      localStopwatches.some(
        (entry) =>
          entry &&
          (Number(entry.elapsedMs) > 0 ||
            entry.running === true ||
            entry.startedAt != null),
      ));

  if (!hasLocal) return;
  if (await remoteHasHabitData()) return;

  console.info("Migrating localStorage → Supabase…");
  state.days = localDays;
  state.books = localBooks;
  state.categories = localCategories;
  state.collapsedDays = localCollapsedDays;
  await persistDaysToSupabase(localDays);
  await persistBooksToSupabase(localBooks);
  await persistCategoriesToSupabase(localCategories);
  await persistCollapsedDaysToSupabase([...localCollapsedDays]);
  if (Array.isArray(localStopwatches)) {
    await persistStopwatchesToSupabase(localStopwatches);
  }
  console.info("Migration complete.");
}

async function boot() {
  try {
    await migrateFromLocalStorageIfNeeded();
  } catch (err) {
    console.error("Migration failed:", err);
  }

  state.days = await loadDays();
  state.books = await loadBooks();
  state.categories = await loadCategories();
  state.collapsedDays = await loadCollapsedDays();
  activeDayKey = localDayKey();
  // Persist any legacy flat-array reshape still sitting in memory/local.
  writeDaysLocal();
  if (Object.keys(daysPayload()).length > 0) {
    daysPersistChain = daysPersistChain
      .then(() => persistDaysToSupabase(daysPayload()))
      .catch((err) => console.error("Failed to save days to Supabase:", err));
  }

  syncCategoryOptions();
  renderCategoryEditor();
  renderRows();
  updateComposerMode();
  if (isReadingCategory() && getActiveBook()) {
    prefillPageFrom();
  }
  syncNextBookUrlInput();
  syncOpenThresholdInput();
  renderThresholdHistory();
  await restoreStopwatches();
  stopwatches.forEach(renderStopwatch);
  restoreBridgeStopwatch();
  // Rebuild transfer menus after categories (and stopwatches) are ready.
  buildTransferMenus();
  durationInput.focus();
}

window.addEventListener("beforeunload", () => {
  // Best-effort: kick off pending writes (may not finish if the tab dies).
  void flushAllPendingPersists();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    void flushAllPendingPersists();
  }
});

state.categories = loadCategoriesFromLocal();
syncCategoryOptions();
renderCategoryEditor();

boot();


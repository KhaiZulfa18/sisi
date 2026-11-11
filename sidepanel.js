// ============ State ============
let tasks = [];   // { id, text, tags[], checked, createdAt }
let history = []; // { id, text, tags[], createdAt, doneAt }
let activeFilter = null;
let searchQuery = "";     // teks pencarian (berlaku di tab Aktif & Riwayat)
let currentTab = "active";
let theme = "auto";
let editingId = null;     // id tugas yang sedang diedit inline
let pendingRender = false; // render tertunda (ada perubahan dari window lain saat edit/drag)

// ============ Tema ============
// key: nama internal, label, swatch (warna preview), dark: buat warna tag
const THEMES = [
  { key: "auto",   label: "Auto (sistem)", swatch: "linear-gradient(135deg,#fbfaf7 50%,#1b1a17 50%)" },
  { key: "kertas", label: "Kertas",        swatch: "#fbfaf7", dark: false },
  { key: "gelap",  label: "Gelap",         swatch: "#1b1a17", dark: true },
  { key: "laut",   label: "Laut",          swatch: "#21618f", dark: false },
  { key: "senja",  label: "Senja",         swatch: "#b35c1e", dark: false },
  { key: "ungu",   label: "Ungu",          swatch: "#a68bfa", dark: true },
  { key: "hutan",  label: "Hutan",         swatch: "#7fc79e", dark: true },
];

const mediaDark = window.matchMedia("(prefers-color-scheme: dark)");

function resolvedThemeKey() {
  if (theme === "auto") return mediaDark.matches ? "gelap" : "kertas";
  return theme;
}

function isDarkTheme() {
  const t = THEMES.find((t) => t.key === resolvedThemeKey());
  return t ? !!t.dark : false;
}

function applyTheme() {
  const key = resolvedThemeKey();
  // "kertas" = default :root, jadi hapus attribute
  if (key === "kertas") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", key);
  renderSwatches();
  requestRender(); // warna tag ikut tema
}

mediaDark.addEventListener("change", () => {
  if (theme === "auto") applyTheme();
});

function renderSwatches() {
  const box = document.getElementById("swatches");
  box.innerHTML = THEMES.map(
    (t) => `
    <button class="swatch ${t.key === theme ? "on" : ""}" data-key="${t.key}" title="${t.label}">
      <span class="dot" style="background:${t.swatch}"></span>
    </button>`
  ).join("");
}

// ============ Elements ============
const $ = (sel) => document.querySelector(sel);
const taskInput = $("#taskInput");
const addBtn = $("#addBtn");
const taskList = $("#taskList");
const historyList = $("#historyList");
const tagFilter = $("#tagFilter");
const counter = $("#counter");
const tagSuggest = $("#tagSuggest");
const toast = $("#toast");
const searchInput = $("#searchInput");
const searchClear = $("#searchClear");
const toastMsg = $("#toastMsg");
const toastUndo = $("#toastUndo");

// ============ Helpers ============
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// ============ Storage + sync antar window ============
// Tiap window Chrome punya instance side panel sendiri. Setiap save diberi
// penanda `_rev` berisi id instance ini, supaya perubahan dari window lain
// bisa dibedakan dari tulisan kita sendiri.
const INSTANCE_ID = uid();
let revCounter = 0;

async function load() {
  const data = await chrome.storage.local.get({ tasks: [], history: [], theme: "auto" });
  tasks = data.tasks;
  history = data.history;
  theme = data.theme;
  applyTheme();
}

function save() {
  chrome.storage.local.set({ tasks, history, theme, _rev: `${INSTANCE_ID}:${++revCounter}` });
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  const rev = changes._rev?.newValue;
  if (typeof rev === "string" && rev.startsWith(INSTANCE_ID + ":")) return; // tulisan sendiri

  if (changes.tasks) tasks = changes.tasks.newValue ?? [];
  if (changes.history) history = changes.history.newValue ?? [];
  if (changes.theme) {
    theme = changes.theme.newValue ?? "auto";
    applyTheme();
  }
  requestRender();
});

// Jangan render ulang saat user sedang edit/drag — DOM-nya bakal ketimpa.
function requestRender() {
  if (editingId || dragId) pendingRender = true;
  else render();
}

// Warna tag deterministik dari nama tag, ikut terang/gelapnya tema
function tagColor(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const hue = Math.abs(hash) % 360;
  return isDarkTheme() ? `hsl(${hue} 30% 27%)` : `hsl(${hue} 55% 89%)`;
}

// Kumpulan semua tag yang pernah dipakai (aktif + riwayat)
function knownTags() {
  return [...new Set([...tasks, ...history].flatMap((t) => t.tags))].sort();
}

const TAG_RE = /^[\p{L}\p{N}_-]+$/u;

// ============ Tanggal tenggat (due) ============
// Disimpan sebagai string tanggal lokal "YYYY-MM-DD" (tanpa jam). Tidak ada = tanpa tenggat.
const pad2 = (n) => String(n).padStart(2, "0");
const toDateKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const fromDateKey = (k) => {
  const [y, m, d] = k.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const todayKey = () => toDateKey(new Date());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
// Selisih hari dari hari ini (negatif = sudah lewat). Math.round menetralkan efek DST.
const dayDiff = (k) => Math.round((fromDateKey(k) - fromDateKey(todayKey())) / 86400000);

function isValidDateKey(k) {
  if (typeof k !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  return toDateKey(fromDateKey(k)) === k; // tolak 2026-02-31 dkk
}

const WEEKDAYS = ["minggu", "senin", "selasa", "rabu", "kamis", "jumat", "sabtu"];
const DUE_KEYWORDS = { "hari-ini": 0, hariini: 0, today: 0, besok: 1, tomorrow: 1, lusa: 2 };

// "@besok", "@jumat", "@15/11", "@15/11/2027", "@2026-11-15" -> "YYYY-MM-DD" | null
function parseDue(token) {
  const s = token.toLowerCase();
  const today = fromDateKey(todayKey());

  if (s in DUE_KEYWORDS) return toDateKey(addDays(today, DUE_KEYWORDS[s]));

  const wd = WEEKDAYS.indexOf(s);
  if (wd !== -1) return toDateKey(addDays(today, (wd - today.getDay() + 7) % 7)); // hari itu atau berikutnya

  if (isValidDateKey(s)) return s;

  const m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  let year = m[3] ? Number(m[3]) : today.getFullYear();
  if (m[3] && m[3].length === 2) year += 2000;
  const d = new Date(year, month - 1, day);
  if (d.getDate() !== day || d.getMonth() !== month - 1) return null;
  // Tanpa tahun & tanggalnya sudah lewat -> anggap tahun depan (mis. "@5/1" di bulan Desember)
  if (!m[3] && d < today) d.setFullYear(year + 1);
  return toDateKey(d);
}

// Kebalikan parseDue untuk isi mode edit. Tahun ditulis kalau tanpa tahun hasilnya bakal beda.
function dueToken(k) {
  const d = fromDateKey(k);
  const omitYear = d.getFullYear() === new Date().getFullYear() && dayDiff(k) >= 0;
  return `@${d.getDate()}/${d.getMonth() + 1}${omitYear ? "" : "/" + d.getFullYear()}`;
}

function fmtDue(k) {
  const d = fromDateKey(k);
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("id-ID", opts);
}

// Label + status badge tenggat untuk tugas aktif
function dueInfo(k) {
  const diff = dayDiff(k);
  const date = fmtDue(k);
  if (diff < 0) return { cls: "overdue", label: `Lewat ${-diff} hari · ${date}` };
  if (diff === 0) return { cls: "today", label: "Hari ini" };
  if (diff === 1) return { cls: "soon", label: "Besok" };
  if (diff < 7) {
    const wd = fromDateKey(k).toLocaleDateString("id-ID", { weekday: "short" });
    return { cls: "", label: `${wd}, ${date}` };
  }
  return { cls: "", label: date };
}

// Token "@..." didahului spasi/awal teks, supaya email (a@b.com) tidak ikut terbaca
const DUE_TOKEN_RE = /(^|\s)@([\p{L}\p{N}/._-]+)/gu;

// Ekstrak #tag dan @tenggat dari teks input
function parseInput(raw) {
  const tags = [];
  let due = null;
  const text = raw
    .replace(DUE_TOKEN_RE, (all, lead, tok) => {
      const k = parseDue(tok);
      if (!k) return all; // bukan tanggal -> biarkan sebagai teks
      due = k; // kalau ada lebih dari satu, yang terakhir menang
      return lead;
    })
    .replace(/#([\p{L}\p{N}_-]+)/gu, (_, t) => {
      const tag = t.toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, tags, due };
}

// Kebalikan parseInput: teks + @tenggat + #tag, dipakai sebagai isi awal mode edit
function composeRaw(t) {
  return [t.text, ...(t.due ? [dueToken(t.due)] : []), ...t.tags.map((tag) => `#${tag}`)].join(" ");
}

function setDue(task, k) {
  if (k) task.due = k;
  else delete task.due;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString("id-ID", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

// Aman untuk isi elemen maupun nilai atribut
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ============ Toast + undo ============
let toastTimer = null;
let undoFn = null;

function showToast(message, onUndo = null) {
  clearTimeout(toastTimer);
  toastMsg.textContent = message;
  undoFn = onUndo;
  toastUndo.hidden = !onUndo;
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, onUndo ? 6000 : 3500);
}

function hideToast() {
  clearTimeout(toastTimer);
  toast.hidden = true;
  undoFn = null;
}

function runUndo() {
  const fn = undoFn;
  hideToast();
  if (fn) fn();
}

// ============ Saran #tag & @tanggal ============
let suggestIndex = -1;
let suggestItems = []; // { insert, label, hint? }
let suggestTokenRe = null; // regex token yang akan diganti saat saran dipilih

const TAG_TYPING_RE = /#([\p{L}\p{N}_-]*)$/u;
const DUE_TYPING_RE = /(?:^|\s)@([\p{L}\p{N}/._-]*)$/u;

// Kata kunci tanggal: relatif dulu, lalu nama hari urut dari yang paling dekat
function dueKeywordSuggestions() {
  const dow = new Date().getDay();
  const days = WEEKDAYS.map((w, i) => ({ w, d: (i - dow + 7) % 7 }))
    .filter((x) => x.d >= 3) // hari ini, besok, lusa sudah diwakili kata kunci relatif
    .sort((a, b) => a.d - b.d)
    .map((x) => x.w);
  return ["hari-ini", "besok", "lusa", ...days];
}

function updateSuggest() {
  const val = taskInput.value;
  const caret = taskInput.selectionStart ?? val.length;
  // token #... / @... yang sedang diketik (tepat sebelum caret)
  const before = val.slice(0, caret);

  let m = before.match(TAG_TYPING_RE);
  if (m) {
    const prefix = m[1].toLowerCase();
    const { tags: usedInInput } = parseInput(val);
    suggestTokenRe = TAG_TYPING_RE;
    suggestItems = knownTags()
      .filter((t) => t.startsWith(prefix) && t !== prefix && !usedInInput.includes(t))
      .slice(0, 6)
      .map((t) => ({ insert: `#${t}`, label: `#${t}` }));
  } else if ((m = before.match(DUE_TYPING_RE))) {
    const prefix = m[1].toLowerCase();
    suggestTokenRe = /@[\p{L}\p{N}/._-]*$/u;
    suggestItems = dueKeywordSuggestions()
      .filter((k) => k.startsWith(prefix) && k !== prefix)
      .slice(0, 6)
      .map((k) => ({ insert: `@${k}`, label: `@${k}`, hint: fmtDue(parseDue(k)) }));
  } else {
    return hideSuggest();
  }

  if (suggestItems.length === 0) return hideSuggest();

  suggestIndex = -1;
  tagSuggest.innerHTML = suggestItems
    .map(
      (s, i) => `<button class="suggest-item" data-i="${i}">
        <span>${esc(s.label)}</span>${s.hint ? `<span class="suggest-hint">${esc(s.hint)}</span>` : ""}
      </button>`
    )
    .join("");
  tagSuggest.hidden = false;
}

function hideSuggest() {
  tagSuggest.hidden = true;
  suggestItems = [];
  suggestIndex = -1;
}

function applySuggestion(i) {
  const item = suggestItems[i];
  if (!item) return;
  const val = taskInput.value;
  const caret = taskInput.selectionStart ?? val.length;
  const before = val.slice(0, caret).replace(suggestTokenRe, `${item.insert} `);
  taskInput.value = before + val.slice(caret);
  const pos = before.length;
  taskInput.setSelectionRange(pos, pos);
  taskInput.focus();
  hideSuggest();
}

function highlightSuggest(delta) {
  if (suggestItems.length === 0) return;
  suggestIndex = (suggestIndex + delta + suggestItems.length) % suggestItems.length;
  tagSuggest.querySelectorAll(".suggest-item").forEach((el, i) => {
    el.classList.toggle("hl", i === suggestIndex);
  });
}

// ============ Actions ============
function addTask() {
  const raw = taskInput.value.trim();
  if (!raw) return;
  const { text, tags, due } = parseInput(raw);
  if (!text) return;
  const task = { id: uid(), text, tags, checked: false, createdAt: Date.now() };
  setDue(task, due);
  tasks.unshift(task);
  taskInput.value = "";
  hideSuggest();
  save();
  render();
  taskInput.focus();
}

function toggleCheck(id) {
  const t = tasks.find((t) => t.id === id);
  if (t) {
    t.checked = !t.checked;
    save();
    render();
  }
}

function markDone(id, el) {
  el.classList.add("removing");
  setTimeout(() => {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [t] = tasks.splice(idx, 1);
    history.unshift({ ...t, doneAt: Date.now() });
    save();
    render();
  }, 170);
}

// Sisipkan kembali item yang dihapus ke posisi semula (kalau belum ada)
function reinsert(list, item, idx) {
  if (list.some((x) => x.id === item.id)) return;
  list.splice(Math.min(idx, list.length), 0, item);
}

function deleteTask(id, el) {
  el.classList.add("removing");
  setTimeout(() => {
    const idx = tasks.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [t] = tasks.splice(idx, 1);
    save();
    render();
    showToast("Tugas dihapus", () => {
      reinsert(tasks, t, idx);
      save();
      render();
    });
  }, 170);
}

function deleteHistoryItem(id, el) {
  el.classList.add("removing");
  setTimeout(() => {
    const idx = history.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const [t] = history.splice(idx, 1);
    save();
    render();
    showToast("Riwayat dihapus", () => {
      reinsert(history, t, idx);
      save();
      render();
    });
  }, 170);
}

function restoreTask(id) {
  const idx = history.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [t] = history.splice(idx, 1);
  delete t.doneAt;
  t.checked = false;
  tasks.unshift(t);
  save();
  render();
}

function clearHistory() {
  if (history.length === 0) return;
  if (!confirm(`Hapus ${history.length} item riwayat?`)) return;
  const removed = history;
  history = [];
  save();
  render();
  showToast(`${removed.length} riwayat dihapus`, () => {
    // Item yang selesai setelah dihapus lebih baru, jadi tetap di depan
    const ids = new Set(history.map((t) => t.id));
    history = [...history, ...removed.filter((t) => !ids.has(t.id))];
    save();
    render();
  });
}

// ============ Edit inline ============
function startEdit(id) {
  if (editingId) commitEdit();
  if (!tasks.some((t) => t.id === id)) return;
  editingId = id;
  render();
  const input = taskList.querySelector(".edit-input");
  if (input) {
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }
}

function commitEdit() {
  if (!editingId) return;
  const id = editingId;
  editingId = null; // set duluan: blur saat elemen dilepas tidak boleh commit dua kali

  const input = taskList.querySelector(".edit-input");
  const t = tasks.find((t) => t.id === id);
  if (t && input) {
    const { text, tags, due } = parseInput(input.value);
    // Teks kosong = batal, bukan hapus. Token @tanggal yang dihapus = tenggat dikosongkan.
    if (text && (text !== t.text || tags.join(" ") !== t.tags.join(" ") || (due || null) !== (t.due || null))) {
      t.text = text;
      t.tags = tags;
      setDue(t, due);
      save();
    }
  }

  // Patch satu item saja supaya klik di item lain (yang memicu blur) tetap jalan
  const li = input?.closest(".task");
  const stillVisible = t && matchesView(t);
  if (li && stillVisible && !pendingRender) {
    li.outerHTML = activeItemHTML(t);
    renderFilterChips();
  } else {
    render();
  }
}

function cancelEdit() {
  if (!editingId) return;
  editingId = null;
  render();
}

// ============ Date picker tenggat ============
// Satu <input type="date"> tak terlihat, diposisikan di dekat tombol pemicunya,
// lalu dibuka lewat showPicker(). Tombol "Hapus"/"Clear" bawaan picker = kosongkan tenggat.
const duePicker = $("#duePicker");
let duePickerTarget = null; // "composer" | id tugas

function openDuePicker(target, anchor, currentKey) {
  duePickerTarget = target;
  const r = anchor.getBoundingClientRect();
  duePicker.style.left = `${Math.max(0, Math.min(r.left, window.innerWidth - 4))}px`;
  duePicker.style.top = `${r.bottom}px`;
  duePicker.value = currentKey || "";
  try {
    duePicker.showPicker();
  } catch {
    duePicker.focus(); // browser lama tanpa showPicker
  }
}

duePicker.addEventListener("change", () => {
  const k = isValidDateKey(duePicker.value) ? duePicker.value : null;
  const target = duePickerTarget;
  duePickerTarget = null;

  if (target === "composer") {
    // Ganti token @tanggal yang sudah ada (kalau ada), lalu tambahkan yang baru
    let raw = taskInput.value.replace(DUE_TOKEN_RE, (all, lead, tok) => (parseDue(tok) ? lead : all));
    raw = raw.replace(/\s{2,}/g, " ").trim();
    if (k) raw = `${raw} ${dueToken(k)}`.trim();
    taskInput.value = raw ? raw + " " : "";
    taskInput.focus();
    return;
  }

  const t = tasks.find((t) => t.id === target);
  if (!t || (t.due || null) === k) return;
  setDue(t, k);
  save();
  requestRender();
});

// ============ Backup: ekspor / impor ============
function exportData() {
  const payload = {
    app: "sisi",
    version: 1,
    exportedAt: new Date().toISOString(),
    tasks,
    history,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `sisi-backup-${new Date().toLocaleDateString("sv-SE")}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Diekspor: ${tasks.length} tugas, ${history.length} riwayat`);
}

// Validasi + rapikan satu item dari file impor. null kalau tidak valid.
function normalizeItem(x, isHistory) {
  if (!x || typeof x !== "object" || typeof x.text !== "string") return null;
  const text = x.text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const tags = Array.isArray(x.tags)
    ? [...new Set(
        x.tags
          .filter((t) => typeof t === "string")
          .map((t) => t.toLowerCase())
          .filter((t) => TAG_RE.test(t))
      )]
    : [];
  const createdAt = Number.isFinite(x.createdAt) ? x.createdAt : Date.now();
  const item = {
    id: typeof x.id === "string" && x.id ? x.id : uid(),
    text,
    tags,
    createdAt,
  };
  if (isValidDateKey(x.due)) item.due = x.due;
  if (isHistory) item.doneAt = Number.isFinite(x.doneAt) ? x.doneAt : createdAt;
  else item.checked = !!x.checked;
  return item;
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return showToast("File bukan JSON yang valid");
  }
  if (!data || typeof data !== "object" || (!Array.isArray(data.tasks) && !Array.isArray(data.history))) {
    return showToast("Format backup Sisi tidak dikenali");
  }

  // Gabung (bukan timpa): item dengan id yang sudah ada dilewati
  const seen = new Set([...tasks, ...history].map((t) => t.id));
  const pick = (list, isHistory) =>
    (Array.isArray(list) ? list : [])
      .map((x) => normalizeItem(x, isHistory))
      .filter((x) => x && !seen.has(x.id) && seen.add(x.id));

  const newTasks = pick(data.tasks, false);
  const newHistory = pick(data.history, true);
  if (newTasks.length + newHistory.length === 0) {
    return showToast("Tidak ada data baru untuk diimpor");
  }

  tasks = [...tasks, ...newTasks];
  history = [...history, ...newHistory].sort((a, b) => b.doneAt - a.doneAt);
  save();
  render();
  showToast(`Diimpor: ${newTasks.length} tugas, ${newHistory.length} riwayat`, () => {
    const addedIds = new Set([...newTasks, ...newHistory].map((t) => t.id));
    // Buang hanya item hasil impor; perubahan lain sesudahnya tetap dipertahankan
    tasks = tasks.filter((t) => !addedIds.has(t.id));
    history = history.filter((t) => !addedIds.has(t.id));
    save();
    render();
  });
}

// ============ Drag & drop reorder ============
let dragId = null;

function getDragAfterElement(container, y) {
  const els = [...container.querySelectorAll(".task:not(.dragging)")];
  return els.reduce(
    (closest, el) => {
      const box = el.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) return { offset, element: el };
      return closest;
    },
    { offset: -Infinity, element: null }
  ).element;
}

function commitOrderFromDOM() {
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
  // Urutan id yang terlihat di DOM (bisa saja sedang difilter). Abaikan id yang
  // sudah hilang dari state (mis. dihapus di window lain selama drag).
  const visibleOrder = [...taskList.querySelectorAll(".task")]
    .map((li) => li.dataset.id)
    .filter((id) => byId[id]);
  const visibleSet = new Set(visibleOrder);
  // Posisi (index) item-item visible di array tasks
  const slots = [];
  tasks.forEach((t, i) => {
    if (visibleSet.has(t.id)) slots.push(i);
  });
  // Isi ulang slot sesuai urutan DOM baru
  visibleOrder.forEach((id, k) => {
    tasks[slots[k]] = byId[id];
  });
  save();
}

taskList.addEventListener("dragstart", (e) => {
  const li = e.target.closest(".task");
  if (!li) return;
  dragId = li.dataset.id;
  li.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
});

taskList.addEventListener("dragover", (e) => {
  e.preventDefault();
  const dragging = taskList.querySelector(".dragging");
  if (!dragging) return;
  const after = getDragAfterElement(taskList, e.clientY);
  if (after == null) taskList.appendChild(dragging);
  else taskList.insertBefore(dragging, after);
});

taskList.addEventListener("dragend", (e) => {
  const li = e.target.closest(".task");
  if (li) {
    li.classList.remove("dragging");
    li.draggable = false;
  }
  if (dragId) {
    dragId = null;
    commitOrderFromDOM();
    render();
  }
});

// Drag hanya aktif kalau mulai dari handle (biar teks tetap bisa diseleksi)
taskList.addEventListener("mousedown", (e) => {
  const li = e.target.closest(".task");
  if (!li) return;
  li.draggable = e.target.classList.contains("drag-handle");
});

// ============ Render ============
function renderTags(tags) {
  if (!tags.length) return "";
  const chips = tags
    .map((t) => `<span class="tag" style="background:${tagColor(t)}">#${esc(t)}</span>`)
    .join("");
  return `<div class="task-tags">${chips}</div>`;
}

// ============ Search ============
// Huruf kecil + buang diakritik, supaya "cafe" juga ketemu "café"
const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

function searchTerms() {
  return fold(searchQuery).split(/\s+/).filter(Boolean);
}

// Semua kata harus muncul di teks atau tag (#tag juga boleh diketik lengkap)
function matchesSearch(t, terms = searchTerms()) {
  if (terms.length === 0) return true;
  const hay = fold(`${t.text} ${t.tags.map((tag) => `#${tag}`).join(" ")}`);
  return terms.every((term) => hay.includes(term));
}

function matchesView(t) {
  return (!activeFilter || t.tags.includes(activeFilter)) && matchesSearch(t);
}

function visibleTasks(list) {
  return list.filter(matchesView);
}

// Teks tugas dengan bagian yang cocok dibungkus <mark>
function highlight(text) {
  const terms = searchTerms().filter((term) => !term.startsWith("#"));
  if (terms.length === 0) return esc(text);
  const re = new RegExp(
    terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    "giu"
  );
  let out = "";
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    out += esc(text.slice(last, m.index)) + `<mark>${esc(m[0])}</mark>`;
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

const CAL_ICON = `<svg class="cal-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/></svg>`;

function dueBadgeHTML(t) {
  if (!t.due) return "";
  const { cls, label } = dueInfo(t.due);
  // Tugas yang sudah dicentang tidak perlu diwarnai "lewat"/"hari ini" lagi
  const state = t.checked ? "" : cls;
  return `<button class="due-badge ${state}" title="Tenggat ${esc(fmtDue(t.due))} — klik untuk ubah">${CAL_ICON}${esc(label)}</button>`;
}

function activeItemHTML(t) {
  const editing = t.id === editingId;
  const body = editing
    ? `<input type="text" class="edit-input" value="${esc(composeRaw(t))}"
         spellcheck="false" autocomplete="off" aria-label="Edit tugas">
       <div class="task-meta">Enter simpan · Esc batal</div>`
    : `<div class="task-text" title="Klik dua kali untuk edit">${highlight(t.text)}</div>
       ${renderTags(t.tags)}
       <div class="task-meta">${dueBadgeHTML(t)}<span>dibuat ${fmtDate(t.createdAt)}</span></div>`;
  return `
    <li class="task ${t.checked ? "checked" : ""} ${editing ? "editing" : ""}" data-id="${esc(t.id)}">
      <span class="drag-handle" title="Geser untuk mengurutkan">⠿</span>
      <input type="checkbox" class="check" ${t.checked ? "checked" : ""} title="Tandai selesai">
      <div class="task-body">${body}</div>
      <div class="task-actions">
        ${t.checked && !editing ? `<button class="done-btn" title="Pindahkan ke riwayat">Done ✓</button>` : ""}
        ${editing ? "" : `<div class="icon-row">
          ${t.due ? "" : `<button class="icon-btn set-due" title="Atur tenggat">${CAL_ICON}</button>`}
          <button class="icon-btn edit" title="Edit tugas">✎</button>
          <button class="icon-btn del" title="Hapus tugas">✕</button>
        </div>`}
      </div>
    </li>`;
}

// Di riwayat: tampilkan tenggat + tanda kalau selesainya melewati tenggat
function historyDueHTML(t) {
  if (!t.due) return "";
  const late = toDateKey(new Date(t.doneAt)) > t.due;
  return ` · tenggat ${esc(fmtDue(t.due))}${late ? ` <span class="late">(telat)</span>` : ""}`;
}

function historyItemHTML(t) {
  return `
    <li class="task checked" data-id="${esc(t.id)}">
      <div class="task-body">
        <div class="task-text">${highlight(t.text)}</div>
        ${renderTags(t.tags)}
        <div class="task-meta">selesai ${fmtDateTime(t.doneAt)}${historyDueHTML(t)}</div>
      </div>
      <div class="task-actions">
        <div class="icon-row">
          <button class="icon-btn restore" title="Kembalikan ke daftar aktif">↩</button>
          <button class="icon-btn del" title="Hapus dari riwayat">✕</button>
        </div>
      </div>
    </li>`;
}

function renderFilterChips() {
  const source = currentTab === "active" ? tasks : history;
  const allTags = [...new Set(source.flatMap((t) => t.tags))].sort();
  if (activeFilter && !allTags.includes(activeFilter)) activeFilter = null;
  tagFilter.innerHTML = allTags
    .map(
      (t) =>
        `<button class="filter-chip ${t === activeFilter ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)}</button>`
    )
    .join("");
}

function render() {
  pendingRender = false;
  counter.textContent = tasks.filter((t) => !t.checked).length;

  renderFilterChips();

  const activeItems = visibleTasks(tasks);
  taskList.innerHTML = activeItems.map(activeItemHTML).join("");
  $("#emptyActive").hidden = activeItems.length > 0 || tasks.length > 0;

  const historyItems = visibleTasks(history);
  historyList.innerHTML = historyItems.map(historyItemHTML).join("");
  $("#emptyHistory").hidden = historyItems.length > 0 || history.length > 0;

  // State "tidak ada yang cocok" kalau daftar ada isinya tapi tersaring habis
  const source = currentTab === "active" ? tasks : history;
  const shown = currentTab === "active" ? activeItems : historyItems;
  const noMatch = $("#emptySearch");
  noMatch.hidden = !(source.length > 0 && shown.length === 0);
  if (!noMatch.hidden) {
    $("#emptySearchMsg").textContent = searchQuery.trim()
      ? `Tidak ada yang cocok dengan “${searchQuery.trim()}”`
      : "Tidak ada tugas dengan tag ini";
  }
  searchClear.hidden = !searchQuery;
}

// ============ Events ============
addBtn.addEventListener("click", addTask);

taskInput.addEventListener("input", updateSuggest);
taskInput.addEventListener("blur", () => setTimeout(hideSuggest, 150));

taskInput.addEventListener("keydown", (e) => {
  const suggestOpen = !tagSuggest.hidden && suggestItems.length > 0;
  if (suggestOpen) {
    if (e.key === "ArrowDown") { e.preventDefault(); highlightSuggest(1); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); highlightSuggest(-1); return; }
    if (e.key === "Escape")    { hideSuggest(); return; }
    if ((e.key === "Enter" || e.key === "Tab") && suggestIndex >= 0) {
      e.preventDefault();
      applySuggestion(suggestIndex);
      return;
    }
    if (e.key === "Tab") {
      e.preventDefault();
      applySuggestion(0);
      return;
    }
  }
  if (e.key === "Enter") addTask();
});

tagSuggest.addEventListener("mousedown", (e) => {
  const item = e.target.closest(".suggest-item");
  if (!item) return;
  e.preventDefault();
  applySuggestion(Number(item.dataset.i));
});

taskList.addEventListener("click", (e) => {
  const li = e.target.closest(".task");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.classList.contains("check")) toggleCheck(id);
  else if (e.target.classList.contains("done-btn")) markDone(id, li);
  else if (e.target.classList.contains("edit")) startEdit(id);
  else if (e.target.closest(".due-badge, .set-due")) {
    const t = tasks.find((t) => t.id === id);
    openDuePicker(id, e.target.closest(".due-badge, .set-due"), t?.due);
  }
  else if (e.target.classList.contains("del")) deleteTask(id, li);
});

taskList.addEventListener("dblclick", (e) => {
  const text = e.target.closest(".task-text");
  if (!text) return;
  window.getSelection()?.removeAllRanges(); // dblclick ikut nyeleksi kata
  startEdit(text.closest(".task").dataset.id);
});

taskList.addEventListener("keydown", (e) => {
  if (!e.target.classList.contains("edit-input")) return;
  if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
  else if (e.key === "Escape") { e.preventDefault(); cancelEdit(); }
});

taskList.addEventListener("focusout", (e) => {
  if (e.target.classList.contains("edit-input")) commitEdit();
});

historyList.addEventListener("click", (e) => {
  const li = e.target.closest(".task");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.classList.contains("restore")) restoreTask(id);
  else if (e.target.classList.contains("del")) deleteHistoryItem(id, li);
});

tagFilter.addEventListener("click", (e) => {
  const chip = e.target.closest(".filter-chip");
  if (!chip) return;
  activeFilter = activeFilter === chip.dataset.tag ? null : chip.dataset.tag;
  render();
});

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    currentTab = tab.dataset.tab;
    $("#activeView").hidden = currentTab !== "active";
    $("#historyView").hidden = currentTab !== "history";
    activeFilter = null;
    render();
  });
});

$("#clearHistoryBtn").addEventListener("click", clearHistory);

// Undo: tombol di toast, atau Ctrl/Cmd+Z selama toast masih tampil
toastUndo.addEventListener("click", runUndo);

document.addEventListener("keydown", (e) => {
  if (!undoFn || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== "z") return;
  const el = document.activeElement;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox";
  // Jangan bajak undo bawaan input yang sedang berisi teks
  if (typing && el.value) return;
  e.preventDefault();
  runUndo();
});

// Search
searchInput.addEventListener("input", () => {
  searchQuery = searchInput.value;
  if (editingId) commitEdit();
  render();
});

function clearSearch() {
  searchInput.value = "";
  searchQuery = "";
  render();
}

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    if (searchInput.value) clearSearch();
    else searchInput.blur();
  }
});

searchClear.addEventListener("click", () => {
  clearSearch();
  searchInput.focus();
});

// "/" atau Ctrl/Cmd+F untuk fokus ke kolom cari (kecuali sedang mengetik di input lain)
document.addEventListener("keydown", (e) => {
  const el = document.activeElement;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA") && el.type !== "checkbox";
  const isFind = (e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === "f";
  if (isFind || (e.key === "/" && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

// Theme picker
$("#themeBtn").addEventListener("click", () => {
  const picker = $("#themePicker");
  picker.hidden = !picker.hidden;
});

$("#swatches").addEventListener("click", (e) => {
  const sw = e.target.closest(".swatch");
  if (!sw) return;
  theme = sw.dataset.key;
  save();
  applyTheme();
});

// Backup
$("#exportBtn").addEventListener("click", exportData);
$("#importBtn").addEventListener("click", () => $("#importFile").click());
$("#importFile").addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // biar file yang sama bisa dipilih lagi
  if (file) await importData(file);
});

// Tombol close: nutup side panel dari dalam
$("#closeBtn").addEventListener("click", () => window.close());

// Tanggal hari ini
$("#dueBtn").addEventListener("click", (e) => {
  const { due } = parseInput(taskInput.value);
  openDuePicker("composer", e.currentTarget, due);
});

// Tanggal hari ini. Dicek tiap menit supaya label "Hari ini"/"Lewat" ikut ganti
// kalau panel dibiarkan terbuka melewati tengah malam.
let shownDay = null;
function refreshToday() {
  const k = todayKey();
  if (k === shownDay) return;
  const first = shownDay === null;
  shownDay = k;
  $("#todayDate").textContent = new Date().toLocaleDateString("id-ID", {
    weekday: "long", day: "numeric", month: "long",
  });
  if (!first) requestRender();
}
refreshToday();
setInterval(refreshToday, 60 * 1000);

load();

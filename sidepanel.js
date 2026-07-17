// ============ State ============
let tasks = [];   // { id, text, tags[], checked, createdAt }
let history = []; // { id, text, tags[], createdAt, doneAt }
let activeFilter = null;
let currentTab = "active";
let theme = "auto";

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
  render(); // warna tag ikut tema
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

// ============ Storage ============
async function load() {
  const data = await chrome.storage.local.get({ tasks: [], history: [], theme: "auto" });
  tasks = data.tasks;
  history = data.history;
  theme = data.theme;
  applyTheme();
}

function save() {
  chrome.storage.local.set({ tasks, history, theme });
}

// ============ Helpers ============
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

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

// Ekstrak #tag dari teks input
function parseInput(raw) {
  const tags = [];
  const text = raw
    .replace(/#([\p{L}\p{N}_-]+)/gu, (_, t) => {
      const tag = t.toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
      return "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
  return { text, tags };
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short" });
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString("id-ID", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// ============ Saran tag ============
let suggestIndex = -1;
let suggestItems = [];

function updateSuggest() {
  const val = taskInput.value;
  const caret = taskInput.selectionStart ?? val.length;
  // token #... yang sedang diketik (tepat sebelum caret)
  const before = val.slice(0, caret);
  const m = before.match(/#([\p{L}\p{N}_-]*)$/u);
  if (!m) return hideSuggest();

  const prefix = m[1].toLowerCase();
  const { tags: usedInInput } = parseInput(val);
  suggestItems = knownTags().filter(
    (t) => t.startsWith(prefix) && t !== prefix && !usedInInput.includes(t)
  ).slice(0, 6);

  if (suggestItems.length === 0) return hideSuggest();

  suggestIndex = -1;
  tagSuggest.innerHTML = suggestItems
    .map((t, i) => `<button class="suggest-item" data-i="${i}">#${esc(t)}</button>`)
    .join("");
  tagSuggest.hidden = false;
}

function hideSuggest() {
  tagSuggest.hidden = true;
  suggestItems = [];
  suggestIndex = -1;
}

function applySuggestion(i) {
  const tag = suggestItems[i];
  if (!tag) return;
  const val = taskInput.value;
  const caret = taskInput.selectionStart ?? val.length;
  const before = val.slice(0, caret).replace(/#([\p{L}\p{N}_-]*)$/u, `#${tag} `);
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
  const { text, tags } = parseInput(raw);
  if (!text) return;
  tasks.unshift({ id: uid(), text, tags, checked: false, createdAt: Date.now() });
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

function deleteTask(id, el) {
  el.classList.add("removing");
  setTimeout(() => {
    tasks = tasks.filter((t) => t.id !== id);
    save();
    render();
  }, 170);
}

function deleteHistoryItem(id, el) {
  el.classList.add("removing");
  setTimeout(() => {
    history = history.filter((t) => t.id !== id);
    save();
    render();
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
  if (confirm(`Hapus ${history.length} item riwayat? Tindakan ini permanen.`)) {
    history = [];
    save();
    render();
  }
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
  // Urutan id yang terlihat di DOM (bisa saja sedang difilter)
  const visibleOrder = [...taskList.querySelectorAll(".task")].map((li) => li.dataset.id);
  // Posisi (index) item-item visible di array tasks
  const slots = [];
  tasks.forEach((t, i) => {
    if (visibleOrder.includes(t.id)) slots.push(i);
  });
  // Isi ulang slot sesuai urutan DOM baru
  const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
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

function visibleTasks(list) {
  return activeFilter ? list.filter((t) => t.tags.includes(activeFilter)) : list;
}

function render() {
  counter.textContent = tasks.length;

  const source = currentTab === "active" ? tasks : history;
  const allTags = [...new Set(source.flatMap((t) => t.tags))].sort();
  if (activeFilter && !allTags.includes(activeFilter)) activeFilter = null;
  tagFilter.innerHTML = allTags
    .map(
      (t) =>
        `<button class="filter-chip ${t === activeFilter ? "on" : ""}" data-tag="${esc(t)}">#${esc(t)}</button>`
    )
    .join("");

  const activeItems = visibleTasks(tasks);
  taskList.innerHTML = activeItems
    .map(
      (t) => `
    <li class="task ${t.checked ? "checked" : ""}" data-id="${t.id}">
      <span class="drag-handle" title="Geser untuk mengurutkan">⠿</span>
      <input type="checkbox" class="check" ${t.checked ? "checked" : ""} title="Tandai selesai">
      <div class="task-body">
        <div class="task-text">${esc(t.text)}</div>
        ${renderTags(t.tags)}
        <div class="task-meta">dibuat ${fmtDate(t.createdAt)}</div>
      </div>
      <div class="task-actions">
        ${t.checked ? `<button class="done-btn" title="Pindahkan ke riwayat">Done ✓</button>` : ""}
        <button class="icon-btn del" title="Hapus tugas">✕</button>
      </div>
    </li>`
    )
    .join("");
  $("#emptyActive").hidden = activeItems.length > 0;

  const historyItems = visibleTasks(history);
  historyList.innerHTML = historyItems
    .map(
      (t) => `
    <li class="task checked" data-id="${t.id}">
      <div class="task-body">
        <div class="task-text">${esc(t.text)}</div>
        ${renderTags(t.tags)}
        <div class="task-meta">selesai ${fmtDateTime(t.doneAt)}</div>
      </div>
      <div class="task-actions">
        <button class="icon-btn restore" title="Kembalikan ke daftar aktif">↩</button>
        <button class="icon-btn del" title="Hapus dari riwayat">✕</button>
      </div>
    </li>`
    )
    .join("");
  $("#emptyHistory").hidden = historyItems.length > 0;
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
  else if (e.target.classList.contains("del")) deleteTask(id, li);
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

// Tombol close: nutup side panel dari dalam
$("#closeBtn").addEventListener("click", () => window.close());

// Tanggal hari ini
$("#todayDate").textContent = new Date().toLocaleDateString("id-ID", {
  weekday: "long", day: "numeric", month: "long",
});

load();

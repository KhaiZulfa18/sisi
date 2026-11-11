// Klik icon extension di toolbar -> buka side panel
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error(err));

// ============ Badge jumlah tugas di ikon toolbar ============
// Angka = tugas aktif yang belum dicentang. Badge merah kalau ada yang
// tenggatnya hari ini atau sudah lewat, selain itu abu-abu netral.
const BADGE_NORMAL = "#5f5e57";
const BADGE_URGENT = "#c2410c";
const BADGE_ALARM = "sisi-badge-refresh";

const pad2 = (n) => String(n).padStart(2, "0");
const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

async function updateBadge() {
  const { tasks = [] } = await chrome.storage.local.get({ tasks: [] });
  const open = tasks.filter((t) => !t.checked);
  const today = todayKey();
  const urgent = open.filter((t) => t.due && t.due <= today).length;

  const text = open.length === 0 ? "" : open.length > 99 ? "99+" : String(open.length);
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color: urgent ? BADGE_URGENT : BADGE_NORMAL });
  if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  await chrome.action.setTitle({
    title: open.length === 0
      ? "Sisi — tidak ada tugas"
      : `Sisi — ${open.length} tugas aktif${urgent ? `, ${urgent} jatuh tempo` : ""}`,
  });
}

// Alarm berkala supaya warna "jatuh tempo" ikut berubah setelah ganti hari,
// walaupun data tidak berubah dan side panel tidak dibuka.
function ensureAlarm() {
  chrome.alarms.create(BADGE_ALARM, { periodInMinutes: 30 });
}

chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); updateBadge(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); updateBadge(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === BADGE_ALARM) updateBadge(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.tasks) updateBadge();
});

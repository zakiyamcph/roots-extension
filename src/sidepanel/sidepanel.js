const els = {
  statusPill: document.getElementById("status-pill"),
  statusHint: document.getElementById("status-hint"),
  toggleActivate: document.getElementById("toggle-activate"),
  statsSection: document.getElementById("stats-section"),
  statVerbs: document.getElementById("stat-verbs"),
  statAdvanced: document.getElementById("stat-advanced"),
  toggleRootVisualizer: document.getElementById("toggle-root-visualizer"),
  toggleDiacritics: document.getElementById("toggle-diacritics"),
  toggleHeatmap: document.getElementById("toggle-heatmap"),
  sensitivityRow: document.getElementById("sensitivity-row"),
  selectSensitivity: document.getElementById("select-sensitivity"),
  themeSwatches: document.getElementById("theme-swatches"),
  openOptions: document.getElementById("open-options"),
};

let currentTabId = null;
let settings = null;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function isSupportedUrl(url) {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

function renderStatus(active) {
  els.statusPill.dataset.state = active ? "on" : "off";
  els.statusPill.textContent = active ? "Active" : "Off";
  els.toggleActivate.textContent = active ? "Deactivate on this page" : "Activate on this page";
  els.toggleActivate.dataset.active = String(active);
  els.statsSection.hidden = !active;
  els.statusHint.textContent = active
    ? "Hover a highlighted verb to see its root and forms."
    : "Scans the current tab for Arabic verbs and vocabulary.";
}

function renderSettings() {
  els.toggleRootVisualizer.checked = settings.rootVisualizer;
  els.toggleDiacritics.checked = settings.diacritics;
  els.toggleHeatmap.checked = settings.heatmap;
  els.selectSensitivity.value = settings.heatmapSensitivity;
  els.sensitivityRow.hidden = !settings.heatmap;
  for (const btn of els.themeSwatches.children) {
    btn.dataset.selected = String(btn.dataset.theme === settings.theme);
  }
}

function renderStats(stats) {
  els.statVerbs.textContent = stats.verbs ?? 0;
  els.statAdvanced.textContent = stats.advanced ?? 0;
}

async function refresh() {
  const tab = await getActiveTab();
  currentTabId = tab?.id ?? null;
  settings = await chrome.runtime.sendMessage({ type: "ROOTS_GET_SETTINGS" });
  renderSettings();

  if (!tab || !isSupportedUrl(tab.url)) {
    els.toggleActivate.disabled = true;
    els.statusHint.textContent = "Roots can't run on this page.";
    renderStatus(false);
    return;
  }
  els.toggleActivate.disabled = false;
  const { active } = await chrome.runtime.sendMessage({ type: "ROOTS_GET_STATUS", tabId: currentTabId });
  renderStatus(active);
}

async function pushSettings(partial) {
  const res = await chrome.runtime.sendMessage({ type: "ROOTS_SET_SETTINGS", settings: partial });
  settings = res.settings;
  renderSettings();
}

els.toggleActivate.addEventListener("click", async () => {
  if (currentTabId == null) return;
  const activating = els.toggleActivate.dataset.active !== "true";
  els.toggleActivate.disabled = true;
  const type = activating ? "ROOTS_REQUEST_ACTIVATE" : "ROOTS_REQUEST_DEACTIVATE";
  await chrome.runtime.sendMessage({ type, tabId: currentTabId });
  els.toggleActivate.disabled = false;
  renderStatus(activating);
  if (!activating) renderStats({ verbs: 0, advanced: 0 });
});

els.toggleRootVisualizer.addEventListener("change", () => pushSettings({ rootVisualizer: els.toggleRootVisualizer.checked }));
els.toggleDiacritics.addEventListener("change", () => pushSettings({ diacritics: els.toggleDiacritics.checked }));
els.toggleHeatmap.addEventListener("change", () => {
  els.sensitivityRow.hidden = !els.toggleHeatmap.checked;
  pushSettings({ heatmap: els.toggleHeatmap.checked });
});
els.selectSensitivity.addEventListener("change", () => pushSettings({ heatmapSensitivity: els.selectSensitivity.value }));

els.themeSwatches.addEventListener("click", (e) => {
  const btn = e.target.closest(".swatch");
  if (!btn) return;
  pushSettings({ theme: btn.dataset.theme });
});

els.openOptions.addEventListener("click", () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "ROOTS_STATS_UPDATE" && message.tabId === currentTabId) {
    renderStats(message.stats);
  }
});

chrome.tabs.onActivated.addListener(refresh);
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === currentTabId && info.status === "loading") refresh();
});

refresh();

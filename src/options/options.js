const DEFAULT_SETTINGS = {
  theme: "light",
  fontFamily: "cairo",
  fontScale: 1,
  rootVisualizer: true,
  diacritics: true,
  heatmap: true,
  heatmapSensitivity: "medium",
};

const els = {
  themeGrid: document.getElementById("theme-grid"),
  fontFamily: document.getElementById("font-family"),
  fontScale: document.getElementById("font-scale"),
  fontScaleValue: document.getElementById("font-scale-value"),
  fontPreview: document.getElementById("font-preview"),
  optRootVisualizer: document.getElementById("opt-root-visualizer"),
  optDiacritics: document.getElementById("opt-diacritics"),
  optHeatmap: document.getElementById("opt-heatmap"),
  optSensitivityRow: document.getElementById("opt-sensitivity-row"),
  optSensitivity: document.getElementById("opt-sensitivity"),
  resetDefaults: document.getElementById("reset-defaults"),
  saveIndicator: document.getElementById("save-indicator"),
};

function render(settings) {
  for (const card of els.themeGrid.children) {
    card.dataset.selected = String(card.dataset.theme === settings.theme);
  }
  els.fontFamily.value = settings.fontFamily;
  els.fontScale.value = settings.fontScale;
  els.fontScaleValue.textContent = `${Math.round(settings.fontScale * 100)}%`;
  els.fontPreview.dataset.font = settings.fontFamily;
  els.fontPreview.style.setProperty("--preview-scale", settings.fontScale);

  els.optRootVisualizer.checked = settings.rootVisualizer;
  els.optDiacritics.checked = settings.diacritics;
  els.optHeatmap.checked = settings.heatmap;
  els.optSensitivityRow.hidden = !settings.heatmap;
  els.optSensitivity.value = settings.heatmapSensitivity;
}

let saveTimer = null;
function flashSaved() {
  els.saveIndicator.textContent = "Saved";
  els.saveIndicator.classList.add("visible");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => els.saveIndicator.classList.remove("visible"), 1200);
}

async function update(partial) {
  const res = await chrome.runtime.sendMessage({ type: "ROOTS_SET_SETTINGS", settings: partial });
  render(res.settings);
  flashSaved();
}

async function init() {
  const settings = await chrome.runtime.sendMessage({ type: "ROOTS_GET_SETTINGS" });
  render(settings);
}

els.themeGrid.addEventListener("click", (e) => {
  const card = e.target.closest(".theme-card");
  if (!card) return;
  update({ theme: card.dataset.theme });
});

els.fontFamily.addEventListener("change", () => update({ fontFamily: els.fontFamily.value }));
els.fontScale.addEventListener("input", () => {
  els.fontScaleValue.textContent = `${Math.round(els.fontScale.value * 100)}%`;
  els.fontPreview.style.setProperty("--preview-scale", els.fontScale.value);
});
els.fontScale.addEventListener("change", () => update({ fontScale: Number(els.fontScale.value) }));

els.optRootVisualizer.addEventListener("change", () => update({ rootVisualizer: els.optRootVisualizer.checked }));
els.optDiacritics.addEventListener("change", () => update({ diacritics: els.optDiacritics.checked }));
els.optHeatmap.addEventListener("change", () => {
  els.optSensitivityRow.hidden = !els.optHeatmap.checked;
  update({ heatmap: els.optHeatmap.checked });
});
els.optSensitivity.addEventListener("change", () => update({ heatmapSensitivity: els.optSensitivity.value }));

els.resetDefaults.addEventListener("click", () => update({ ...DEFAULT_SETTINGS }));

init();

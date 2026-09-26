// Shared settings shape + defaults, imported by the background worker,
// side panel, options page, and (via a plain-object copy) the content script.

export const DEFAULT_SETTINGS = {
  theme: "light", // "light" | "dark" | "sepia"
  fontFamily: "cairo", // "cairo" | "amiri" | "system"
  fontScale: 1, // multiplier applied to the base popover/overlay font size
  rootVisualizer: true,
  diacritics: true,
  heatmap: true,
  heatmapSensitivity: "medium", // "low" | "medium" | "high"
};

export const THEMES = ["light", "dark", "sepia"];
export const FONT_FAMILIES = ["cairo", "amiri", "system"];
export const HEATMAP_SENSITIVITIES = ["low", "medium", "high"];

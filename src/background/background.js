// Roots — background service worker
// Responsibilities: track per-tab activation state, inject the content
// script/styles on demand (activeTab + scripting, no broad host permissions),
// relay messages between the side panel / options page and content scripts,
// and keep chrome.storage settings in sync across all surfaces.
//
// Active-tab state lives in chrome.storage.session rather than a plain
// in-memory Map: MV3 service workers are recycled after ~30s idle, which
// would otherwise silently wipe activation state mid-session.

import { DEFAULT_SETTINGS } from "../shared/settings.js";

const CONTENT_CSS = "src/content/content.css";
const CONTENT_JS = "src/content/content.js";
const ACTIVE_TABS_KEY = "activeTabIds";

async function getActiveTabIds() {
  const stored = await chrome.storage.session.get(ACTIVE_TABS_KEY);
  return new Set(stored[ACTIVE_TABS_KEY] || []);
}

async function isTabActive(tabId) {
  return (await getActiveTabIds()).has(tabId);
}

async function markTabActive(tabId, active) {
  const ids = await getActiveTabIds();
  if (active) ids.add(tabId);
  else ids.delete(tabId);
  await chrome.storage.session.set({ [ACTIVE_TABS_KEY]: [...ids] });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
});

// openPanelOnActionClick is deliberately OFF: it makes the toolbar icon
// click auto-open the panel, but that means chrome.action.onClicked never
// fires — and clicking a button *inside* an already-open panel does not
// grant/refresh activeTab for whatever tab is focused (confirmed: this was
// the actual cause of "Activate on this page" failing with "Cannot access
// contents of the page..."). action.onClicked, below, is the one gesture
// Chrome guarantees comes with a valid activeTab grant for that exact tab,
// so it both opens the panel AND activates directly, in the same gesture.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (err) {
    console.error("[Roots BG] failed to open side panel:", err);
  }
  try {
    if (!(await isTabActive(tab.id))) {
      await activateOnTab(tab.id);
    }
  } catch (err) {
    // Restricted page (chrome://, Web Store, etc.) — the panel still opens;
    // its own "Activate on this page" button will surface this same error
    // if the user tries again.
    console.error("[Roots BG] auto-activate on icon click failed:", err);
  }
});

async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setBadge(tabId, isActive) {
  await chrome.action.setBadgeText({ tabId, text: isActive ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0D5E59" });
}

async function activateOnTab(tabId) {
  if (await isTabActive(tabId)) return { ok: true, alreadyActive: true };

  await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_CSS] });
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_JS] });

  const settings = await getSettings();
  const initResult = await chrome.tabs.sendMessage(tabId, { type: "ROOTS_INIT", settings });
  if (!initResult?.ok) {
    throw new Error(initResult?.error || "content script failed to initialize");
  }

  await markTabActive(tabId, true);
  await setBadge(tabId, true);
  return { ok: true, alreadyActive: false };
}

async function deactivateOnTab(tabId) {
  if (!(await isTabActive(tabId))) return { ok: true };
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ROOTS_TEARDOWN" });
  } catch {
    // Tab may have navigated away already; nothing to tear down.
  }
  await markTabActive(tabId, false);
  await setBadge(tabId, false);
  return { ok: true };
}

chrome.tabs.onRemoved.addListener((tabId) => markTabActive(tabId, false));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // Navigation invalidates any previously injected content script.
    markTabActive(tabId, false).catch(() => {});
    setBadge(tabId, false).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case "ROOTS_REQUEST_ACTIVATE": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId == null) return sendResponse({ ok: false, error: "no-tab" });
          sendResponse(await activateOnTab(tabId));
          return;
        }
        case "ROOTS_REQUEST_DEACTIVATE": {
          const tabId = message.tabId ?? sender.tab?.id;
          if (tabId == null) return sendResponse({ ok: false, error: "no-tab" });
          sendResponse(await deactivateOnTab(tabId));
          return;
        }
        case "ROOTS_GET_STATUS": {
          sendResponse({ active: await isTabActive(message.tabId) });
          return;
        }
        case "ROOTS_GET_SETTINGS": {
          sendResponse(await getSettings());
          return;
        }
        case "ROOTS_SET_SETTINGS": {
          const merged = { ...(await getSettings()), ...message.settings };
          await chrome.storage.sync.set({ settings: merged });
          sendResponse({ ok: true, settings: merged });
          return;
        }
        case "ROOTS_STATS": {
          // Forward page-scan stats from the content script to any open side panel.
          chrome.runtime.sendMessage({ type: "ROOTS_STATS_UPDATE", tabId: sender.tab?.id, stats: message.stats }).catch(() => {});
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: "unknown-message" });
      }
    } catch (err) {
      // e.g. scripting.executeScript rejects on restricted pages (chrome://,
      // the Web Store, etc.) — surface a clean error instead of hanging the
      // caller's sendMessage promise forever.
      sendResponse({ ok: false, error: err?.message ?? String(err) });
    }
  })();
  return true; // keep the message channel open for the async response
});

// Broadcast settings changes (e.g. from the options page) to every active tab.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync" || !changes.settings) return;
  const settings = changes.settings.newValue;
  getActiveTabIds().then((ids) => {
    for (const tabId of ids) {
      chrome.tabs.sendMessage(tabId, { type: "ROOTS_SETTINGS_UPDATED", settings }).catch(() => {});
    }
  });
});

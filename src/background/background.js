// Roots — background service worker
// Responsibilities: track per-tab activation state, inject the content
// script/styles on demand (activeTab + scripting, no broad host permissions),
// relay messages between the side panel / options page and content scripts,
// and keep chrome.storage settings in sync across all surfaces.

import { DEFAULT_SETTINGS } from "../shared/settings.js";

const CONTENT_CSS = "src/content/content.css";
const CONTENT_JS = "src/content/content.js";

/** tabId -> boolean */
const activeTabs = new Map();

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
  }
  // Clicking the toolbar icon opens the side panel instead of a popup.
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
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
  if (activeTabs.get(tabId)) return { ok: true, alreadyActive: true };

  await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_CSS] });
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_JS] });

  const settings = await getSettings();
  await chrome.tabs.sendMessage(tabId, { type: "ROOTS_INIT", settings });

  activeTabs.set(tabId, true);
  await setBadge(tabId, true);
  return { ok: true, alreadyActive: false };
}

async function deactivateOnTab(tabId) {
  if (!activeTabs.get(tabId)) return { ok: true };
  try {
    await chrome.tabs.sendMessage(tabId, { type: "ROOTS_TEARDOWN" });
  } catch {
    // Tab may have navigated away already; nothing to tear down.
  }
  activeTabs.delete(tabId);
  await setBadge(tabId, false);
  return { ok: true };
}

chrome.tabs.onRemoved.addListener((tabId) => activeTabs.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") {
    // Navigation resets any injected content script.
    activeTabs.delete(tabId);
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
          const tabId = message.tabId;
          sendResponse({ active: Boolean(activeTabs.get(tabId)) });
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
  for (const tabId of activeTabs.keys()) {
    chrome.tabs.sendMessage(tabId, { type: "ROOTS_SETTINGS_UPDATED", settings }).catch(() => {});
  }
});

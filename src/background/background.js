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

// Clicking the toolbar icon opens the side panel instead of a popup. Set
// unconditionally at every service worker startup (not just onInstalled) —
// this setting isn't guaranteed to persist across every Chrome version's
// service-worker lifecycle, and if it's ever unset, clicking the toolbar
// icon does nothing (no popup, no onClicked listener registered), which
// also means activeTab never gets granted for that tab.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function getSettings() {
  const stored = await chrome.storage.sync.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

async function setBadge(tabId, isActive) {
  await chrome.action.setBadgeText({ tabId, text: isActive ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0D5E59" });
}

async function activateOnTab(tabId) {
  console.log("[Roots BG] activateOnTab", tabId);
  if (await isTabActive(tabId)) {
    console.log("[Roots BG] already active");
    return { ok: true, alreadyActive: true };
  }

  console.log("[Roots BG] inserting CSS...");
  await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_CSS] });
  console.log("[Roots BG] CSS inserted, executing content script...");
  await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_JS] });
  console.log("[Roots BG] content script executed, sending ROOTS_INIT...");

  const settings = await getSettings();
  const initResult = await chrome.tabs.sendMessage(tabId, { type: "ROOTS_INIT", settings });
  console.log("[Roots BG] ROOTS_INIT result:", initResult);
  if (!initResult?.ok) {
    throw new Error(initResult?.error || "content script failed to initialize");
  }

  await markTabActive(tabId, true);
  await setBadge(tabId, true);
  console.log("[Roots BG] activation complete");
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

console.log("[Roots BG] service worker (re)started");

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[Roots BG] received message:", message?.type, message);
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

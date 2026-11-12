/**
 * AltPan Background Script (Manifest V3)
 * Handles initial configuration setup and toolbar badge indicators.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  modifierKey: "Alt", // "Alt", "Shift", "Ctrl", "Meta"
  sensitivity: 1.0,
  momentumEnabled: true,
  friction: 0.92,
  blacklist: [
    "figma.com",
    "miro.com",
    "maps.google.com"
  ]
};

async function getStorage() {
  return browser.storage.sync || browser.storage.local;
}

async function initializeSettings() {
  try {
    const storage = await getStorage();
    const stored = await storage.get(null);
    const toSet = {};

    for (const [key, val] of Object.entries(DEFAULT_SETTINGS)) {
      if (stored[key] === undefined) {
        toSet[key] = val;
      }
    }

    if (Object.keys(toSet).length > 0) {
      await storage.set(toSet);
    }

    const currentEnabled = stored.enabled !== undefined ? stored.enabled : DEFAULT_SETTINGS.enabled;
    updateBadge(currentEnabled);
  } catch (err) {
    console.error("[AltPan] Failed to initialize settings:", err);
  }
}

function updateBadge(enabled) {
  if (enabled) {
    browser.action.setBadgeText({ text: "" });
  } else {
    browser.action.setBadgeText({ text: "OFF" });
    browser.action.setBadgeBackgroundColor({ color: "#64748b" });
  }
}

// Lifecycle listeners
browser.runtime.onInstalled.addListener(() => {
  initializeSettings();
});

browser.runtime.onStartup.addListener(() => {
  initializeSettings();
});

// React to live settings changes
browser.storage.onChanged.addListener((changes, areaName) => {
  if (changes.enabled) {
    updateBadge(changes.enabled.newValue);
  }
});

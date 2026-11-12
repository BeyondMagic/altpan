/**
 * AltPan Background Script (Manifest V3)
 * Handles native messaging bridge to altpan_host for APZ visual viewport panning,
 * initial settings configuration, and toolbar badge state.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  modifierKey: "None", // "None", "Alt", "Shift", "Ctrl", "Meta"
  sensitivity: 0.5,
  momentumEnabled: true,
  friction: 0.92,
  blacklist: [
    "figma.com",
    "miro.com",
    "maps.google.com"
  ]
};

let nativePort = null;

function getNativePort() {
  if (nativePort) return nativePort;
  try {
    nativePort = browser.runtime.connectNative("altpan_host");
    nativePort.onDisconnect.addListener((p) => {
      const err = (p && p.error) || browser.runtime.lastError;
      console.warn("[AltPan] Native port disconnected:", err);
      nativePort = null;
    });
    nativePort.onMessage.addListener((res) => {
      // Async responses from host if needed
    });
    return nativePort;
  } catch (err) {
    console.warn("[AltPan] Failed to connect native host:", err);
    nativePort = null;
    return null;
  }
}

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

// Test native host connection on script load
function pingNativeHost() {
  try {
    browser.runtime.sendNativeMessage("altpan_host", { type: "ping" })
      .then((res) => {
        console.log("[AltPan] Native bridge startup ping response:", res);
      })
      .catch((err) => {
        console.warn("[AltPan] Native bridge startup ping error:", err);
      });
  } catch (e) {
    console.warn("[AltPan] Failed to initiate native ping:", e);
  }
}
pingNativeHost();

// Lifecycle listeners
browser.runtime.onInstalled.addListener(() => {
  initializeSettings();
  pingNativeHost();
});

browser.runtime.onStartup.addListener(() => {
  initializeSettings();
  pingNativeHost();
});

// React to live settings changes
browser.storage.onChanged.addListener((changes, areaName) => {
  if (changes.enabled) {
    updateBadge(changes.enabled.newValue);
  }
});

// Message router between content scripts, popup, and native host
browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  // 1. Health check from popup UI
  if (msg.type === "altpan:check_native") {
    return new Promise((resolve) => {
      try {
        browser.runtime.sendNativeMessage("altpan_host", { type: "ping" })
          .then((res) => {
            resolve({
              connected: !!(res && res.ok),
              uinput: !!(res && res.uinput_active)
            });
          })
          .catch((err) => {
            resolve({
              connected: false,
              error: String(err && err.message ? err.message : err)
            });
          });
      } catch (e) {
        resolve({ connected: false, error: String(e) });
      }
    });
  }

  // 2. High-performance native pan dispatch for pinch-zoomed viewports
  if (msg.type === "altpan:native_pan") {
    const port = getNativePort();
    if (port) {
      try {
        port.postMessage({
          type: "pan",
          deltaX: msg.deltaX,
          deltaY: msg.deltaY,
          scale: msg.scale || 1.0,
          sensitivity: msg.sensitivity || 1.0
        });
        return Promise.resolve({ ok: true });
      } catch (e) {
        nativePort = null;
        return Promise.resolve({ ok: false, error: String(e) });
      }
    }
    return Promise.resolve({ ok: false, error: "Native port unavailable" });
  }
});

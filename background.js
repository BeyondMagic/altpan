/**
 * AltPan Background Script (Manifest V3)
 * Routes visual-viewport pan and pinch-zoom requests through the built-in
 * WebExtension Experiment API (browser.altpan), manages defaults, and updates the badge.
 */

const DEFAULT_SETTINGS = {
  enabled: true,
  modifierKey: "None", // "None", "Alt", "Shift", "Ctrl", "Meta"
  pinchZoomModifier: "Off", // "Off", "Alt", "Shift", "Ctrl", "Meta"
  sensitivity: 0.5,
  momentumEnabled: true,
  friction: 0.92,
  forceVisualPan: false,
  debugMode: false,
  blacklist: [
    "figma.com",
    "miro.com",
    "maps.google.com"
  ]
};

function hasExperimentAPI() {
  return !!(
    typeof browser !== "undefined" &&
    browser.altpan &&
    typeof browser.altpan.panVisual === "function"
  );
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

browser.runtime.onInstalled.addListener(() => {
  initializeSettings();
});

browser.runtime.onStartup.addListener(() => {
  initializeSettings();
});

browser.storage.onChanged.addListener((changes) => {
  if (changes.enabled) {
    updateBadge(changes.enabled.newValue);
  }
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || !msg.type) return;

  if (msg.type === "altpan:check_status") {
    if (!hasExperimentAPI()) {
      return Promise.resolve({ available: false });
    }
    return browser.altpan.getCapabilities()
      .then((res) => ({ available: !!(res && res.available) }))
      .catch((err) => ({ available: false, error: String(err) }));
  }

  if (!sender.tab || sender.tab.id == null) {
    return;
  }
  const tabId = sender.tab.id;

  if (msg.type === "altpan:visual_pan") {
    if (!hasExperimentAPI()) {
      return Promise.resolve({ ok: false, reason: "experiment-disabled" });
    }
    const optNum = (val) => (val != null && Number.isFinite(Number(val)) ? Number(val) : undefined);
    return browser.altpan.panVisual({
      tabId,
      deltaX: Number(msg.deltaX) || 0,
      deltaY: Number(msg.deltaY) || 0,
      screenDeltaX: optNum(msg.screenDeltaX),
      screenDeltaY: optNum(msg.screenDeltaY),
      contentDpr: optNum(msg.contentDpr),
      phase: typeof msg.phase === "string" ? msg.phase : undefined,
      screenX: optNum(msg.screenX),
      screenY: optNum(msg.screenY),
      forceVisual: !!msg.forceVisual,
      debug: !!msg.debug
    }).then((res) => {
      if (!res || !res.ok) {
        console.warn("[AltPan] panVisual returned error:", res);
      }
      return res;
    });
  }

  if (msg.type === "altpan:visual_zoom") {
    if (!hasExperimentAPI()) {
      return Promise.resolve({ ok: false, reason: "experiment-disabled" });
    }
    return browser.altpan.zoomVisual({
      tabId,
      factor: Number(msg.factor) || 1.0,
      deltaY: Number(msg.deltaY) || 0,
      deltaMode: Number(msg.deltaMode) || 0,
      clientX: Number(msg.clientX) || 0,
      clientY: Number(msg.clientY) || 0,
      debug: !!msg.debug
    }).then((res) => {
      if (!res || !res.ok) {
        console.warn("[AltPan] zoomVisual returned error:", res);
      }
      return res;
    });
  }
});

/**
 * AltPan Popup Settings Controller
 */

document.addEventListener("DOMContentLoaded", async () => {
  const elements = {
    enableToggle: document.getElementById("enable-toggle"),
    modifierSelect: document.getElementById("modifier-select"),
    pinchZoomSelect: document.getElementById("pinch-zoom-select"),
    sensitivitySlider: document.getElementById("sensitivity-slider"),
    sensitivityValue: document.getElementById("sensitivity-value"),
    momentumToggle: document.getElementById("momentum-toggle"),
    frictionContainer: document.getElementById("friction-container"),
    frictionSlider: document.getElementById("friction-slider"),
    frictionValue: document.getElementById("friction-value"),
    blacklistInput: document.getElementById("blacklist-input"),
    addCurrentBtn: document.getElementById("add-current-btn"),
    debugToggle: document.getElementById("debug-toggle"),
    siteStatusPill: document.getElementById("site-status-pill"),
    siteStatusText: document.getElementById("site-status-text"),
    saveStatus: document.getElementById("save-status"),
    experimentDesc: document.getElementById("experiment-desc"),
    experimentStatusBadge: document.getElementById("experiment-status-badge"),
    experimentHelp: document.getElementById("experiment-help")
  };

  const DEFAULT_SETTINGS = {
    enabled: true,
    modifierKey: "None",
    pinchZoomModifier: "Off",
    sensitivity: 0.5,
    momentumEnabled: true,
    friction: 0.92,
    debugMode: false,
    blacklist: [
      "figma.com",
      "miro.com",
      "maps.google.com"
    ]
  };

  let currentHostname = "";
  let saveTimeout = null;

  function getStorage() {
    return browser.storage.sync || browser.storage.local;
  }

  function getFrictionLabel(friction) {
    if (friction < 0.89) return "Crisp";
    if (friction > 0.94) return "Floaty";
    return "Normal";
  }

  function updateStatusPill(enabled, isExcluded) {
    elements.siteStatusPill.className = "status-pill";
    if (!enabled) {
      elements.siteStatusPill.classList.add("status-disabled");
      elements.siteStatusText.textContent = "Disabled";
    } else if (isExcluded) {
      elements.siteStatusPill.classList.add("status-excluded");
      elements.siteStatusText.textContent = "Excluded";
    } else {
      elements.siteStatusPill.classList.add("status-active");
      elements.siteStatusText.textContent = currentHostname ? "Active" : "Ready";
    }
  }

  async function checkExperimentStatus() {
    try {
      const res = await browser.runtime.sendMessage({ type: "altpan:check_status" });
      elements.experimentStatusBadge.className = "badge-value";

      if (res && res.available) {
        elements.experimentStatusBadge.textContent = "Active";
        elements.experimentStatusBadge.classList.add("badge-connected");
        elements.experimentDesc.textContent = "Built-in APZ visual viewport pan ready";
        elements.experimentHelp.style.display = "none";
      } else {
        elements.experimentStatusBadge.textContent = "Disabled";
        elements.experimentStatusBadge.classList.add("badge-offline");
        elements.experimentDesc.textContent = "Required for pinch-zoom visual pan";
        elements.experimentHelp.style.display = "flex";
      }
    } catch {
      elements.experimentStatusBadge.textContent = "Disabled";
      elements.experimentStatusBadge.classList.add("badge-offline");
      elements.experimentDesc.textContent = "Required for pinch-zoom visual pan";
      elements.experimentHelp.style.display = "flex";
    }
  }

  function parseBlacklist(text) {
    return text
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0);
  }

  function isHostExcluded(host, list) {
    if (!host || !list.length) return false;
    const h = host.toLowerCase();
    return list.some((item) => h === item || h.endsWith("." + item));
  }

  async function loadCurrentTabHost() {
    try {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      if (tabs && tabs[0] && tabs[0].url) {
        const url = new URL(tabs[0].url);
        if (url.protocol === "http:" || url.protocol === "https:") {
          currentHostname = url.hostname.replace(/^www\./, "");
        }
      }
    } catch {
      // Ignore internal pages
    }
  }

  async function loadSettings() {
    await loadCurrentTabHost();
    const storage = getStorage();
    const settings = await storage.get(null);

    const merged = { ...DEFAULT_SETTINGS, ...settings };

    elements.enableToggle.checked = merged.enabled;
    elements.modifierSelect.value = merged.modifierKey;
    elements.pinchZoomSelect.value = merged.pinchZoomModifier;
    elements.sensitivitySlider.value = merged.sensitivity;
    elements.sensitivityValue.textContent = Number(merged.sensitivity).toFixed(1) + "x";

    elements.momentumToggle.checked = merged.momentumEnabled;
    elements.frictionSlider.value = merged.friction;
    elements.frictionValue.textContent = getFrictionLabel(Number(merged.friction));

    if (!merged.momentumEnabled) {
      elements.frictionContainer.classList.add("disabled");
    } else {
      elements.frictionContainer.classList.remove("disabled");
    }

    elements.blacklistInput.value = (merged.blacklist || []).join("\n");
    elements.debugToggle.checked = !!merged.debugMode;

    const excluded = isHostExcluded(currentHostname, merged.blacklist || []);
    updateStatusPill(merged.enabled, excluded);

    await checkExperimentStatus();
  }

  async function saveSettings() {
    const list = parseBlacklist(elements.blacklistInput.value);
    const settings = {
      enabled: elements.enableToggle.checked,
      modifierKey: elements.modifierSelect.value,
      pinchZoomModifier: elements.pinchZoomSelect.value,
      sensitivity: parseFloat(elements.sensitivitySlider.value),
      momentumEnabled: elements.momentumToggle.checked,
      friction: parseFloat(elements.frictionSlider.value),
      debugMode: elements.debugToggle.checked,
      blacklist: list
    };

    const storage = getStorage();
    await storage.set(settings);

    const excluded = isHostExcluded(currentHostname, list);
    updateStatusPill(settings.enabled, excluded);

    elements.saveStatus.textContent = "Saved";
    elements.saveStatus.classList.add("saved");
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      elements.saveStatus.textContent = "Settings saved automatically";
      elements.saveStatus.classList.remove("saved");
    }, 1200);
  }

  // --- Event Listeners ---

  elements.enableToggle.addEventListener("change", saveSettings);
  elements.modifierSelect.addEventListener("change", saveSettings);
  elements.pinchZoomSelect.addEventListener("change", saveSettings);

  elements.sensitivitySlider.addEventListener("input", (e) => {
    elements.sensitivityValue.textContent = Number(e.target.value).toFixed(1) + "x";
    saveSettings();
  });

  elements.momentumToggle.addEventListener("change", (e) => {
    if (e.target.checked) {
      elements.frictionContainer.classList.remove("disabled");
    } else {
      elements.frictionContainer.classList.add("disabled");
    }
    saveSettings();
  });

  elements.frictionSlider.addEventListener("input", (e) => {
    elements.frictionValue.textContent = getFrictionLabel(Number(e.target.value));
    saveSettings();
  });

  elements.blacklistInput.addEventListener("input", saveSettings);
  elements.debugToggle.addEventListener("change", saveSettings);

  elements.addCurrentBtn.addEventListener("click", () => {
    if (!currentHostname) return;
    const currentList = parseBlacklist(elements.blacklistInput.value);
    if (!currentList.includes(currentHostname)) {
      currentList.push(currentHostname);
      elements.blacklistInput.value = currentList.join("\n");
      saveSettings();
    }
  });

  await loadSettings();
});

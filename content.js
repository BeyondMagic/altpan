/**
 * AltPan Content Script (Manifest V3)
 * Provides 1:1 "Hand Tool" drag-to-pan scrolling across both standard layout
 * viewports and pinch-zoomed visual viewports using Firefox's internal
 * scrollToVisual / setResolutionAndScaleTo APIs via a WebExtension Experiment.
 */

(function () {
  "use strict";

  if (window.__ALTPAN_INITIALIZED__) return;
  window.__ALTPAN_INITIALIZED__ = true;

  const DEFAULT_SETTINGS = {
    enabled: true,
    modifierKey: "None", // "None", "Alt", "Shift", "Ctrl", "Meta"
    pinchZoomModifier: "Off", // "Off", "Alt", "Shift", "Ctrl", "Meta"
    sensitivity: 0.5,
    momentumEnabled: true,
    friction: 0.92,
    blacklist: [
      "figma.com",
      "miro.com",
      "maps.google.com"
    ]
  };

  let settings = { ...DEFAULT_SETTINGS };

  // Runtime state
  let isPanning = false;
  let justFinishedPan = false;
  let startTargetElement = null;

  let lastScreenX = 0;
  let lastScreenY = 0;
  let lastTimestamp = 0;
  let velocitySamples = [];
  let momentumRafId = null;

  // Animation frame batching & serialized visual pan queue
  let pendingDx = 0;
  let pendingDy = 0;
  let panRafId = null;
  let isPanInFlight = false;
  let queuedVisualX = 0;
  let queuedVisualY = 0;

  // Anti-loop guard for our own synthesized APZ zoom wheel events
  let lastSyntheticZoomAt = 0;
  let lastSyntheticZoomX = 0;
  let lastSyntheticZoomY = 0;
  let lastSyntheticZoomDeltaY = 0;
  let lastSyntheticZoomDeltaMode = 0;

  // Track own momentum wheel events so sendWheelEvent doesn't cancel momentum
  let lastMomentumDeltaX = 0;
  let lastMomentumDeltaY = 0;
  let lastMomentumSentAt = 0;

  const STYLE_ID = "altpan-cursor-lock-style";

  // --- Settings Synchronization ---

  function syncSettings() {
    try {
      const storage = typeof browser !== "undefined" && browser.storage && (browser.storage.sync || browser.storage.local);
      if (storage) {
        storage.get(null).then((data) => {
          if (data && typeof data === "object") {
            settings = { ...DEFAULT_SETTINGS, ...data };
          }
        }).catch((err) => {
          console.warn("[AltPan] Storage load fallback:", err);
        });
      }
    } catch {
      // Ignore context invalidated
    }
  }

  if (typeof browser !== "undefined" && browser.storage && browser.storage.onChanged) {
    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "sync" || area === "local") {
        for (const key of Object.keys(changes)) {
          settings[key] = changes[key].newValue;
        }
      }
    });
  }

  syncSettings();

  // --- Helper Functions ---

  function isBlacklisted(hostname, list) {
    if (!list || !Array.isArray(list)) return false;
    const host = (hostname || "").toLowerCase().trim();
    if (!host) return false;
    return list.some((item) => {
      const clean = (item || "").toLowerCase().trim();
      if (!clean) return false;
      return host === clean || host.endsWith("." + clean);
    });
  }

  function isModifierActive(e, keyName) {
    switch (keyName) {
      case "None":
        return true;
      case "Alt":
        return e.altKey;
      case "Shift":
        return e.shiftKey;
      case "Ctrl":
        return e.ctrlKey;
      case "Meta":
        return e.metaKey;
      default:
        return false;
    }
  }

  function injectGrabbingCursor() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      html, body, * {
        cursor: grabbing !important;
        user-select: none !important;
        -moz-user-select: none !important;
        -webkit-user-select: none !important;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function removeGrabbingCursor() {
    const style = document.getElementById(STYLE_ID);
    if (style) {
      style.remove();
    }
  }

  // --- Inner Scrollable Container + Visual Viewport Panning ---

  function findScrollableAncestor(el, needX, needY) {
    let cur = el;
    while (cur && cur !== document.documentElement && cur !== document.body) {
      const style = window.getComputedStyle(cur);
      const ox = style.overflowX;
      const oy = style.overflowY;
      const canX = needX && (ox === "auto" || ox === "scroll") && (cur.scrollWidth > cur.clientWidth);
      const canY = needY && (oy === "auto" || oy === "scroll") && (cur.scrollHeight > cur.clientHeight);

      if (canX || canY) {
        return { element: cur, canX, canY };
      }
      cur = cur.parentElement;
    }
    return null;
  }

  function applyPanDelta(startEl, scrollX, scrollY) {
    let remX = scrollX;
    let remY = scrollY;

    if (startEl) {
      const ancestor = findScrollableAncestor(startEl, Math.abs(scrollX) > 0, Math.abs(scrollY) > 0);
      if (ancestor) {
        const el = ancestor.element;
        const beforeX = el.scrollLeft;
        const beforeY = el.scrollTop;
        el.scrollBy({
          left: ancestor.canX ? scrollX : 0,
          top: ancestor.canY ? scrollY : 0,
          behavior: "instant"
        });
        if (ancestor.canX) remX -= (el.scrollLeft - beforeX);
        if (ancestor.canY) remY -= (el.scrollTop - beforeY);
      }
    }

    if (Math.abs(remX) <= 0.05 && Math.abs(remY) <= 0.05) {
      return;
    }

    const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;

    if (scale > 1.02 && typeof browser !== "undefined" && browser.runtime) {
      queuedVisualX += remX;
      queuedVisualY += remY;
      pumpVisualPan();
    } else {
      window.scrollBy({ left: remX, top: remY, behavior: "instant" });
    }
  }

  function pumpVisualPan() {
    if (isPanInFlight) return;

    const dx = queuedVisualX;
    const dy = queuedVisualY;
    if (Math.abs(dx) <= 0.05 && Math.abs(dy) <= 0.05) {
      queuedVisualX = 0;
      queuedVisualY = 0;
      return;
    }

    queuedVisualX = 0;
    queuedVisualY = 0;
    isPanInFlight = true;
    lastMomentumDeltaX = dx;
    lastMomentumDeltaY = dy;
    lastMomentumSentAt = performance.now();

    browser.runtime.sendMessage({
      type: "altpan:visual_pan",
      deltaX: dx,
      deltaY: dy
    }).then((res) => {
      if (!res || !res.ok) {
        console.warn("[AltPan] visual_pan failed, falling back to scrollBy:", res);
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      }
    }).catch((err) => {
      console.warn("[AltPan] visual_pan sendMessage failed:", err);
      window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    }).finally(() => {
      isPanInFlight = false;
      if (Math.abs(queuedVisualX) > 0.05 || Math.abs(queuedVisualY) > 0.05) {
        pumpVisualPan();
      }
    });
  }

  // --- Momentum / Inertia Simulation ---

  function cancelMomentum() {
    if (momentumRafId !== null) {
      cancelAnimationFrame(momentumRafId);
      momentumRafId = null;
    }
  }

  function startMomentum(vx, vy) {
    cancelMomentum();

    const friction = typeof settings.friction === "number" ? settings.friction : 0.92;
    const MAX_SPEED = 90;
    const currentSpeed = Math.hypot(vx, vy);

    if (currentSpeed > MAX_SPEED) {
      vx = (vx / currentSpeed) * MAX_SPEED;
      vy = (vy / currentSpeed) * MAX_SPEED;
    }

    function step() {
      vx *= friction;
      vy *= friction;

      if (Math.hypot(vx, vy) < 0.25) {
        cancelMomentum();
        return;
      }

      applyPanDelta(startTargetElement, vx, vy);
      momentumRafId = requestAnimationFrame(step);
    }

    momentumRafId = requestAnimationFrame(step);
  }

  function onInterruptMomentum(e) {
    if (
      e &&
      e.type === "wheel" &&
      e.deltaMode === 0 &&
      performance.now() - lastMomentumSentAt < 120 &&
      Math.abs(e.deltaX - lastMomentumDeltaX) < 0.1 &&
      Math.abs(e.deltaY - lastMomentumDeltaY) < 0.1
    ) {
      return;
    }
    cancelMomentum();
  }

  // --- Animation Frame Drag Dispatcher ---

  function cancelPanRaf() {
    if (panRafId !== null) {
      cancelAnimationFrame(panRafId);
      panRafId = null;
    }
  }

  function dispatchPendingPan() {
    panRafId = null;
    if (!isPanning) return;

    const dx = pendingDx;
    const dy = pendingDy;
    pendingDx = 0;
    pendingDy = 0;

    if (dx === 0 && dy === 0) return;

    const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
    const sensitivity = typeof settings.sensitivity === "number" ? settings.sensitivity : 0.5;
    applyPanDelta(startTargetElement, -(dx / scale) * sensitivity, -(dy / scale) * sensitivity);
  }

  // --- Core Drag Gesture Lifecycle ---

  function onMouseDown(e) {
    if (e.button !== 1) return;

    if (!settings.enabled || isBlacklisted(window.location.hostname, settings.blacklist)) {
      return;
    }

    if (!isModifierActive(e, settings.modifierKey)) {
      return;
    }

    // Suppress Firefox's built-in auto-scroll icon, link opening, and X11 paste
    e.preventDefault();
    e.stopImmediatePropagation();

    cancelMomentum();
    cancelPanRaf();
    pendingDx = 0;
    pendingDy = 0;
    queuedVisualX = 0;
    queuedVisualY = 0;
    isPanning = true;
    startTargetElement = e.target;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    lastTimestamp = performance.now();
    velocitySamples = [];

    injectGrabbingCursor();
  }

  function onMouseMove(e) {
    if (!isPanning) return;

    if (!isModifierActive(e, settings.modifierKey)) {
      endPan(true);
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    const dx = e.screenX - lastScreenX;
    const dy = e.screenY - lastScreenY;
    const dt = now - lastTimestamp;

    if (dx === 0 && dy === 0) return;

    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    lastTimestamp = now;

    pendingDx += dx;
    pendingDy += dy;

    const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
    const sensitivity = typeof settings.sensitivity === "number" ? settings.sensitivity : 0.5;

    if (dt > 0) {
      const scrollX = -(dx / scale) * sensitivity;
      const scrollY = -(dy / scale) * sensitivity;
      velocitySamples.push({ scrollX, scrollY, dt, time: now });
      velocitySamples = velocitySamples.filter((s) => now - s.time < 90);
      if (velocitySamples.length > 8) velocitySamples.shift();
    }

    if (!panRafId) {
      panRafId = requestAnimationFrame(dispatchPendingPan);
    }
  }

  function onMouseUp(e) {
    if (!isPanning) return;

    if (e.button === 1) {
      e.preventDefault();
      e.stopImmediatePropagation();
      endPan(true);
    }
  }

  function endPan(launchMomentum) {
    if (!isPanning) return;
    isPanning = false;

    cancelPanRaf();

    if (pendingDx !== 0 || pendingDy !== 0) {
      const dx = pendingDx;
      const dy = pendingDy;
      pendingDx = 0;
      pendingDy = 0;

      const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
      const sensitivity = typeof settings.sensitivity === "number" ? settings.sensitivity : 0.5;
      applyPanDelta(startTargetElement, -(dx / scale) * sensitivity, -(dy / scale) * sensitivity);
    }

    justFinishedPan = true;
    setTimeout(() => {
      justFinishedPan = false;
    }, 150);

    removeGrabbingCursor();

    if (launchMomentum && settings.momentumEnabled && velocitySamples.length > 0) {
      const now = performance.now();
      const recent = velocitySamples.filter((s) => now - s.time < 80);

      if (recent.length > 0) {
        let totalX = 0;
        let totalY = 0;
        let totalDt = 0;

        for (const s of recent) {
          totalX += s.scrollX;
          totalY += s.scrollY;
          totalDt += s.dt;
        }

        if (totalDt > 0) {
          const vx = (totalX / totalDt) * 16.67;
          const vy = (totalY / totalDt) * 16.67;
          if (Math.hypot(vx, vy) > 1.2) {
            startMomentum(vx, vy);
          }
        }
      }
    }
  }

  // --- Built-in Cursor-Centered Pinch-Zoom ---

  function onWheelZoom(e) {
    const mod = settings.pinchZoomModifier;
    if (!mod || mod === "Off") return;
    if (!settings.enabled || isBlacklisted(window.location.hostname, settings.blacklist)) return;
    if (!isModifierActive(e, mod)) return;
    if (!e.deltaY) return;

    const now = performance.now();
    if (
      now - lastSyntheticZoomAt < 150 &&
      Math.abs(e.clientX - lastSyntheticZoomX) < 1 &&
      Math.abs(e.clientY - lastSyntheticZoomY) < 1 &&
      Math.abs(e.deltaY - lastSyntheticZoomDeltaY) < 0.01 &&
      e.deltaMode === lastSyntheticZoomDeltaMode
    ) {
      // Allow our own synthesized APZ zoom wheel event to reach Firefox natively
      lastSyntheticZoomAt = 0;
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();
    cancelMomentum();

    lastSyntheticZoomAt = now;
    lastSyntheticZoomX = e.clientX;
    lastSyntheticZoomY = e.clientY;
    lastSyntheticZoomDeltaY = e.deltaY;
    lastSyntheticZoomDeltaMode = e.deltaMode;

    // Fallback factor in case no mousewheel.*.action=5 pref is configured
    let pixelDeltaY = e.deltaY;
    if (e.deltaMode === 1) {
      pixelDeltaY *= 32;
    } else if (e.deltaMode === 2) {
      pixelDeltaY *= window.innerHeight;
    }
    const factor = Math.exp(-pixelDeltaY * 0.0008);

    if (typeof browser !== "undefined" && browser.runtime) {
      browser.runtime.sendMessage({
        type: "altpan:visual_zoom",
        factor,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        clientX: e.clientX,
        clientY: e.clientY
      }).catch((err) => {
        console.warn("[AltPan] visual_zoom sendMessage failed:", err);
      });
    }
  }

  // --- Event Suppression & Interception ---

  function onAuxClick(e) {
    if (e.button === 1 && (isPanning || justFinishedPan || isModifierActive(e, settings.modifierKey))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function onClick(e) {
    if (justFinishedPan || (e.button === 1 && isModifierActive(e, settings.modifierKey))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function onContextMenu(e) {
    if (isPanning || justFinishedPan) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }

  function onKeyUp(e) {
    if (isPanning && !isModifierActive(e, settings.modifierKey)) {
      endPan(true);
    }
  }

  function onBlur() {
    if (isPanning) endPan(false);
    queuedVisualX = 0;
    queuedVisualY = 0;
    cancelMomentum();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (isPanning) endPan(false);
      queuedVisualX = 0;
      queuedVisualY = 0;
      cancelMomentum();
    }
  }

  // --- Attach Listeners with Capture Phase ---

  window.addEventListener("mousedown", onMouseDown, { capture: true, passive: false });
  window.addEventListener("mousemove", onMouseMove, { capture: true, passive: false });
  window.addEventListener("mouseup", onMouseUp, { capture: true, passive: false });
  window.addEventListener("wheel", onWheelZoom, { capture: true, passive: false });
  window.addEventListener("auxclick", onAuxClick, { capture: true, passive: false });
  window.addEventListener("click", onClick, { capture: true, passive: false });
  window.addEventListener("contextmenu", onContextMenu, { capture: true, passive: false });
  window.addEventListener("keyup", onKeyUp, { capture: true, passive: true });
  window.addEventListener("blur", onBlur, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange, { capture: true, passive: true });

  // Any non-zoom user gesture cancels active kinetic momentum
  window.addEventListener("pointerdown", onInterruptMomentum, { capture: true, passive: true });
  window.addEventListener("wheel", onInterruptMomentum, { capture: true, passive: true });
  window.addEventListener("touchstart", onInterruptMomentum, { capture: true, passive: true });
  window.addEventListener("keydown", onInterruptMomentum, { capture: true, passive: true });
})();

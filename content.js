/**
 * AltPan Content Script (Manifest V3)
 * Provides 1:1 "Hand Tool" drag-to-pan scrolling for zoomed webpages and viewports.
 * Uses Native Messaging bridge (uinput high-res wheel) when pinch-zoomed to drive
 * Firefox APZ compositor, and smooth direct DOM/container scrolling at normal zoom.
 */

(function () {
  "use strict";

  // Prevent double-injection
  if (window.__ALTPAN_INITIALIZED__) return;
  window.__ALTPAN_INITIALIZED__ = true;

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

  let settings = { ...DEFAULT_SETTINGS };

  // Runtime state
  let isPanning = false;
  let justFinishedPan = false;
  let isPinchZoomedSession = false;
  let startTargetElement = null;

  let lastClientX = 0;
  let lastClientY = 0;
  let lastTimestamp = 0;
  let velocitySamples = [];
  let momentumRafId = null;

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
    } catch (err) {
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
      case "Alt":
        return e.altKey;
      case "Shift":
        return e.shiftKey;
      case "Ctrl":
        return e.ctrlKey;
      case "Meta":
        return e.metaKey;
      default:
        return e.altKey;
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

  // --- Smart Container + Window Scrolling ---

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

  function scrollContainerOrWindow(startEl, scrollX, scrollY) {
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

    if (Math.abs(remX) > 0.5 || Math.abs(remY) > 0.5) {
      window.scrollBy({
        left: remX,
        top: remY,
        behavior: "instant"
      });
    }
  }

  // --- Momentum / Inertia Simulation ---

  function cancelMomentum() {
    if (momentumRafId !== null) {
      cancelAnimationFrame(momentumRafId);
      momentumRafId = null;
    }
  }

  function startMomentum(vx, vy, isPinchZoomed, scale) {
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

      if (isPinchZoomed && typeof browser !== "undefined" && browser.runtime) {
        // In pinch zoom, replay decaying velocity through native wheel bridge
        browser.runtime.sendMessage({
          type: "altpan:native_pan",
          deltaX: -vx,
          deltaY: -vy,
          scale: scale,
          sensitivity: 1.0
        }).catch(() => {});
      } else {
        scrollContainerOrWindow(startTargetElement, vx, vy);
      }

      momentumRafId = requestAnimationFrame(step);
    }

    momentumRafId = requestAnimationFrame(step);
  }

  function onInterruptMomentum() {
    cancelMomentum();
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
    isPanning = true;
    startTargetElement = e.target;
    lastClientX = e.clientX;
    lastClientY = e.clientY;
    lastTimestamp = performance.now();
    velocitySamples = [];

    // Check if currently pinch-zoomed via APZ
    const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
    isPinchZoomedSession = scale > 1.05;

    injectGrabbingCursor();
  }

  function onMouseMove(e) {
    if (!isPanning) return;

    // If modifier was released while dragging, seamlessly end pan and engage momentum
    if (!isModifierActive(e, settings.modifierKey)) {
      endPan(true);
      return;
    }

    e.preventDefault();
    e.stopImmediatePropagation();

    const now = performance.now();
    const dx = e.clientX - lastClientX;
    const dy = e.clientY - lastClientY;
    const dt = now - lastTimestamp;

    if (dx === 0 && dy === 0) return;

    const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
    const sensitivity = typeof settings.sensitivity === "number" ? settings.sensitivity : 1.0;

    if (scale > 1.05) {
      // 1. PINCH-ZOOMED APZ MODE: Route through Native Messaging bridge
      isPinchZoomedSession = true;
      if (typeof browser !== "undefined" && browser.runtime) {
        browser.runtime.sendMessage({
          type: "altpan:native_pan",
          deltaX: dx,
          deltaY: dy,
          scale: scale,
          sensitivity: sensitivity
        }).catch(() => {});
      }
    } else {
      // 2. STANDARD MODE: Direct DOM / Container 1:1 Scroll with Residual Fallback
      isPinchZoomedSession = false;
      const scrollX = - (dx / scale) * sensitivity;
      const scrollY = - (dy / scale) * sensitivity;

      const beforeX = window.scrollX;
      scrollContainerOrWindow(startTargetElement, scrollX, scrollY);
      const movedX = window.scrollX - beforeX;
      const residualX = scrollX - movedX;

      // If page layout has 0 horizontal scroll extent, forward residual delta to native APZ bridge
      if (Math.abs(residualX) > 0.5 && typeof browser !== "undefined" && browser.runtime) {
        browser.runtime.sendMessage({
          type: "altpan:native_pan",
          deltaX: -residualX,
          deltaY: 0,
          scale: 1.0,
          sensitivity: 1.0
        }).catch(() => {});
      }
    }

    if (dt > 0) {
      const scrollX = - (dx / scale) * sensitivity;
      const scrollY = - (dy / scale) * sensitivity;
      velocitySamples.push({ scrollX, scrollY, dt, time: now });
      velocitySamples = velocitySamples.filter((s) => now - s.time < 90);
      if (velocitySamples.length > 6) velocitySamples.shift();
    }

    lastClientX = e.clientX;
    lastClientY = e.clientY;
    lastTimestamp = now;
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

    // Guard flag to swallow trailing auxclick / click / contextmenu events
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
          const speed = Math.hypot(vx, vy);

          if (speed > 1.2) {
            const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
            startMomentum(vx, vy, isPinchZoomedSession, scale);
          }
        }
      }
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
    cancelMomentum();
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (isPanning) endPan(false);
      cancelMomentum();
    }
  }

  // --- Attach Listeners with Capture Phase ---

  window.addEventListener("mousedown", onMouseDown, { capture: true, passive: false });
  window.addEventListener("mousemove", onMouseMove, { capture: true, passive: false });
  window.addEventListener("mouseup", onMouseUp, { capture: true, passive: false });
  window.addEventListener("auxclick", onAuxClick, { capture: true, passive: false });
  window.addEventListener("click", onClick, { capture: true, passive: false });
  window.addEventListener("contextmenu", onContextMenu, { capture: true, passive: false });
  window.addEventListener("keyup", onKeyUp, { capture: true, passive: true });
  window.addEventListener("blur", onBlur, { capture: true, passive: true });
  document.addEventListener("visibilitychange", onVisibilityChange, { capture: true, passive: true });

  // Any user gesture cancels active kinetic momentum
  window.addEventListener("pointerdown", onInterruptMomentum, { capture: true, passive: true });
  window.addEventListener("wheel", onInterruptMomentum, { capture: true, passive: true });
  window.addEventListener("touchstart", onInterruptMomentum, { capture: true, passive: true });
  window.addEventListener("keydown", onInterruptMomentum, { capture: true, passive: true });
})();

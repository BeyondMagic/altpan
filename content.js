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
    forceVisualPan: false,
    debugMode: false,
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
  let visualGestureOpen = false;
  let pendingVisualEnd = false;
  let pendingCloseFirst = false;
  let startPanScreenX = null;
  let startPanScreenY = null;

  // Anti-loop guard for our own synthesized APZ zoom wheel events
  let lastSyntheticZoomAt = 0;
  let lastSyntheticZoomX = 0;
  let lastSyntheticZoomY = 0;
  let lastSyntheticZoomDeltaY = 0;
  let lastSyntheticZoomDeltaMode = 0;

  // Track own momentum wheel events so sendWheelEvent/PanGesture doesn't cancel momentum
  let lastMomentumDeltaX = 0;
  let lastMomentumDeltaY = 0;
  let lastMomentumScreenDeltaX = 0;
  let lastMomentumScreenDeltaY = 0;
  let lastMomentumDpr = 1;
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

  function describeElement(el) {
    if (!el) return null;
    if (el === document || el === window) return "DOCUMENT";
    const tag = el.tagName || "NODE";
    const id = el.id ? `#${el.id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/).slice(0, 3).join(".")}`
      : "";
    let extra = "";
    try {
      const cs = window.getComputedStyle(el);
      extra = ` (ov=${cs.overflowX}/${cs.overflowY}, sw=${el.scrollWidth}/${el.clientWidth}, sh=${el.scrollHeight}/${el.clientHeight})`;
    } catch {
      // Ignore
    }
    return `${tag}${id}${cls}${extra}`;
  }

  function debugLog(event, data) {
    if (!settings.debugMode) return;
    console.info(`[AltPan Debug] ${event}`, data);
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

    if (startEl && !settings.forceVisualPan) {
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
        const movedX = el.scrollLeft - beforeX;
        const movedY = el.scrollTop - beforeY;
        if (ancestor.canX) remX -= movedX;
        if (ancestor.canY) remY -= movedY;
        debugLog("ancestor scroll", {
          ancestor: describeElement(el),
          canX: ancestor.canX,
          canY: ancestor.canY,
          reqX: scrollX,
          reqY: scrollY,
          movedX,
          movedY,
          remX,
          remY
        });
      }
    }

    const scale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;

    if ((scale > 1.02 || settings.forceVisualPan) && typeof browser !== "undefined" && browser.runtime) {
      if (remX === 0 && remY === 0) return;
      queuedVisualX += remX;
      queuedVisualY += remY;
      pumpVisualPan();
      return;
    }

    if (Math.abs(remX) <= 0.05 && Math.abs(remY) <= 0.05) {
      return;
    }

    {
      const beforeX = window.scrollX;
      const beforeY = window.scrollY;
      window.scrollBy({ left: remX, top: remY, behavior: "instant" });
      const movedX = window.scrollX - beforeX;
      const movedY = window.scrollY - beforeY;
      debugLog("dom scrollBy", {
        isTopFrame: window === window.top,
        scale,
        reqX: remX,
        reqY: remY,
        movedX,
        movedY,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      });
    }
  }

  function dispatchVisualPanMessage(payload) {
    isPanInFlight = true;
    browser.runtime.sendMessage(payload).then((res) => {
      if (settings.debugMode) {
        debugLog("visual_pan result", {
          dx: payload.deltaX,
          dy: payload.deltaY,
          phase: payload.phase,
          res
        });
      }
      if (!res || !res.ok) {
        console.warn("[AltPan] visual_pan failed, falling back to scrollBy:", res);
        if (payload.deltaX || payload.deltaY) {
          window.scrollBy({ left: payload.deltaX, top: payload.deltaY, behavior: "instant" });
        }
      }
    }).catch((err) => {
      console.warn("[AltPan] visual_pan sendMessage failed:", err);
      if (payload.deltaX || payload.deltaY) {
        window.scrollBy({ left: payload.deltaX, top: payload.deltaY, behavior: "instant" });
      }
    }).finally(() => {
      isPanInFlight = false;
      pumpVisualPan();
    });
  }

  function dispatchVisualEndMessage() {
    dispatchVisualPanMessage({
      type: "altpan:visual_pan",
      deltaX: 0,
      deltaY: 0,
      screenDeltaX: 0,
      screenDeltaY: 0,
      contentDpr: window.devicePixelRatio || 1,
      phase: "end",
      screenX: typeof startPanScreenX === "number" ? startPanScreenX : undefined,
      screenY: typeof startPanScreenY === "number" ? startPanScreenY : undefined,
      forceVisual: !!settings.forceVisualPan,
      debug: !!settings.debugMode
    });
  }

  function pumpVisualPan() {
    if (isPanInFlight || typeof browser === "undefined" || !browser.runtime) return;

    if (pendingCloseFirst) {
      pendingCloseFirst = false;
      if (visualGestureOpen) {
        visualGestureOpen = false;
        dispatchVisualEndMessage();
        return;
      }
    }

    const curScale = (window.visualViewport && window.visualViewport.scale) ? window.visualViewport.scale : 1.0;
    const screenMag = Math.hypot(queuedVisualX * curScale, queuedVisualY * curScale);
    const shouldFlush = screenMag >= 0.12 || (pendingVisualEnd && screenMag > 0.005);

    if (shouldFlush) {
      const dx = queuedVisualX;
      const dy = queuedVisualY;
      queuedVisualX = 0;
      queuedVisualY = 0;

      const dpr = window.devicePixelRatio || 1;
      const screenDeltaX = dx * curScale;
      const screenDeltaY = dy * curScale;
      const phase = visualGestureOpen ? "update" : "begin";
      visualGestureOpen = true;

      lastMomentumDeltaX = dx;
      lastMomentumDeltaY = dy;
      lastMomentumScreenDeltaX = screenDeltaX;
      lastMomentumScreenDeltaY = screenDeltaY;
      lastMomentumDpr = dpr;
      lastMomentumSentAt = performance.now();

      dispatchVisualPanMessage({
        type: "altpan:visual_pan",
        deltaX: dx,
        deltaY: dy,
        screenDeltaX,
        screenDeltaY,
        contentDpr: dpr,
        phase,
        screenX: typeof startPanScreenX === "number" ? startPanScreenX : undefined,
        screenY: typeof startPanScreenY === "number" ? startPanScreenY : undefined,
        forceVisual: !!settings.forceVisualPan,
        debug: !!settings.debugMode
      });
      return;
    }

    if (pendingVisualEnd) {
      pendingVisualEnd = false;
      queuedVisualX = 0;
      queuedVisualY = 0;
      if (visualGestureOpen) {
        visualGestureOpen = false;
        dispatchVisualEndMessage();
      }
    }
  }

  function closeVisualGestureImmediately() {
    if (!visualGestureOpen) {
      queuedVisualX = 0;
      queuedVisualY = 0;
      pendingVisualEnd = false;
      return;
    }
    queuedVisualX = 0;
    queuedVisualY = 0;
    pendingVisualEnd = false;
    pendingCloseFirst = true;
    pumpVisualPan();
  }

  function requestVisualEndAfterFlush() {
    if (!visualGestureOpen) return;
    pendingVisualEnd = true;
    pumpVisualPan();
  }

  // --- Momentum / Inertia Simulation ---

  function cancelMomentum(closeMode = "immediate") {
    if (momentumRafId !== null) {
      cancelAnimationFrame(momentumRafId);
      momentumRafId = null;
    }
    if (closeMode === "flush") {
      requestVisualEndAfterFlush();
    } else if (closeMode === "immediate") {
      closeVisualGestureImmediately();
    }
  }

  function startMomentum(vx, vy) {
    cancelMomentum("none");

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
        cancelMomentum("flush");
        return;
      }

      applyPanDelta(startTargetElement, vx, vy);
      momentumRafId = requestAnimationFrame(step);
    }

    momentumRafId = requestAnimationFrame(step);
  }

  function matchesSynthesizedWheelEcho(e) {
    if (!e || e.type !== "wheel" || e.deltaMode !== 0) return false;
    if (performance.now() - lastMomentumSentAt >= 150) return false;
    const candidates = [
      [lastMomentumDeltaX, lastMomentumDeltaY],
      [lastMomentumScreenDeltaX, lastMomentumScreenDeltaY],
      [lastMomentumScreenDeltaX * lastMomentumDpr, lastMomentumScreenDeltaY * lastMomentumDpr]
    ];
    return candidates.some(([ex, ey]) => Math.abs(e.deltaX - ex) < 0.35 && Math.abs(e.deltaY - ey) < 0.35);
  }

  function onInterruptMomentum(e) {
    if (matchesSynthesizedWheelEcho(e)) {
      return;
    }
    cancelMomentum(isPanning ? "none" : "immediate");
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

    if (!settings.enabled) {
      debugLog("ignored mousedown (disabled)", { isTopFrame: window === window.top, href: window.location.href });
      return;
    }

    if (isBlacklisted(window.location.hostname, settings.blacklist)) {
      debugLog("ignored mousedown (blacklisted)", { hostname: window.location.hostname });
      return;
    }

    if (!isModifierActive(e, settings.modifierKey)) {
      debugLog("ignored mousedown (modifier inactive)", {
        expected: settings.modifierKey,
        alt: e.altKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey
      });
      return;
    }

    // Suppress Firefox's built-in auto-scroll icon, link opening, and X11 paste
    e.preventDefault();
    e.stopImmediatePropagation();

    cancelMomentum("immediate");
    cancelPanRaf();
    pendingDx = 0;
    pendingDy = 0;
    queuedVisualX = 0;
    queuedVisualY = 0;
    pendingVisualEnd = false;
    isPanning = true;
    startTargetElement = e.target;
    lastScreenX = e.screenX;
    lastScreenY = e.screenY;
    const dpr = window.devicePixelRatio || 1;
    startPanScreenX = e.screenX * dpr;
    startPanScreenY = e.screenY * dpr;
    lastTimestamp = performance.now();
    velocitySamples = [];

    if (settings.debugMode) {
      const vv = window.visualViewport;
      const docEl = document.documentElement;
      const ancestor = findScrollableAncestor(e.target, true, true);
      debugLog("pan start", {
        isTopFrame: window === window.top,
        href: window.location.href,
        scale: vv ? vv.scale : 1.0,
        vvOffset: vv ? `${vv.offsetLeft}, ${vv.offsetTop}` : null,
        vvPage: vv ? `${vv.pageLeft}, ${vv.pageTop}` : null,
        docScroll: `${window.scrollX}, ${window.scrollY}`,
        docSize: docEl ? `${docEl.scrollWidth}/${docEl.clientWidth} x ${docEl.scrollHeight}/${docEl.clientHeight}` : null,
        target: describeElement(e.target),
        ancestor: ancestor ? describeElement(ancestor.element) : null
      });
    }

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

    let launchedMomentum = false;
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
            launchedMomentum = true;
            startMomentum(vx, vy);
          }
        }
      }
    }

    if (!launchedMomentum) {
      requestVisualEndAfterFlush();
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
        clientY: e.clientY,
        debug: !!settings.debugMode
      }).then((res) => {
        if (settings.debugMode) {
          debugLog("wheel zoom result", {
            deltaY: e.deltaY,
            deltaMode: e.deltaMode,
            clientX: e.clientX,
            clientY: e.clientY,
            res
          });
        }
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
    cancelMomentum("immediate");
  }

  function onVisibilityChange() {
    if (document.hidden) {
      if (isPanning) endPan(false);
      cancelMomentum("immediate");
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

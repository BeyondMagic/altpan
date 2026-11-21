const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

const ACTOR_NAME = "AltPan";
const RESOURCE_HOST = "altpan";

let actorRegistered = false;

function getResProtoHandler() {
  return Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
}

function ensureActorRegistered(extension) {
  if (actorRegistered) {
    return;
  }

  const resProto = getResProtoHandler();
  resProto.setSubstitutionWithFlags(
    RESOURCE_HOST,
    extension.rootURI,
    Ci.nsISubstitutingProtocolHandler.ALLOW_CONTENT_ACCESS
  );

  try {
    ChromeUtils.unregisterWindowActor(ACTOR_NAME);
  } catch {
    // Not previously registered
  }

  ChromeUtils.registerWindowActor(ACTOR_NAME, {
    parent: {
      esModuleURI: `resource://${RESOURCE_HOST}/experiment/AltPanActorParent.sys.mjs`,
    },
    child: {
      esModuleURI: `resource://${RESOURCE_HOST}/experiment/AltPanActorChild.sys.mjs`,
    },
    allFrames: false,
    safeForUntrustedWebProcess: true,
    remoteTypes: [
      "web",
      "file",
      "privilegedabout",
      "privilegedmozilla",
      "extension",
    ],
  });

  actorRegistered = true;
  console.info("[AltPan Experiment] Registered AltPan actor:", extension.rootURI.spec);
}

const MOUSEWHEEL_ZOOM_PREFS = [
  ["mousewheel.with_alt.action", 0x01],
  ["mousewheel.with_control.action", 0x02],
  ["mousewheel.with_shift.action", 0x04],
  ["mousewheel.with_meta.action", 0x08],
  ["mousewheel.default.action", 0x00],
];

function findNativePinchModifier() {
  for (const [prefName, modFlag] of MOUSEWHEEL_ZOOM_PREFS) {
    try {
      if (Services.prefs.getIntPref(prefName, 0) === 5) {
        return modFlag;
      }
    } catch {
      // Ignore missing pref
    }
  }
  return null;
}

const activeTouchpadPans = new WeakMap();

function resolveChromeContext(tab, browser) {
  const candidates = [
    ["tab.window", tab?.window],
    ["browser.documentGlobal", browser?.documentGlobal],
    ["browser.ownerGlobal", browser?.ownerGlobal],
  ];

  for (const [source, chromeWin] of candidates) {
    if (!chromeWin) continue;
    let chromeUtils = chromeWin.windowUtils || null;
    if (!chromeUtils && typeof chromeWin.QueryInterface === "function") {
      try {
        chromeUtils = chromeWin
          .QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIDOMWindowUtils);
      } catch {
        chromeUtils = null;
      }
    }
    if (chromeUtils) {
      return { chromeWin, chromeUtils, source };
    }
  }

  return { chromeWin: null, chromeUtils: null, source: null };
}

function computeTargetCoordinates(chromeWin, browser, screenX, screenY) {
  const chromeDpr = chromeWin.devicePixelRatio || 1;
  const rect = browser.getBoundingClientRect();
  const minDevX = Math.round((chromeWin.mozInnerScreenX + rect.left) * chromeDpr);
  const minDevY = Math.round((chromeWin.mozInnerScreenY + rect.top) * chromeDpr);
  const maxDevX = Math.max(
    minDevX,
    Math.round((chromeWin.mozInnerScreenX + rect.right) * chromeDpr) - 1
  );
  const maxDevY = Math.max(
    minDevY,
    Math.round((chromeWin.mozInnerScreenY + rect.bottom) * chromeDpr) - 1
  );

  let devX = Math.round((minDevX + maxDevX) / 2);
  let devY = Math.round((minDevY + maxDevY) / 2);
  if (Number.isFinite(screenX) && Number.isFinite(screenY)) {
    const padX = Math.min(2, Math.floor((maxDevX - minDevX) / 2));
    const padY = Math.min(2, Math.floor((maxDevY - minDevY) / 2));
    devX = Math.min(maxDevX - padX, Math.max(minDevX + padX, Math.round(screenX)));
    devY = Math.min(maxDevY - padY, Math.max(minDevY + padY, Math.round(screenY)));
  }

  const chromeClientX = devX / chromeDpr - chromeWin.mozInnerScreenX;
  const chromeClientY = devY / chromeDpr - chromeWin.mozInnerScreenY;

  return { devX, devY, chromeClientX, chromeClientY, chromeDpr };
}

function runChromeCallback(chromeWin, invoke) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok = true, error = null) => {
      if (settled) return;
      settled = true;
      resolve({ ok, error });
    };
    const timer = chromeWin.setTimeout(() => done(true), 100);

    try {
      invoke(() => {
        chromeWin.clearTimeout(timer);
        done(true);
      });
    } catch (err) {
      chromeWin.clearTimeout(timer);
      done(false, String(err));
    }
  });
}

function invokeTouchpadPanStep(chromeUtils, chromeWin, phaseInt, devX, devY, deltaX, deltaY) {
  return runChromeCallback(chromeWin, (onComplete) => {
    chromeUtils.sendNativeTouchpadPan(phaseInt, devX, devY, deltaX, deltaY, 0, onComplete);
  });
}

async function sendParentTouchpadPan({
  chromeWin,
  chromeUtils,
  chromeSource,
  browser,
  phase,
  screenX,
  screenY,
  screenDevDeltaX,
  screenDevDeltaY,
}) {
  if (typeof chromeUtils.sendNativeTouchpadPan !== "function") {
    return { ok: false, reason: "no-send-native-touchpad-pan", chromeSource };
  }

  const isLinux = Services.appinfo.OS === "Linux";
  const gtkDeltaMode = isLinux
    ? Services.prefs.getIntPref("apz.gtk.pangesture.delta_mode", 0)
    : 0;
  if (isLinux && gtkDeltaMode === 1) {
    return { ok: false, reason: "gtk-page-delta-mode", chromeSource };
  }

  const phaseBegin = chromeUtils.PHASE_BEGIN ?? 0;
  const phaseUpdate = chromeUtils.PHASE_UPDATE ?? 1;
  const phaseEnd = chromeUtils.PHASE_END ?? 2;
  const inProgress = !!activeTouchpadPans.get(chromeWin);

  if (phase === "end") {
    if (!inProgress) {
      return { ok: true, mode: "noop-end", chromeSource };
    }
    const coords = computeTargetCoordinates(chromeWin, browser, screenX, screenY);
    const stepRes = await invokeTouchpadPanStep(
      chromeUtils,
      chromeWin,
      phaseEnd,
      coords.devX,
      coords.devY,
      0,
      0
    );
    activeTouchpadPans.set(chromeWin, false);
    if (!stepRes.ok) {
      return { ok: false, reason: "touchpad-pan-end-threw", error: stepRes.error };
    }
    return {
      ok: true,
      mode: "native-touchpad-pan",
      phase: "end",
      chromeSource,
      screenX: coords.devX,
      screenY: coords.devY,
      panDeltaX: 0,
      panDeltaY: 0,
    };
  }

  const coords = computeTargetCoordinates(chromeWin, browser, screenX, screenY);

  if (phase === "begin" && inProgress) {
    await invokeTouchpadPanStep(
      chromeUtils,
      chromeWin,
      phaseEnd,
      coords.devX,
      coords.devY,
      0,
      0
    );
    activeTouchpadPans.set(chromeWin, false);
  }

  const currentlyOpen = !!activeTouchpadPans.get(chromeWin);
  const actualPhase = phase === "begin" || !currentlyOpen ? "begin" : "update";
  const phaseInt = actualPhase === "begin" ? phaseBegin : phaseUpdate;

  let panDeltaX = screenDevDeltaX;
  let panDeltaY = screenDevDeltaY;
  if (isLinux) {
    const pixelMult = Services.prefs.getFloatPref(
      "apz.gtk.pangesture.pixel_delta_mode_multiplier",
      40.0
    );
    const divisor = (pixelMult || 40.0) * coords.chromeDpr;
    panDeltaX = screenDevDeltaX / divisor;
    panDeltaY = screenDevDeltaY / divisor;
  }

  const stepRes = await invokeTouchpadPanStep(
    chromeUtils,
    chromeWin,
    phaseInt,
    coords.devX,
    coords.devY,
    panDeltaX,
    panDeltaY
  );
  if (!stepRes.ok) {
    activeTouchpadPans.set(chromeWin, false);
    return {
      ok: false,
      reason: "touchpad-pan-threw",
      error: stepRes.error,
      chromeSource,
    };
  }

  activeTouchpadPans.set(chromeWin, true);
  return {
    ok: true,
    mode: "native-touchpad-pan",
    phase: actualPhase,
    chromeSource,
    screenX: coords.devX,
    screenY: coords.devY,
    panDeltaX,
    panDeltaY,
  };
}

async function sendParentWheelAPZ({
  chromeWin,
  chromeUtils,
  chromeSource,
  browser,
  screenX,
  screenY,
  screenDevDeltaX,
  screenDevDeltaY,
}) {
  if (typeof chromeUtils.sendWheelEvent !== "function") {
    return { ok: false, reason: "no-parent-send-wheel-event", chromeSource };
  }

  const coords = computeTargetCoordinates(chromeWin, browser, screenX, screenY);
  const deltaModePixel = chromeWin.WheelEvent?.DOM_DELTA_PIXEL ?? 0;
  const flags =
    (chromeUtils.WHEEL_EVENT_ASYNC_ENABLED ?? 0x0008) |
    (chromeUtils.WHEEL_EVENT_CAUSED_BY_NO_LINE_OR_PAGE_DELTA_DEVICE ?? 0x0001);

  const stepRes = await runChromeCallback(chromeWin, (onComplete) => {
    chromeUtils.sendWheelEvent(
      coords.chromeClientX,
      coords.chromeClientY,
      screenDevDeltaX,
      screenDevDeltaY,
      0,
      deltaModePixel,
      0,
      0,
      0,
      flags,
      onComplete
    );
  });

  if (!stepRes.ok) {
    return {
      ok: false,
      reason: "parent-wheel-threw",
      error: stepRes.error,
      chromeSource,
    };
  }

  return {
    ok: true,
    mode: "parent-wheel-apz",
    chromeSource,
    screenX: coords.devX,
    screenY: coords.devY,
    chromeClientX: coords.chromeClientX,
    chromeClientY: coords.chromeClientY,
  };
}

function getTopActor(extension, tabId) {
  ensureActorRegistered(extension);
  const tab = extension.tabManager.get(tabId, null);
  const windowGlobal = tab?.browser?.browsingContext?.currentWindowGlobal;
  if (!windowGlobal) {
    console.warn("[AltPan Experiment] Missing windowGlobal for tabId:", tabId, "tab:", !!tab);
    return null;
  }
  return windowGlobal.getActor(ACTOR_NAME);
}

function unregisterActor() {
  try {
    ChromeUtils.unregisterWindowActor(ACTOR_NAME);
  } catch {
    // Ignore if already unregistered
  }

  try {
    getResProtoHandler().setSubstitution(RESOURCE_HOST, null);
  } catch {
    // Ignore
  }

  actorRegistered = false;
}

var altpan = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const { extension } = context;
    ensureActorRegistered(extension);

    return {
      altpan: {
        async getCapabilities() {
          return { available: true };
        },

        async panVisual({
          tabId,
          deltaX,
          deltaY,
          screenDeltaX,
          screenDeltaY,
          contentDpr = 1,
          phase = "update",
          screenX,
          screenY,
          forceVisual = false,
          debug = false,
        }) {
          try {
            ensureActorRegistered(extension);
            const tab = extension.tabManager.get(tabId, null);
            const browser = tab?.browser;
            const actor = browser?.browsingContext?.currentWindowGlobal?.getActor(ACTOR_NAME);

            const { chromeWin, chromeUtils, source: chromeSource } = resolveChromeContext(tab, browser);

            const scaleDpr = Number.isFinite(contentDpr) && contentDpr > 0 ? contentDpr : 1;
            const screenCssX = Number.isFinite(screenDeltaX) ? screenDeltaX : deltaX;
            const screenCssY = Number.isFinite(screenDeltaY) ? screenDeltaY : deltaY;
            const screenDevDeltaX = screenCssX * scaleDpr;
            const screenDevDeltaY = screenCssY * scaleDpr;

            let before = null;
            if (debug && actor) {
              before = await actor.sendQuery("AltPan:Snapshot", {});
            }

            if (chromeWin && chromeUtils && browser) {
              let parentRes = await sendParentTouchpadPan({
                chromeWin,
                chromeUtils,
                chromeSource,
                browser,
                phase,
                screenX,
                screenY,
                screenDevDeltaX,
                screenDevDeltaY,
              });

              if (!parentRes.ok && phase !== "end") {
                const wheelRes = await sendParentWheelAPZ({
                  chromeWin,
                  chromeUtils,
                  chromeSource,
                  browser,
                  screenX,
                  screenY,
                  screenDevDeltaX,
                  screenDevDeltaY,
                });
                if (wheelRes.ok) {
                  wheelRes.touchpadFallbackReason = parentRes.reason;
                  parentRes = wheelRes;
                }
              }

              if (parentRes.ok) {
                if (debug && actor && before) {
                  const after = await actor.sendQuery("AltPan:Snapshot", {});
                  return {
                    ...parentRes,
                    movedX: after.pageLeft - before.pageLeft,
                    movedY: after.pageTop - before.pageTop,
                    debug: {
                      topScale: after.topScale,
                      beforeX: before.pageLeft,
                      beforeY: before.pageTop,
                      afterX: after.pageLeft,
                      afterY: after.pageTop,
                      docOverflow: after.docOverflow,
                      screenDevDeltaX,
                      screenDevDeltaY,
                      chromeSource,
                      forceVisual,
                    },
                  };
                }

                return parentRes;
              }
            }

            if (phase === "end") {
              return { ok: true, mode: "noop-end" };
            }

            if (!actor) {
              return {
                ok: false,
                reason: "no-actor-or-chrome-utils",
                chromeSource,
                hasTab: !!tab,
                hasBrowser: !!browser,
              };
            }
            return await actor.sendQuery("AltPan:Pan", { deltaX, deltaY, debug });
          } catch (err) {
            console.error("[AltPan Experiment] panVisual failed:", err);
            return { ok: false, error: String(err) };
          }
        },

        async zoomVisual({ tabId, factor, deltaY = 0, deltaMode = 0, clientX, clientY, debug = false }) {
          try {
            const actor = getTopActor(extension, tabId);
            if (!actor) {
              return { ok: false, reason: "no-actor" };
            }
            const nativeZoomModifier = findNativePinchModifier();
            return await actor.sendQuery("AltPan:Zoom", {
              factor,
              deltaY,
              deltaMode,
              clientX,
              clientY,
              nativeZoomModifier,
              debug,
            });
          } catch (err) {
            console.error("[AltPan Experiment] zoomVisual failed:", err);
            return { ok: false, error: String(err) };
          }
        },
      },
    };
  }

  onShutdown(isAppShutdown) {
    if (isAppShutdown) {
      return;
    }
    unregisterActor();
  }
};

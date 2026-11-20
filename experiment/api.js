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

        async panVisual({ tabId, deltaX, deltaY }) {
          try {
            const actor = getTopActor(extension, tabId);
            if (!actor) {
              return { ok: false, reason: "no-actor" };
            }
            return await actor.sendQuery("AltPan:Pan", { deltaX, deltaY });
          } catch (err) {
            console.error("[AltPan Experiment] panVisual failed:", err);
            return { ok: false, error: String(err) };
          }
        },

        async zoomVisual({ tabId, factor, clientX, clientY }) {
          try {
            const actor = getTopActor(extension, tabId);
            if (!actor) {
              return { ok: false, reason: "no-actor" };
            }
            return await actor.sendQuery("AltPan:Zoom", {
              factor,
              clientX,
              clientY,
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

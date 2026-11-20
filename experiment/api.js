const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);

const ACTOR_NAME = "AltPan";
const RESOURCE_HOST = "altpan";

function getResProtoHandler() {
  return Services.io
    .getProtocolHandler("resource")
    .QueryInterface(Ci.nsIResProtocolHandler);
}

var altpan = class extends ExtensionCommon.ExtensionAPI {
  #registered = false;

  #ensureRegistered() {
    if (this.#registered) {
      return;
    }

    const resProto = getResProtoHandler();
    resProto.setSubstitutionWithFlags(
      RESOURCE_HOST,
      this.extension.rootURI,
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
    });

    this.#registered = true;
    console.info("[AltPan Experiment] Registered AltPan actor:", this.extension.rootURI.spec);
  }

  #getTopActor(extension, tabId) {
    this.#ensureRegistered();
    const tab = extension.tabManager.get(tabId, null);
    const windowGlobal = tab?.browser?.browsingContext?.currentWindowGlobal;
    if (!windowGlobal) {
      console.warn("[AltPan Experiment] Missing windowGlobal for tabId:", tabId, "tab:", !!tab);
      return null;
    }
    return windowGlobal.getActor(ACTOR_NAME);
  }

  getAPI(context) {
    const { extension } = context;
    this.#ensureRegistered();

    return {
      altpan: {
        async getCapabilities() {
          return { available: true };
        },

        async panVisual({ tabId, deltaX, deltaY }) {
          try {
            const actor = this.#getTopActor(extension, tabId);
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
            const actor = this.#getTopActor(extension, tabId);
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

    this.#registered = false;
  }
};

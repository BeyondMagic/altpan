const MIN_SCALE = 1.0;
const MAX_SCALE = 10.0;

export class AltPanChild extends JSWindowActorChild {
  receiveMessage(message) {
    const win = this.contentWindow;
    if (!win) {
      return { ok: false, reason: "no-window" };
    }

    const utils = win.windowUtils;
    const vv = win.visualViewport;
    if (!utils || !vv) {
      return { ok: false, reason: "no-utils" };
    }

    if (message.name === "AltPan:Pan") {
      const { deltaX, deltaY } = message.data;
      const beforeX = vv.pageLeft;
      const beforeY = vv.pageTop;

      utils.scrollToVisual(
        beforeX + deltaX,
        beforeY + deltaY,
        utils.UPDATE_TYPE_MAIN_THREAD,
        utils.SCROLL_MODE_INSTANT
      );

      return {
        ok: true,
        movedX: vv.pageLeft - beforeX,
        movedY: vv.pageTop - beforeY,
      };
    }

    if (message.name === "AltPan:Zoom") {
      const { factor, clientX, clientY } = message.data;
      const oldScale = vv.scale || 1.0;
      let newScale = Math.min(Math.max(oldScale * factor, MIN_SCALE), MAX_SCALE);

      // Snap cleanly back to 1.0 near minimum zoom to avoid residual sub-1% drift
      if (newScale < 1.005 && factor < 1.0) {
        newScale = 1.0;
      }

      if (Math.abs(newScale - oldScale) < 0.0005) {
        return { ok: true, scale: oldScale };
      }

      // Keep the document coordinate currently under (clientX, clientY) anchored
      const ratio = 1.0 - oldScale / newScale;
      const targetX = vv.pageLeft + clientX * ratio;
      const targetY = vv.pageTop + clientY * ratio;

      utils.setResolutionAndScaleTo(newScale);
      utils.scrollToVisual(
        targetX,
        targetY,
        utils.UPDATE_TYPE_MAIN_THREAD,
        utils.SCROLL_MODE_INSTANT
      );

      return { ok: true, scale: vv.scale };
    }

    return { ok: false, reason: "unknown-message" };
  }
}

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
      const x = vv.offsetLeft + vv.width / 2;
      const y = vv.offsetTop + vv.height / 2;
      const pixelOnlyFlag =
        utils.WHEEL_EVENT_CAUSED_BY_NO_LINE_OR_PAGE_DELTA_DEVICE ??
        utils.WHEEL_EVENT_CAUSED_BY_PIXEL_ONLY_DEVICE ??
        0;

      utils.sendWheelEvent(
        x,
        y,
        deltaX,
        deltaY,
        0,
        win.WheelEvent.DOM_DELTA_PIXEL,
        0,
        0,
        0,
        pixelOnlyFlag
      );

      return {
        ok: true,
        movedX: vv.pageLeft - beforeX,
        movedY: vv.pageTop - beforeY,
      };
    }

    if (message.name === "AltPan:Zoom") {
      const {
        factor,
        deltaY,
        deltaMode,
        clientX,
        clientY,
        nativeZoomModifier,
      } = message.data;

      // Primary path: delegate to Firefox's native APZ compositor zoom via sendWheelEvent
      // using whichever modifier has mousewheel.with_*.action === 5 in about:config.
      if (nativeZoomModifier !== null && nativeZoomModifier !== undefined && deltaY) {
        const lineDeltaY = deltaMode === 1 ? Math.sign(deltaY) : 0;
        const options = utils.WHEEL_EVENT_CUSTOMIZED_BY_USER_PREFS ?? 0;

        utils.sendWheelEvent(
          clientX,
          clientY,
          0,
          deltaY,
          0,
          deltaMode,
          nativeZoomModifier,
          0,
          lineDeltaY,
          options
        );

        return { ok: true, mode: "native-apz", scale: vv.scale };
      }

      // Fallback when no mousewheel.*.action is set to 5
      const oldScale = vv.scale || 1.0;
      let newScale = Math.min(Math.max(oldScale * factor, MIN_SCALE), MAX_SCALE);

      if (newScale < 1.002 && factor < 1.0) {
        newScale = 1.0;
      }

      if (Math.abs(newScale - oldScale) < 0.0005) {
        return { ok: true, scale: oldScale };
      }

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

      return { ok: true, mode: "fallback", scale: vv.scale };
    }

    return { ok: false, reason: "unknown-message" };
  }
}

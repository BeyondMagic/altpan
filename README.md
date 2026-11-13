<p align="center">
  <a href="https://github.com/BeyondMagic/altpan">
    <img alt="AltPan Logo" src="icons/icon-128.png" width="96">
  </a>
</p>

<h1 align="center">AltPan</h1>

<p align="center">
  <strong>
    A Firefox WebExtension (Manifest V3) for smooth, 1:1 "Hand Tool" drag-to-pan scrolling across zoomed viewports.
  </strong>
</p>

<p align="center">
  <a href="https://github.com/BeyondMagic/altpan/blob/master/LICENSE"><img
    src="https://img.shields.io/badge/License-LGPLv3-blue.svg"
    alt="License: LGPLv3"
  /></a>
  <img
    src="https://img.shields.io/badge/Firefox-Manifest%20V3-orange.svg"
    alt="Firefox Manifest V3"
  />
  <img
    src="https://img.shields.io/badge/Platform-Linux%20%7C%20uinput-brightgreen.svg"
    alt="Platform: Linux uinput"
  />
</p>

<p align="center">
  <strong>1:1 Hand Tool Pan</strong>
  &middot;
  <strong>APZ Pinch-Zoom Engine</strong>
  &middot;
  <strong>Linux /dev/uinput Bridge</strong>
  &middot;
  <strong>Kinetic Momentum</strong>
  &middot;
  <strong>Zero Event Conflicts</strong>
  &middot;
  <strong>Configurable Sensitivity</strong>
</p>

## Purpose

When pinch-zooming into a webpage in Firefox using a trackpad or touchscreen, Firefox's compositor zooms the **Visual Viewport** independently of document layout. The underlying DOM **Layout Viewport** remains constrained to window boundaries (`scrollWidth == clientWidth`).

Because traditional JavaScript scrolling (`window.scrollBy`) operates strictly on the layout viewport, horizontal panning is mathematically clamped to `0`, and standard DOM APIs offer no setter for the read-only `visualViewport.offsetLeft`.

**AltPan** solves this by providing a universal, tactile 1:1 "Hand Tool" drag-to-pan gesture (Middle-Click Drag by default) that moves the canvas under your cursor identically to physical touch input on touchscreens and precision touchpads.

## Technical Architecture

AltPan implements a dynamic dual-mode architecture that routes gestures based on the current zoom state:

```
[User Action: Middle Click Drag]
               │
               ▼
   Is visualViewport.scale > 1.05?
          │                │
         YES               NO
          │                │
          ▼                ▼
   [Native Bridge]   [DOM / Container]
          │                │
   High-Res Wheel     Smart scrollBy
   (uinput via IPC)   (0ms main thread)
          │                │
          ▼                ▼
   Firefox APZ Pan   Layout Scrolled
```

- **Standard Zoom (`scale <= 1.05`):** Panning executes directly in the content script via `scrollBy` on the nearest scrollable ancestor container (code block, table, editor) or window with zero IPC latency.
- **Pinch-Zoomed Viewport (`scale > 1.05`):** Content script coalesces drag deltas per display refresh frame (`requestAnimationFrame`) and forwards them to a local Python companion (`altpan_host.py`) via the standard WebExtension Native Messaging API. The host synthesizes genuine high-resolution wheel ticks via Linux `/dev/uinput` (`REL_HWHEEL_HI_RES` / `REL_WHEEL_HI_RES`), directly driving Firefox's native Asynchronous Pan/Zoom (APZ) compositor across both axes.
- **Why Not `browser.debugger`?** Unlike Chromium, Firefox WebExtensions do not implement the `debugger` API (`browser.debugger` is undefined). Native messaging via `/dev/uinput` is the only supported, secure, and banner-free path to inject compositor-grade input.

## Installation

AltPan consists of two components: the **Native Messaging Companion** (for APZ pinch-zoom panning) and the **Firefox WebExtension**.

### Step 1: Install the Native Companion (Linux)

Clone the repository and run the installer script:

```bash
git clone https://github.com/BeyondMagic/altpan.git
cd altpan
./install_host.sh
```

This registers the native messaging manifest in `~/.mozilla/native-messaging-hosts/` and `~/.config/mozilla/native-messaging-hosts/`, and ensures `native/altpan_host.py` has executable permissions.

> [!NOTE]
> The companion uses Linux `/dev/uinput` via Python's `evdev` module. If your user account does not have write access to `/dev/uinput`, run:
> ```bash
> sudo usermod -aG input $USER
> ```
> Then log out and log back in for group membership to take effect.

### Step 2: Install the WebExtension in Firefox

Choose one of the following methods:

#### Option A: Permanent Installation (Recommended)

1. Copy the pre-built `altpan.xpi` directly into your active Firefox profile's `extensions/` folder:
   ```bash
   cp altpan.xpi ~/.config/mozilla/firefox/<your-profile>/extensions/altpan@terra.local.xpi
   ```
2. Alternatively, open Firefox, go to `about:addons`, click the gear icon (⚙️), select **Install Add-on From File...**, and choose `altpan.xpi`.

#### Option B: Developer Mode (Temporary)

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` from the cloned repository folder.

## Configuration

Click the AltPan toolbar icon to open the configuration popup:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Enable AltPan** | `true` | Globally toggles the drag-to-pan extension on or off. |
| **APZ Native Bridge** | Live Status | Displays live connection status to the `/dev/uinput` host. |
| **Modifier Key** | `None` | Key held during drag: `None (Middle Click Only)`, `Alt`, `Shift`, `Ctrl`, or `Meta`. |
| **Sensitivity** | `0.5x` | Drag speed multiplier (slider range: `0.2x` to `2.5x`). |
| **Kinetic Momentum** | `Enabled` | Enables smooth exponential coasting upon gesture release. |
| **Coast Duration** | `Normal` (`0.92`) | Controls friction decay (`Crisp`: `0.88`, `Normal`: `0.92`, `Floaty`: `0.96`). |
| **Excluded Domains** | `figma.com`, `miro.com`, `maps.google.com` | Hostnames where AltPan is automatically suppressed, with a **+ Current Site** shortcut. |

___

# License

This project is licensed under [LGPLv3](./LICENSE).

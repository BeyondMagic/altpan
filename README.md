<p align="center">
  <a href="https://github.com/BeyondMagic/altpan">
    <img alt="AltPan Logo" src="icons/icon-128.png" width="96">
  </a>
</p>

<h1 align="center">AltPan</h1>

<p align="center">
  <strong>
    A Firefox extension for middle-click drag panning across zoomed pages and viewports.
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
  <strong>1:1 Hand-Tool Pan</strong>
  &middot;
  <strong>Pinch-Zoom Support</strong>
  &middot;
  <strong>Linux uinput Bridge</strong>
  &middot;
  <strong>Kinetic Momentum</strong>
  &middot;
  <strong>Container Scrolling</strong>
  &middot;
  <strong>Domain Blacklist</strong>
</p>

## Purpose

If you pinch-zoom into a page in Firefox and try to pan around with a regular mouse, you quickly hit a wall. Standard autoscroll or `window.scrollBy` calls only move the DOM layout viewport. When a page doesn't overflow horizontally (`scrollWidth == clientWidth`), horizontal scrolling stays stuck at `0`, and `visualViewport.offsetLeft` is read-only.

AltPan gives you a hand-tool drag gesture (middle-click drag by default) that pans both axes at 1:1 speed, even while pinch-zoomed.

## Technical Architecture

AltPan picks between DOM scrolling and a native input helper depending on your current zoom level:

```mermaid
%%{init: {"flowchart": {"curve": "basis", "nodeSpacing": 36, "rankSpacing": 56, "padding": 18, "subGraphTitleMargin": {"top": 14, "bottom": 14}}}}%%
flowchart TD
    Act(["🖱️ User action<br/>middle-button drag"])

    Dec{"visualViewport.scale<br/>&gt; 1.05 ?"}

    subgraph native["Native path"]
        direction TB
        Bridge["Native Bridge<br/><i>IPC</i>"]
        Wheel["High-resolution wheel<br/><small>uinput via IPC</small>"]
        APZ["Firefox APZ Pan<br/><small>compositor thread</small>"]
        Bridge --> Wheel --> APZ
    end

    subgraph dom["DOM path"]
        direction TB
        Container["DOM / Container"]
        ScrollBy["scrollBy()<br/><small>main thread</small>"]
        Layout["Layout Scrolled<br/><small>repaint</small>"]
        Container --> ScrollBy --> Layout
    end

    Act --> Dec
    Dec -->|"YES"| Bridge
    Dec -->|"NO"| Container

    classDef trigger fill:#E3F2FD,stroke:#1565C0,stroke-width:2px,color:#0D47A1;
    classDef decision fill:#FFF8E1,stroke:#F9A825,stroke-width:2px,color:#7A4F00;
    classDef nativeNode fill:#E8F5E9,stroke:#2E7D32,stroke-width:2px,color:#1B5E20;
    classDef domNode fill:#E7F0FA,stroke:#1E6BB8,stroke-width:2px,color:#10395E;
    classDef outcomeN fill:#2E7D32,stroke:#1B5E20,stroke-width:3px,color:#FFFFFF;
    classDef outcomeD fill:#1E6BB8,stroke:#10395E,stroke-width:3px,color:#FFFFFF;

    class Act trigger;
    class Dec decision;
    class Bridge,Wheel nativeNode;
    class Container,ScrollBy domNode;
    class APZ outcomeN;
    class Layout outcomeD;

    style native fill:#F4FBF5,stroke:#66BB6A,stroke-width:2px;
    style dom fill:#F5F9FD,stroke:#7FA9D4,stroke-width:2px;
```

At normal zoom (`scale <= 1.05`), `content.js` scrolls the nearest scrollable parent container (like a code block or wide table) or falls back to `window.scrollBy`.

When pinch-zoomed (`scale > 1.05`), `content.js` batches mouse deltas on each `requestAnimationFrame` and sends them to `native/altpan_host.py` over Firefox's Native Messaging API. The Python helper writes high-resolution wheel events (`REL_HWHEEL_HI_RES` and `REL_WHEEL_HI_RES`) to `/dev/uinput`, which feeds directly into Firefox's Asynchronous Pan/Zoom (APZ) compositor. Firefox doesn't implement `browser.debugger`, so this local uinput bridge is how AltPan gets around the read-only visual viewport.

## Installation

You need both the Firefox extension and the Linux native helper (the helper is only needed if you want pinch-zoom panning).

### Step 1: Install the native helper (Linux)

Clone the repository and run the installer script:

```bash
git clone https://github.com/BeyondMagic/altpan.git
cd altpan
./install_host.sh
```

This writes the native host manifest to `~/.mozilla/native-messaging-hosts/` and `~/.config/mozilla/native-messaging-hosts/`, and marks `native/altpan_host.py` executable.

> [!NOTE]
> The helper writes to `/dev/uinput` using Python's `evdev` package. If your user account can't open `/dev/uinput`, add yourself to the `input` group and log back in:
> ```bash
> sudo usermod -aG input $USER
> ```

### Step 2: Install the extension in Firefox

#### Option 1: Permanent install

Copy `altpan.xpi` into your Firefox profile's `extensions/` directory:

```bash
cp altpan.xpi ~/.config/mozilla/firefox/<your-profile>/extensions/altpan@terra.local.xpi
```

You can also open `about:addons`, click the gear icon, pick "Install Add-on From File...", and select `altpan.xpi`.

#### Option 2: Temporary install (developer mode)

Open `about:debugging#/runtime/this-firefox`, click "Load Temporary Add-on...", and pick `manifest.json` from the repository folder.

## Configuration

Click the AltPan icon in your toolbar to change any setting:

| Setting | Default | Description |
| :--- | :--- | :--- |
| Enable AltPan | `true` | Turns AltPan on or off globally. |
| APZ Native Bridge | Live Status | Shows whether the `/dev/uinput` helper is connected. |
| Modifier Key | `None` | Key held during drag: `None` (middle-click only), `Alt`, `Shift`, `Ctrl`, or `Meta`. |
| Sensitivity | `0.5x` | Drag speed multiplier (from `0.2x` to `2.5x`). |
| Kinetic Momentum | `Enabled` | Keeps scrolling briefly after you let go of the mouse button. |
| Coast Duration | `Normal` (`0.92`) | How fast momentum slows down (`Crisp`: `0.88`, `Normal`: `0.92`, `Floaty`: `0.96`). |
| Excluded Domains | `figma.com`, `miro.com`, `maps.google.com` | Sites where AltPan stays out of the way (plus a "+ Current Site" button). |

___

# License

This project is licensed under [LGPLv3](./LICENSE).

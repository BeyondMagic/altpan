<p align="center">
  <a href="https://github.com/BeyondMagic/altpan">
    <img alt="AltPan Logo" src="icons/icon-128.png" width="96">
  </a>
</p>

<h1 align="center">AltPan</h1>

<p align="center">
  <strong>
    A Firefox extension for middle-click drag panning and cursor-centered pinch-zoom across webpages.
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
    src="https://img.shields.io/badge/Requires-Firefox%20Nightly%20%2F%20Dev-brightgreen.svg"
    alt="Requires Firefox Nightly or Developer Edition"
  />
</p>

<p align="center">
  <strong>1:1 Hand-Tool Pan</strong>
  &middot;
  <strong>Pinch-Zoom Support</strong>
  &middot;
  <strong>No Native Daemon</strong>
  &middot;
  <strong>Kinetic Momentum</strong>
  &middot;
  <strong>Container Scrolling</strong>
  &middot;
  <strong>Domain Blacklist</strong>
</p>

## Purpose

Firefox supports pinch-zooming into a page, but panning around while zoomed in with a regular mouse does not work well. Standard autoscroll and `window.scrollBy` calls move only the page layout, so horizontal panning stops once the page fits within the window width.

AltPan provides a hand-tool drag gesture (middle-click drag by default) that moves the page on both axes at 1:1 speed while zoomed in, without requiring an external helper application or OS-level input bridge.

## Technical Architecture

AltPan runs as a self-contained Firefox WebExtension with a lightweight built-in Experiment API:

```mermaid
%%{init: {"flowchart": {"curve": "basis", "nodeSpacing": 36, "rankSpacing": 56, "padding": 18, "subGraphTitleMargin": {"top": 14, "bottom": 14}}}}%%
flowchart TD
    Act(["middle-button drag / wheel zoom"])

    Dec{"Inner scrollable<br/>container?"}

    subgraph content["Content process · JavaScript"]
        direction TB
        ScrollBy["element.scrollBy()<br/><small>scrolls the inner element</small>"]
        Altpan["browser.altpan experiment<br/><small>no inner scroller found</small>"]
        IPC["JSWindowActor IPC<br/><small>message to the parent process</small>"]
        Altpan --> IPC
    end

    subgraph parent["Parent process · privileged API"]
        direction TB
        Utils["nsIDOMWindowUtils"]
        Visual["scrollToVisual()<br/><small>visual viewport pan</small>"]
        Scale["setResolutionAndScaleTo()<br/><small>zoom / resolution</small>"]
        Utils --> Visual
        Utils --> Scale
    end

    Act --> Dec
    Dec -->|"YES"| ScrollBy
    Dec -->|"NO"| Altpan
    IPC --> Utils

    classDef trigger fill:#E3F2FD,stroke:#1565C0,stroke-width:2px,color:#0D47A1;
    classDef decision fill:#FFF8E1,stroke:#F9A825,stroke-width:2px,color:#7A4F00;
    classDef jsNode fill:#E7F0FA,stroke:#1E6BB8,stroke-width:2px,color:#10395E;
    classDef ipcNode fill:#EDE7F6,stroke:#5E35B1,stroke-width:2px,color:#311B92;
    classDef privileged fill:#E8F5E9,stroke:#2E7D32,stroke-width:2px,color:#1B5E20;
    classDef endJs fill:#1E6BB8,stroke:#10395E,stroke-width:3px,color:#FFFFFF;
    classDef endPriv fill:#2E7D32,stroke:#1B5E20,stroke-width:3px,color:#FFFFFF;

    class Act trigger;
    class Dec decision;
    class Altpan jsNode;
    class IPC ipcNode;
    class Utils privileged;
    class ScrollBy endJs;
    class Visual,Scale endPriv;

    style content fill:#F5F9FD,stroke:#7FA9D4,stroke-width:2px;
    style parent fill:#F4FBF5,stroke:#66BB6A,stroke-width:2px;
```

## Installation

Because AltPan uses `experiment_apis` for direct visual-viewport control, it requires **Firefox Nightly** or **Firefox Developer Edition** (standard Release Firefox rejects unsigned/custom WebExtension Experiments).

### Step 1: Enable Experiment APIs in Firefox

1. Open `about:config`.
2. Set `extensions.experiments.enabled` to `true`.
3. If installing the `.xpi` permanently outside temporary debugging, also set `xpinstall.signatures.required` to `false`.

### Step 2: Install the extension

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
| APZ Visual Viewport API | Live Status | Shows whether `browser.altpan` is active in Firefox. |
| Pan Modifier Key | `None` | Key held during drag: `None` (middle-click only), `Alt`, `Shift`, `Ctrl`, or `Meta`. |
| Pinch-Zoom Wheel | `Off` | Optional modifier+wheel zoom (`Off` keeps your native `about:config` mousewheel zoom untouched). |
| Sensitivity | `0.5x` | Drag speed multiplier (from `0.2x` to `2.5x`). |
| Kinetic Momentum | `Enabled` | Keeps scrolling briefly after you let go of the mouse button. |
| Coast Duration | `Normal` (`0.92`) | How fast momentum slows down (`Crisp`: `0.88`, `Normal`: `0.92`, `Floaty`: `0.96`). |
| Excluded Domains | `figma.com`, `miro.com`, `maps.google.com` | Sites where AltPan stays out of the way (plus a "+ Current Site" button). |
| Force Visual Pan | `false` | Routes drags via parent APZ widget (`sendNativeMouseScrollEvent`), independent of container scrollability. |
| Debug Logging | `false` | Logs frame, container, and scroll details to the webpage DevTools Console. |

___

# License

This project is licensed under [LGPLv3](./LICENSE).

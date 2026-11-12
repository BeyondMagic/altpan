# AltPan 🖐️

**AltPan** is a Firefox WebExtension (Manifest V3) that enables smooth, 1:1 "Hand Tool" drag-to-pan scrolling for zoomed webpages and viewports. By holding the `Alt` key and dragging with the middle mouse button, you can pan across any page with the responsiveness and tactile feel of a touchscreen or precision trackpad.

---

## ✨ Features

- **1:1 Tactile Hand Tool:** Moves the webpage canvas directly under your cursor (pinning the dragged point to the mouse pointer).
- **APZ Pinch-Zoom & Visual Viewport Support:** Emits high-resolution hardware wheel events via a Native Messaging companion (`/dev/uinput`) when pinch-zoomed, directly driving Firefox's native Asynchronous Pan/Zoom (APZ) compositor across both X and Y axes.
- **Smart Container & DOM Scrolling:** At standard zoom levels, intelligently detects scrollable code blocks, wide tables, SPAs, and windows for instant zero-latency scrolling.
- **Smooth Kinetic Momentum (Inertia):** Releasing a flick gesture triggers a smooth exponential coasting decay (`requestAnimationFrame`) that brings the viewport to a gentle rest.
- **Zero Native Browser Conflicts:** Suppresses Firefox's built-in auto-scroll compass, link-clicks in background tabs, and Linux X11 middle-click primary selection paste.
- **Visual Feedback:** Temporarily sets a global `grabbing` cursor and suppresses text selection while actively dragging.
- **Configurable Settings Popup:**
  - Live **APZ Native Bridge** status indicator (`Connected` / `Offline`).
  - Global enable/disable toggle.
  - Modifier key selector (`Alt`, `Shift`, `Ctrl`, or `Meta / Command`).
  - Drag sensitivity slider (`0.5x` to `2.5x`).
  - Momentum toggle and coast duration slider (Crisp / Normal / Floaty).
  - Excluded domains list with a one-click "+ Current Site" button (e.g. Figma, Miro, Google Maps).

---

## 🏗️ Technical Architecture & Why Native Messaging?

### The Pinch-Zoom / Visual Viewport Challenge

When pinch-zooming on a trackpad or touchscreen in Firefox:
1. Firefox's compositor zooms the **Visual Viewport** independently of the document layout.
2. The underlying DOM **Layout Viewport** remains constrained to the window width (`scrollWidth == clientWidth`).
3. Standard DOM APIs like `window.scrollBy({ left: ... })` operate strictly on the **Layout Viewport**. Because the layout has zero horizontal overflow, Firefox's layout engine mathematically clamps horizontal scrolling to `0`!
4. The visual viewport position (`visualViewport.offsetLeft`) is strictly **read-only** in browser standards, with no JavaScript setter.

### Why Not the `debugger` API?

Certain Chromium tools rely on `chrome.debugger` to synthesize CDP wheel events. However:
- **Mozilla has never implemented `browser.debugger` or `chrome.debugger` for Firefox extensions.**
- Calling `browser.debugger` in Firefox throws an immediate runtime `TypeError: browser.debugger is undefined`.

### The Solution: Dual-Mode Dynamic Architecture

AltPan implements a clean, high-performance dual-mode architecture:

```
[User Action: Alt + Middle Drag]
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

1. **Standard Zoom (`scale <= 1.05`):** Panning operates directly inside `content.js` via `scrollBy` on the target container or window with zero IPC latency.
2. **Pinch-Zoomed Viewport (`scale > 1.05`):** Content script forwards 2D drag deltas to `native/altpan_host.py` via Firefox's standard Native Messaging API. The host emits genuine Linux `/dev/uinput` high-resolution wheel events (`REL_HWHEEL_HI_RES` / `REL_WHEEL_HI_RES`), driving Firefox's native APZ compositor engine exactly like a physical hardware trackpad.

---

## 📂 Project Structure

```
AltPan/
├── manifest.json            # Firefox Manifest V3 configuration (with nativeMessaging)
├── background.js            # Background script for native port routing & badge state
├── content.js               # Core drag-to-pan engine, container detection & APZ dispatcher
├── install_host.sh          # One-click native companion installer (registers manifest)
├── uninstall_host.sh        # Uninstalls the native companion manifest
├── native/
│   └── altpan_host.py       # Linux uinput high-resolution wheel bridge (Python 3 + evdev)
├── popup/
│   ├── popup.html           # Toolbar settings UI with live Native Bridge indicator
│   ├── popup.css            # Responsive, dark-mode-ready styling
│   └── popup.js             # Settings controller and live synchronization
├── icons/
│   └── icon-*.png           # High-resolution extension icons
└── README.md                # Documentation & installation guide
```

---

## 🚀 Installation Guide

### Step 1: Install the Native Companion (For Pinch-Zoom Support)

Run the included installer script in your terminal:

```bash
cd /home/terra/storage/desktop/projects/AltPan
./install_host.sh
```

This registers `altpan_host.json` inside `~/.mozilla/native-messaging-hosts/` and ensures `native/altpan_host.py` is executable.

> [!NOTE]
> The native host uses Linux `/dev/uinput` via Python's `evdev` module. If your user account does not have write access to `/dev/uinput`, you can grant permissions with:
> `sudo usermod -aG input $USER`

### Step 2: Load the Extension in Firefox

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Select `manifest.json` inside `/home/terra/storage/desktop/projects/AltPan/`.
4. Open the AltPan toolbar icon. You will see 🟢 **APZ Native Bridge: Connected**.
5. Pinch-to-zoom on any page with your trackpad or touchscreen, hold `Alt`, and drag with the middle mouse button to pan in any direction!

---

## ⚙️ Configuration & Options

Click the AltPan toolbar icon to customize:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Enable AltPan** | `true` | Globally toggles the extension on or off. |
| **APZ Native Bridge** | Live Status | Shows whether the native uinput bridge is connected. |
| **Modifier Key** | `Alt` | Choose between `Alt`, `Shift`, `Ctrl`, or `Meta / Command`. |
| **Sensitivity** | `1.0x` | Multiplier for drag speed (range `0.5x` to `2.5x`). |
| **Kinetic Momentum** | `Enabled` | Toggles kinetic coasting on release. |
| **Coast Duration** | `Normal` (`0.92`) | Controls friction decay (Crisp: `0.88`, Normal: `0.92`, Floaty: `0.96`). |
| **Excluded Domains** | `figma.com`, `miro.com`, `maps.google.com` | List of sites where AltPan is automatically disabled. |

---

## 🛡️ License

MIT License.

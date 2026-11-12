# AltPan 🖐️

**AltPan** is a Firefox WebExtension (Manifest V3) that enables smooth, 1:1 "Hand Tool" drag-to-pan scrolling for zoomed webpages and viewports. By holding the `Alt` key and dragging with the middle mouse button, you can pan across any page with the responsiveness and tactile feel of a touchscreen or trackpad.

---

## ✨ Features

- **1:1 Tactile Hand Tool:** Moves the webpage canvas directly under your cursor (pinning the dragged point to the mouse pointer).
- **Zoom & Viewport Compensation:** Automatically scales coordinate deltas with `window.visualViewport.scale` so drag distances stay physically accurate during APZ Pinch-to-Zoom and Full-Page Zoom.
- **Smooth Kinetic Momentum (Inertia):** Releasing a flick gesture triggers a smooth exponential coasting decay (`requestAnimationFrame`) that brings the viewport to a gentle rest.
- **Zero Native Browser Conflicts:** Suppresses Firefox's built-in auto-scroll compass, link-clicks in background tabs, and Linux X11 middle-click primary selection paste.
- **Visual Feedback:** Temporarily sets a global `grabbing` cursor and suppresses text selection while actively dragging.
- **Instant Interruptibility:** Any subsequent keypress, click, or wheel tick immediately halts kinetic momentum with zero floatiness.
- **Configurable Settings Popup:**
  - Global enable/disable toggle.
  - Modifier key selector (`Alt`, `Shift`, `Ctrl`, or `Meta / Command`).
  - Drag sensitivity slider (`0.5x` to `2.5x`).
  - Momentum toggle and coast duration slider (Crisp / Normal / Floaty).
  - Excluded domains list with a one-click "+ Current Site" button for apps with built-in middle-drag tools (e.g. Figma, Miro, Google Maps).

---

## 🏗️ Technical Architecture & Rationale

### Why Direct DOM Scrolling instead of the `debugger` API?

In the initial exploratory design, using `browser.debugger` to send Chrome DevTools Protocol (CDP) `Input.dispatchMouseEvent` commands was considered in order to produce synthetic events marked `isTrusted: true`. However, during architectural evaluation, two blockers were identified:

1. **Firefox Compatibility:** Mozilla does not implement the `chrome.debugger` or `browser.debugger` WebExtensions API. Firefox extensions requesting `"debugger"` will fail to load or be rejected by the add-on manifest parser.
2. **UX & Performance:** CDP commands introduce IPC latency between the extension background script and the browser rendering pipeline, and CDP attachment triggers a prominent, persistent warning banner ("Firefox is being debugged").

### The Solution: High-Performance Content Script DOM Scrolling

AltPan implements pure client-side viewport manipulation directly within `content.js`:

```javascript
// Scale compensation for APZ pinch-zoom and visual viewports
const scale = window.visualViewport?.scale || 1.0;
const scrollX = - (dx / scale) * sensitivity;
const scrollY = - (dy / scale) * sensitivity;

window.scrollBy({
  left: scrollX,
  top: scrollY,
  behavior: "instant"
});
```

- **`behavior: "instant"`:** Bypasses any CSS smooth scrolling (`scroll-behavior: smooth`) on the target page, ensuring 120fps/60fps direct physical coupling between the cursor and the rendered page.
- **Zoom Factor ($\Delta \text{scroll} = - \frac{\Delta \text{mouse}}{\text{scale}}$):** When pinch-zoomed at $2\times$, 1 CSS pixel occupies 2 physical screen pixels. Dividing mouse movement by the visual viewport scale guarantees that the pixel under your cursor never slips.

### Kinetic Momentum Algorithm

1. During `mousemove`, a rolling buffer of recent position and timestamp delta samples is maintained over a 90ms window.
2. When the middle mouse button or modifier key is released, AltPan calculates the velocity vector $(v_x, v_y)$ in pixels per frame (~16.67ms).
3. If velocity exceeds the minimum threshold ($1.2\text{ px/frame}$), an animation loop runs using exponential decay:
   $$v_{t+1} = v_t \times \text{friction}$$
4. The animation halts automatically when speed drops below $0.25\text{ px/frame}$ or immediately upon any new user input event (`pointerdown`, `wheel`, `keydown`, `touchstart`).

---

## 📂 Project Structure

```
AltPan/
├── manifest.json        # Firefox Manifest V3 configuration
├── background.js        # Background script for settings initialization & badge state
├── content.js           # Core drag-to-pan engine, zoom compensation & momentum physics
├── popup/
│   ├── popup.html       # Toolbar settings UI
│   ├── popup.css        # Responsive, dark-mode-ready styling
│   └── popup.js         # Settings controller and live synchronization
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   ├── icon-96.png
│   └── icon-128.png
└── README.md            # Technical documentation & usage instructions
```

---

## 🚀 Installation & Testing in Firefox

### Method 1: Temporary Installation (Developer Mode)

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...**.
3. Browse to this directory (`/home/terra/storage/desktop/projects/AltPan/`) and select `manifest.json`.
4. The AltPan icon will appear in your Firefox toolbar.
5. Open any webpage (e.g. Wikipedia or GitHub), zoom in (`Ctrl` + `+` or trackpad pinch), hold `Alt`, and drag with the middle mouse button!

### Method 2: Testing with `web-ext` CLI

If you have `web-ext` installed (via `npm install -g web-ext`):

```bash
cd /home/terra/storage/desktop/projects/AltPan
web-ext run
```

This launches a clean, temporary Firefox instance with AltPan pre-loaded.

---

## ⚙️ Configuration & Options

Click the AltPan toolbar icon to customize:

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Enable AltPan** | `true` | Globally toggles the extension on or off. |
| **Modifier Key** | `Alt` | Choose between `Alt`, `Shift`, `Ctrl`, or `Meta / Command`. |
| **Sensitivity** | `1.0x` | Multiplier for drag speed (range `0.5x` to `2.5x`). |
| **Kinetic Momentum** | `Enabled` | Toggles kinetic coasting on release. |
| **Coast Duration** | `Normal` (`0.92`) | Controls friction decay (Crisp: `0.88`, Normal: `0.92`, Floaty: `0.96`). |
| **Excluded Domains** | `figma.com`, `miro.com`, `maps.google.com` | List of sites where AltPan is automatically disabled. |

---

## 🛡️ License

MIT License. Feel free to modify and adapt for personal or public distribution.

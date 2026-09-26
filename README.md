# Poll Assist for PW Live

**A Manifest V3 Chrome extension that intercepts a live-class WebSocket feed to detect polls in real time and auto-submit a pre-armed answer — built without frameworks, build tools, or third-party dependencies.**

[![License: MIT](https://img.shields.io/badge/license-MIT-4caf50.svg)](./LICENSE)
[![Manifest V3](https://img.shields.io/badge/manifest-v3-blue.svg)](https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3)
[![Platform: Chrome](https://img.shields.io/badge/platform-Chrome-yellow.svg)](https://www.google.com/chrome/)
[![Dependencies: none](https://img.shields.io/badge/dependencies-none-success.svg)](#tech-stack--architecture)
[![Status: personal project](https://img.shields.io/badge/status-personal%20project-lightgrey.svg)](#)

> **Unofficial project.** Not affiliated with, endorsed by, or connected to Physics Wallah or PW.live. Built by inspecting the site's own public-facing markup and WebSocket traffic — no private API or reverse-engineered backend access is used, and it may break whenever PW.live changes their frontend.

---

## Why this project is worth a look

This started as a small personal utility, but the engineering problem underneath it is a genuinely interesting one: **detect an asynchronous, third-party UI event (a poll opening on someone else's website) as close to zero-latency as possible, without an official API, without polling, and without breaking the host page.** A few of the decisions that came out of solving that:

- **Event-driven over polling.** Instead of watching the DOM on a timer, the extension hooks the page's native `WebSocket` constructor at `document_start` (before the site's own scripts run) and listens for the platform's real `poll_start` / `stop_expiry` protocol frames — turning a guessing game into a deterministic trigger.
- **Defense in depth.** A `MutationObserver`-based DOM fallback exists for the rare case the WebSocket signal is missed, so the feature degrades gracefully instead of failing silently.
- **Correctness under concurrency.** The changelog documents real race conditions found and fixed during development — e.g. a stale-DOM-node check that could silently swallow a new poll's auto-open if the previous poll's container hadn't yet been removed, and a poll re-detection bug where an answered poll re-rendered by the site's framework could be mistaken for a brand-new one. Both are fixed with identity-based tracking (`pollId`) rather than DOM-shape heuristics.
- **Zero build step, zero dependencies.** Every file in this repo is exactly what runs in the browser — no bundler, no transpiler, no npm install. That's a deliberate constraint, not an oversight: it keeps the entire trust boundary auditable in a single read-through (see [Privacy & security](#privacy--security)).
- **Privacy by architecture, not by policy.** The extension makes zero network requests of its own — there is no `fetch` or `XMLHttpRequest` anywhere in the codebase — and the one thing it does read from the page (a WebSocket URL containing a session token) is redacted before it's used for anything, including debug logs.

If you're skimming this as a recruiter or reviewer: the parts worth reading are [How it works internally](#how-it-works-internally) and the [Changelog](#changelog), which together show the debugging and design trail, not just the finished feature.

## Table of contents

- [Why this project is worth a look](#why-this-project-is-worth-a-look)
- [Features](#features)
- [Tech stack & architecture](#tech-stack--architecture)
- [Installation](#installation)
- [Usage](#usage)
- [Settings](#settings)
- [How it works internally](#how-it-works-internally)
- [Privacy & security](#privacy--security)
- [Responsible use](#responsible-use)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [Changelog](#changelog)
- [License](#license)

## Features

- **Real-time poll detection** via a WebSocket hook on `wss://central-socket.penpencil.co`, not a fixed polling interval
- **Sub-second auto-submit** of a pre-armed answer (A/B/C/D), with configurable delay (0–5s, 0.1s precision)
- **Authoritative timing** — submission is capped against the poll's real server-reported deadline, not just the configured delay
- **Animation-frame-synced UI** — the floating control tracks the real poll icon's live coordinates every frame instead of being inserted into the host page's own DOM tree, so it survives framework re-renders
- **Auto-hide on inactivity**, mirroring native video-player control behavior
- **Persistent settings** via `chrome.storage.local`, live-synced across the popup and in-page UI with no reload required
- **Verbose, opt-in debug logging** for troubleshooting without editing code

**Scope note:** this operates on **live classes only**. Recorded classes were deliberately descoped after several fallback-anchoring approaches failed to hold up across layouts — see [v2.7 in the changelog](#changelog) for the reasoning, and [Contributing](#contributing) if you want to take a crack at it.

## Tech stack & architecture

| | |
|---|---|
| **Language** | Vanilla JavaScript (ES2020+), no TypeScript build step |
| **Platform** | Chrome Extension, Manifest V3 |
| **Styling** | Hand-written CSS, custom properties for theming, no framework |
| **Storage** | `chrome.storage.local` (device-local, never synced) |
| **Dependencies** | None — no npm packages, no bundler, no CDN scripts |
| **Size** | ~1,300 lines across `content.js`, `popup.js`, `websocket-hook.js` |

```
pw-poll-extension/
├── manifest.json        # MV3 manifest — declares two content scripts and the storage permission
├── websocket-hook.js     # Runs in the page's MAIN world at document_start; hooks WebSocket
├── content.js            # Runs in the isolated world; owns UI injection, DOM detection, submission
├── popup.js / popup.html / popup.css   # Extension toolbar settings panel
├── overlay.css           # Styles for the in-page floating control
└── icons/
```

**Data flow:**

```
PW.live page loads
      │
      ▼
websocket-hook.js (MAIN world, document_start)
      │  hooks the native WebSocket constructor before the site's socket opens
      ▼
Site opens wss://central-socket.penpencil.co/...
      │  hook observes frames matching the poll_start / stop_expiry shape only
      │  (session token stripped from the URL before any use, including logs)
      ▼
window.postMessage → content.js (isolated world)
      │  cross-checks armed answer against the poll's real option list
      │  computes submit timing against the poll's real expiry
      ▼
DOM: option selected → Submit clicked
      │  (MutationObserver-based DOM color-change fallback if the socket event is missed)
      ▼
Status shown in the floating control / popup
```

Two content scripts run in two different execution contexts by design: `websocket-hook.js` needs the page's **main world** to see the native `WebSocket` object before the site's own bundle does; `content.js` stays in the extension's **isolated world**, per Chrome's security model, and the two talk to each other only via `window.postMessage`.

## Installation

Not published on the Chrome Web Store — this is a personal-use extension, loaded unpacked.

1. **Clone the repository**
   ```bash
   git clone https://github.com/<your-username>/pw-poll-extension.git
   ```
2. Open Chrome and navigate to `chrome://extensions`
3. Toggle on **Developer mode** (top right)
4. Click **Load unpacked** and select the cloned folder
5. Open a **live** class on `pw.live` — the control appears next to the poll icon within a few seconds

## Usage

1. While solving the problem, click the checkmark icon to open the panel, then pick **A**, **B**, **C**, or **D** to mark your intended answer (it turns green once armed). Click the same option again to deselect it.
2. Keep **Auto-submit** checked to have it click Submit automatically — this preference persists across reloads.
3. When the poll opens, your choice is selected (and submitted, if auto-submit is on) immediately.
4. Status messages in the panel report exactly what happened — e.g. `Selected 'B'`, `Submitted 'B' in 210ms`, or a warning if nothing matched.

## Settings

Click the extension's toolbar icon to open the settings popup:

| Setting | What it does |
|---|---|
| **Auto-submit** | Clicks Submit automatically once the pre-chosen answer is selected. Synced with the in-page toggle. |
| **Delay before submitting** | A slider (0–5s, 0.1s steps) plus a precise decimal field (e.g. `1.2`). Governs only when the *first* click attempt happens — if Submit isn't yet clickable, the extension re-checks every animation frame (not a fixed interval) until it is, up to a 2s timeout. The reported status always reflects real elapsed time. |
| **Hide with video controls** | Fades the control out after ~3s of no mouse movement over the player, back in the moment you move it. |
| **Auto-open poll panel** | Opens the poll panel automatically as soon as a poll becomes available, instead of waiting for the site's own animation. |
| **Debug logging** | Verbose console output (`F12`), prefixed `[PW Poll Assist]`. |

All changes apply immediately to any open `pw.live` tab — no reload required.

## How it works internally

**Poll detection.** Live classes connect to `wss://central-socket.penpencil.co/central-socket/ws`, which emits an unambiguous event the instant a poll opens:

```
poll {"operation":"start","pollId":"...","data":{"type":"SINGLE","pollOptions":[...],...},"event":"poll_start_v2_<scheduleId>"}
```

and a corresponding event as it's about to close:

```
poll {"operation":"stop_expiry","pollId":"...","expiryDuration":19,...}
```

`websocket-hook.js` hooks the page's native `WebSocket` constructor **before any connections open**, and forwards only frames matching this exact shape to the extension — it never inspects, logs, or forwards chat messages, telemetry, or anything else on that socket, even though it technically could.

**Selection & submission.** The `poll_start` payload carries the poll's real option labels and its real, authoritative deadline (`pollStartTime` + `expiryDuration`). Both are used directly: the armed answer is cross-checked against the real option list before any DOM search happens, and submission timing is capped to the poll's real remaining time rather than blindly trusting the configured delay. Options are matched by their **visible letter text** (not the input's `value` attribute, which isn't always present), and the button is clicked the same way a real user would.

**Resilience.** For the rare case the WebSocket signal is unavailable, a narrowly-scoped `MutationObserver` watches the poll icon's SVG fill color as a fallback trigger. The floating control itself is never inserted into PW.live's own DOM tree — it lives independently and recalculates its position from the real poll icon's live coordinates every animation frame, which avoids conflicts when the site's own framework re-renders the toolbar.

## Privacy & security

- **No network calls of any kind.** There is no `fetch`, `XMLHttpRequest`, or equivalent anywhere in the codebase — nothing is sent to any server, including analytics or telemetry.
- **Settings never leave your device.** Stored in `chrome.storage.local` (not `chrome.storage.sync`) — never synced to any account or cloud.
- **Minimal permissions.** The manifest requests only `storage`. No `tabs`, no `webRequest`, no host access beyond `pw.live` pages.
- **Narrowly-scoped WebSocket observation.** The hook matches only the specific `poll {"operation":...}` frame shape — it does not read, log, or forward chat messages, other students' data, or anything else on that socket.
- **Session token redaction.** The WebSocket URL contains a login token as a query parameter; it is stripped (`[redacted]`) before the URL is used for anything, including debug logs.
- **Debug logging is off by default**, and even when enabled, only writes to your own local browser console.
- **No build step, no minification.** Every file in this repository is exactly what runs in your browser, so every claim above is independently verifiable by reading the source.

## Responsible use

This is built for one specific case: you've already worked out the answer yourself and just want it submitted reliably and without delay once the poll opens — not to skip the problem entirely. Polls exist to check that you're following along; using this to answer things you haven't worked through defeats that purpose and isn't what this tool is for.

## Troubleshooting

- **Control not appearing** — this extension only operates on live classes, identified by the presence of the poll icon; recorded classes are out of scope (see [Features](#features)).
- **Control not appearing/reappearing** — open the popup and disable **Hide with video controls** to keep it always visible as a quick fix.
- **No errors, but nothing happens** — open DevTools Console; warnings prefixed `[PW Poll Assist]` usually mean PW.live's markup for that particular poll differs from what the script expects.
- **Want more detail** — enable **Debug logging** in the popup for a step-by-step console trace, no code editing or reload required.
- **Option or Submit button not found** — grab the poll's HTML via DevTools → Elements → right-click the poll → Copy → Copy outerHTML, and update the matching logic in `findMatchingOptionButton` / `findSubmitButton` in `content.js`. PRs welcome — see [Contributing](#contributing).

## Contributing

Issues and pull requests are welcome, especially if PW.live changes their markup or WebSocket protocol and something here breaks. A good bug report includes the relevant DOM snippet or console output — see [Troubleshooting](#troubleshooting) for how to capture those.

## Changelog

<details>
<summary><strong>Click to expand full version history (v1.0 → v3.3)</strong></summary>

**v3.3**
- Rebuilt the "Delay before submitting" slider from a bare native input into a fully custom-styled control: the track visually fills in the accent color up to the current value (kept in sync via a `--pct` custom property updated in JS, since CSS has no native concept of "filled to here" on a range input), the thumb has a soft glow ring and grows on hover/press with spring easing, and the live value readout is a proper "spec chip" instead of a plain text box.

**v3.2**
- Premium polish pass on both surfaces (popup and in-page dropdown): proper easing curves (smooth deceleration for color/background changes, a spring curve on toggle switches for a tactile snap), translucent "glass" card surfaces with a subtle top-edge highlight and soft drop shadow, a radial accent glow behind the popup header icon and active toggles, hover feedback on every interactive row, and tighter, more deliberate type hierarchy. Reverted to a dark, cohesive design after v3.1's light popup read as a generic flat settings panel.

**v3.1**
- Redesigned the popup with a lighter, more neutral surface; removed the static "Watching for polls" banner since it didn't reflect real state; refined the accent from a generic Material green to a deeper jade, still grounded in the product's own checkmark motif.

**v3.0**
- Housekeeping: version badge now read from `manifest.json` at runtime instead of being hardcoded in three places; removed a real code-duplication bug (`setArmedVisual` / `setArmedVisual2`, an artifact of a variable-assignment ordering issue); fixed stale documentation and malformed comments.

**v2.9**
- **Fixed a real bug behind several reported symptoms**: the "don't click if a poll panel looks already open" safeguard was checked with a loose "does *any* poll-shaped DOM node exist" test with no concept of *which* poll — if the previous poll's container lingered even briefly, a new poll's auto-open would silently no-op. Removed in favor of the existing identity-based guard (`handledPollStartIds`).
- **Fixed a distinct bug**: an already-answered poll's container could be re-detected as a brand-new poll if the site re-rendered it into a results view using a different DOM node. Now tracks answered poll IDs directly rather than DOM node references.
- Poll selection now cross-checks the armed answer against the poll's real option list from the WebSocket payload before touching the DOM, and submission timing respects the poll's real authoritative deadline.

**v2.8**
- Fixed a flicker bug: the control was torn down and rebuilt whenever `#poll-icon` was momentarily absent for a single check (routine during framework re-renders) — "is this a live class" detection is now sticky. Fixed a stale-answer bug where a failed select/submit never cleared the armed selection. Reduced CPU work in the submit-wait loop by caching the located button instead of re-scanning the page every frame. Fixed Space-bar also scrolling the page while the control was focused.

**v2.7**
- Removed recorded-class support entirely rather than leaving it as a half-working opt-in — no reliable anchor element exists on recorded-class pages, and several rounds of fallback selectors didn't hold up across layouts.

**v2.6**
- (Superseded by v2.7) Added an "Enable on recorded classes" setting, off by default, as an interim step before removing the feature outright.

**v2.5**
- Option-selection and Submit-readiness checks moved from a fixed 200ms interval to every animation frame. Option selection now retries for up to 800ms if buttons haven't rendered yet. Added a guard so auto-open never closes an already-open poll panel. Rapid DOM mutations are now coalesced into one check per frame.

**v2.4**
- Fixed the recorded-class button position anchoring to a fixed page corner instead of the real player/toolbar element.

**v2.3**
- Privacy hardening: WebSocket hook now matches the specific `poll {"operation":...}` frame shape instead of a loose "mentions poll" filter; session token redacted before any use, including logs.

**v2.2**
- Delay slider now works in seconds (0–5s, 0.1s steps) with a precise decimal field. Submitted status now shows real elapsed time and attempt count.

**v2.1**
- Confirmed the real poll protocol (`poll_start` / `stop_expiry` over WebSocket); auto-open now triggers directly off this event for live classes.

**v2.0**
- Visual redesign with a proper extension icon, animated toggles, and color-coded status. WebSocket instrumentation added. Fixed a "hide with video controls" bug that could get permanently stuck. Auto-open switched from a blind timer to edge-triggered detection off the poll icon's color change.

**v1.1**
- Added the settings popup (auto-submit, delay slider, debug logging) backed by `chrome.storage`, live-synced with the page. Decoupled the control from the site's DOM tree, fixing a bug where it was left behind on framework re-renders.

**v1.0**
- Initial release: pre-select an answer, auto-detect the poll, auto-submit.

</details>

## License

MIT — see [LICENSE](./LICENSE).

---

*Built as a personal project to solve a real, specific latency problem — and to get comfortable with Manifest V3's execution-world model, WebSocket interception, and defensive DOM programming along the way. Feedback and PRs welcome.*
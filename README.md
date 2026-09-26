# Poll Assist for PW Live

![License: MIT](https://img.shields.io/badge/license-MIT-4caf50.svg)
![Manifest V3](https://img.shields.io/badge/manifest-v3-blue.svg)
![Platform](https://img.shields.io/badge/platform-Chrome-yellow.svg)
![Status](https://img.shields.io/badge/status-personal%20project-lightgrey.svg)

A small, unofficial Chrome extension that pre-selects a poll answer and
submits it the instant a poll appears during a PW.live class, live or
recorded.

> **Unofficial project.** Not affiliated with, endorsed by, or connected
> to Physics Wallah or PW.live in any way. Built by inspecting the
> site's own public-facing markup and network traffic — it may break
> whenever PW.live changes their site, since there's no official API
> involved.

## Responsible use

This is meant for one specific case: you've already worked out the
answer yourself, and you just want it submitted reliably and without
delay once the poll opens — not to skip the problem entirely. Polls
exist to check that you're actually following along; using this to
answer things you haven't worked through defeats that purpose and isn't
what this tool is for.

## Table of contents

- [What it does](#what-it-does)
- [Install](#install-unpacked-for-personal-use)
- [How to use](#how-to-use)
- [Settings popup](#settings-popup)
- [Real-time poll detection](#real-time-poll-detection-websocket)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [How it works internally](#notes-on-how-it-works)
- [Changelog](#changelog)
- [License](#license)

## What it does

Adds a small control docked next to the poll icon during **live**
PW.live classes. Pre-select the answer you've worked out (A/B/C/D), and
the moment a poll appears on screen, it selects that option and clicks
Submit for you.

**Recorded classes aren't supported.** There's no reliable element to
anchor the button to there, and after a few attempts at fallback
positioning that didn't hold up across different page layouts, this was
scoped back to live classes only rather than ship something
half-working. See [Contributing](#contributing) if you want to take a
crack at it.

## Install (unpacked, for personal use)

This isn't published on the Chrome Web Store — it's a personal-use,
load-it-yourself extension.

1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions`
3. Toggle on **Developer mode** (top right)
4. Click **Load unpacked**
5. Select this repository's folder
6. Visit `pw.live` and open a class — the control appears within a few
   seconds

## How to use

1. While solving the problem, click the checkmark icon to open the panel,
   then click **A**, **B**, **C**, or **D** to mark your intended answer
   (it turns green once armed). Clicking the same option again deselects
   it.
2. Keep "Auto-submit" checked to have it click Submit automatically —
   this preference is remembered across page reloads.
3. When the poll opens, your choice is selected (and submitted, if
   auto-submit is on) immediately.
4. Status messages in the panel tell you what happened — e.g. "Selected
   'B'", "Submitted 'B' in 210ms", or a warning if something didn't
   match.

## Settings popup

Click the extension's icon in Chrome's toolbar to open a settings panel:

| Setting | What it does |
|---|---|
| **Auto-submit** | Click Submit automatically after your pre-chosen answer is selected. Synced with the in-page toggle. |
| **Delay before submitting** | A slider (0–5s, 0.1s steps) plus a precise decimal-capable field (e.g. `1.2`) for exact control. Only controls when the *first* click attempt happens — if Submit isn't clickable yet, it checks every animation frame (not a slow fixed interval) until it is, up to a 2s timeout. The status message reports the real elapsed time so this is never a mystery. |
| **Hide with video controls** | Fades the button out after ~3s of no mouse movement over the player, and back in the moment you move it — mirrors how native player controls behave. |
| **Auto-open poll panel** | Opens the poll panel automatically when a poll becomes available, instead of waiting for it to pop up on its own. |
| **Debug logging** | Verbose console output (F12), prefixed `[PW Poll Assist]`, for troubleshooting. |

Changes take effect immediately on any open pw.live tab — no page reload
needed.

## Real-time poll detection (WebSocket)

Live classes connect to `wss://central-socket.penpencil.co/central-socket/ws`,
which sends an unambiguous event the instant a poll starts:

```
poll {"operation":"start","pollId":"...","data":{"type":"SINGLE","pollOptions":[...],...},"event":"poll_start_v2_<scheduleId>"}
```

and a corresponding event as it's about to close:

```
poll {"operation":"stop_expiry","pollId":"...","expiryDuration":19,...}
```

`websocket-hook.js` runs inside the page's own JavaScript (before any
WebSocket connections open) and forwards frames matching this exact
shape to the extension, so it can open the poll panel the instant a
**new** poll starts — reliably, for every poll in the class, not just
the first. It never modifies or blocks any of the site's own traffic, it
only observes, and it deliberately ignores everything else on that
socket (chat, telemetry, etc.) — see [Privacy](#privacy).

This only covers **live** classes, which is the only context this
extension operates in at all — see [What it does](#what-it-does). The
edge-triggered color-change detection below exists as a fallback for
this same live-class poll icon in case the WebSocket event is ever
missed, not for recorded classes.

## Privacy

- **No network calls of any kind.** The extension never sends anything
  to any server — not analytics, not telemetry, nothing. There's no
  `fetch`, `XMLHttpRequest`, or similar anywhere in the code.
- **Settings never leave your device.** Stored in `chrome.storage.local`
  (not `chrome.storage.sync`) — never synced to any account or cloud.
- **Minimal permissions.** The manifest requests only `storage`. No
  `tabs`, no `webRequest`, no host access beyond pw.live pages.
- **The WebSocket hook only watches for one specific message shape** —
  frames matching PW.live's actual poll-protocol format. It does not
  inspect, log, or forward chat messages, other students' data, or
  anything else on that socket, even though it technically could.
- **Your session token is redacted before it's touched.** The WebSocket
  URL contains your login token as a query parameter; it's stripped out
  (replaced with `[redacted]`) before that URL is used for anything,
  including debug logs.
- **Debug logging is off by default** and only writes to your own local
  browser console.
- No build step, no minification — every file here is exactly what runs
  in your browser, so you can verify all of the above yourself.

## Troubleshooting

- **Button not appearing** — this extension only operates on live
  classes (identified by the presence of the poll icon). Recorded
  classes are out of scope — see [What it does](#what-it-does).
- **Button not appearing/reappearing on live classes** — open the popup
  and turn **off** "Hide with video controls" to keep it always visible
  as a quick fix.
- **No errors, but nothing happens** — open DevTools Console; warnings
  prefixed `[PW Poll Assist]` usually mean PW.live's markup for that
  particular poll differs from what the script expects.
- **Want more detail** — turn on "Debug logging" in the popup for a
  step-by-step console trace, no code editing or reload required.
- **Option or Submit button not found** — grab the poll's HTML via
  DevTools → Elements → right-click the poll → Copy → Copy outerHTML,
  and update the matching logic in `findMatchingOptionButton` /
  `findSubmitButton` in `content.js` to match the new structure. PRs
  welcome if you fix something — see [Contributing](#contributing).

## Notes on how it works

- The WebSocket `poll_start` event carries the poll's real option labels
  and its real, authoritative deadline (`pollStartTime` +
  `expiryDuration`). These are used directly: the armed answer is
  checked against the real option list before any DOM search happens,
  and submission timing is capped to fit inside the real remaining time
  rather than blindly trusting the configured delay.
- The button fades based on real mouse movement over the detected player
  area (or the button/dropdown itself), not by reading the site's
  internal CSS state — an earlier approach that mirrored Video.js's
  `vjs-user-active`/`vjs-user-inactive` classes proved unreliable and
  could get the button stuck hidden.
- For situations where the WebSocket signal is unavailable or missed, a
  pending poll is also detected via the poll icon's SVG fill color
  switching from white to the site's theme color — watched by a
  narrowly-scoped `MutationObserver` on that one element for an instant,
  cheap reaction.
- The button is never inserted into PW.live's own DOM tree. It lives
  independently and recalculates its position every animation frame from
  the real poll icon's live coordinates — this avoids conflicts with the
  site's own framework re-rendering the toolbar.
- Poll options are matched by their **visible letter text**, not the
  input's `value` attribute, since that attribute isn't always present.
  The whole option button is clicked, same as a real user would.
- The Submit button is searched for across the **whole page**, since
  it's been observed living outside the poll's own DOM block.

## Contributing

Issues and pull requests are welcome, especially if PW.live changes
their markup or protocol and something here breaks. A good bug report
includes the relevant DOM snippet or console output — see
[Troubleshooting](#troubleshooting) for how to grab those.

## Changelog

<details>
<summary>Click to expand version history</summary>

**v3.3**
- Rebuilt the "Delay before submitting" slider from a bare native input
  into a fully custom-styled control: the track now visually fills in
  the accent color up to the current value (the standard technique
  behind every polished slider you've used — CSS has no native concept
  of "filled to here" on a range input, so this is kept in sync via a
  `--pct` custom property updated in JS), the thumb is larger with a
  soft glow ring and grows slightly on hover/press with spring easing,
  and the live value readout next to it is now a proper "spec chip"
  (fused number + unit, subtle inset border) instead of a plain text
  box.

**v3.2**
- Premium polish pass on both surfaces (popup and in-page dropdown):
  - Proper easing curves throughout instead of default linear/ease
    transitions — a smooth deceleration curve for color/background
    changes, a spring curve (slight overshoot) specifically on the
    toggle switches for a tactile, iOS-style snap
  - Translucent "glass" card surfaces with a subtle top edge highlight
    and soft drop shadow, instead of flat fills — the classic technique
    premium dark UIs (Linear, Raycast, Arc) use for depth
  - A radial accent glow behind the popup header icon, and matching glow
    on the toggle switches and option buttons when active
  - Hover feedback on every interactive row/button, not just the
    obviously clickable elements
  - Tighter letter-spacing and more deliberate type hierarchy
  - Went back to a dark, cohesive design for both surfaces (v3.1's light
    popup didn't land well — it read as a generic flat settings panel
    rather than feeling more refined)

**v3.1**
- Redesigned the popup: light, neutral surface instead of the previous
  dark-with-bright-green treatment (a combination common enough in
  AI-generated UI to be worth deliberately avoiding) — closer to how
  well-regarded browser extension settings panels actually look. Removed
  the static "Watching for polls" banner, since it didn't reflect real
  state and didn't earn its space. Row dividers are now handled via CSS
  instead of extra markup for each one.
- Refined the accent color on both surfaces from a generic, bright
  Material Design green to a deeper, more considered jade — still
  grounded in the product's own checkmark/correct-answer motif, just
  less templated-looking.
- The in-page dropdown deliberately stays dark, since it sits directly
  beside PW.live's own dark video-player controls — a contextual choice
  rather than a default, unlike the popup which is its own standalone
  surface.
- The in-page "selected option" state changed from a solid filled button
  to a softer accent-tinted style, less visually loud.

**v3.0**
- Housekeeping pass, no functional changes to detection/submission
  behavior:
  - The version badge (popup and in-page dropdown) is now read directly
    from the manifest at runtime instead of being a hardcoded string
    duplicated in three separate places — which had already drifted out
    of sync at least once during development. Bumping the version now
    only requires updating `manifest.json`.
  - Removed a genuine code duplication bug: two nearly-identical
    functions (`setArmedVisual` / `setArmedVisual2`) existed only
    because of a variable-assignment ordering issue. Consolidated into
    one.
  - Fixed stale documentation: the file header comment still described
    the recorded-class/floating-position behavior removed in v2.7.
  - Fixed malformed comment formatting left over from an earlier edit.

**v2.9**
- **Fixed a real bug likely behind several reported symptoms at once**:
  the "don't click if a poll panel looks already open" safeguard added
  in v2.5 was checked using a loose "does *any* poll-shaped DOM node
  exist" test, with no concept of *which* poll. If the previous poll's
  container lingered in the DOM for even a moment (e.g. showing a brief
  results state) right as a new poll's start event arrived, this made
  the new poll's auto-open silently no-op. Removed that check from the
  WebSocket-triggered path entirely — it already has a far stronger,
  precise guard (`handledPollStartIds`, keyed to the poll's actual
  unique ID), making the DOM-presence check both redundant and a source
  of false positives there. It remains in place for the separate
  DOM-color-based fallback, where no such strong identity exists.
- **Fixed a distinct bug**: an already-answered poll's container could
  be re-detected as a brand new poll if the site re-renders it into a
  results/confirmation view using a different DOM node. Now tracks which
  poll IDs have actually been answered (durable, identity-based — not
  tied to any specific DOM node reference) and skips re-processing.
- Poll selection now cross-checks the armed answer against the poll's
  *real* option list (from the WebSocket `poll_start` payload) before
  touching the DOM at all, and submission timing now respects the poll's
  *real* authoritative deadline (`pollStartTime` + `expiryDuration`),
  shortening the configured delay if it would otherwise run past when
  the poll actually closes — using the site's own confirmed data rather
  than assumptions.
- Shortened the initial "is this a live class" grace period from 4s to
  2.5s for a snappier first load.

**v2.8**
- Fixed a flicker bug: the button and dropdown were being torn down and
  rebuilt from scratch whenever `#poll-icon` was momentarily absent for
  even a single check — which happens routinely when the site's own
  framework re-renders the toolbar. The "is this a live class" detection
  is now sticky: once the icon has been seen once, a transient absence
  is ignored rather than triggering teardown.
- Fixed a stale-answer bug: if selecting an option or clicking Submit
  ever timed out, the armed answer was never cleared. If a different,
  unrelated poll then appeared and you forgot to pick a new answer, the
  old selection could have been silently applied to it. All failure
  paths now clear the selection, matching the successful-submit
  behavior.
- Reduced CPU work during the submit-wait window: checking whether
  Submit has become clickable no longer re-scans every button on the
  entire page on every animation frame — it caches the located button
  once found and just re-checks its `disabled` state directly.
- Fixed pressing Space while the button is focused also scrolling the
  page (missing `preventDefault`).

**v2.7**
- Removed recorded-class support entirely rather than leaving it as an
  opt-in toggle. There's no reliable element to anchor the button to on
  recorded-class pages, and several rounds of fallback-selector attempts
  didn't hold up across different page layouts. The extension now scopes
  itself to live classes only (detected via the presence of the poll
  icon) — cleaner and more honest than a feature that only sometimes
  worked.

**v2.6**
- (Superseded by v2.7) Added an "Enable on recorded classes" setting,
  off by default, as an interim step before removing the feature
  outright.

**v2.5**
- Smoother, lower-latency submission: option-selection and Submit-button
  readiness are now checked every animation frame instead of on a fixed
  200ms interval, cutting worst-case detection latency substantially
- Option selection now retries for up to 800ms if the poll's option
  buttons haven't rendered yet at the first look, instead of giving up
  immediately
- Added a safeguard so auto-open (both the WebSocket-triggered and
  DOM-fallback paths) never clicks the poll icon while a poll panel is
  already open — previously a duplicate "start" event or a race between
  detection paths could have toggled an open panel closed
- The main detection loop now coalesces multiple rapid page mutations
  into a single check per animation frame instead of re-scanning the
  whole page on every individual DOM change, reducing overhead on busy
  pages without any loss of responsiveness

**v2.4**
- Fixed the recorded-class button position: it was falling back to a
  fixed corner of the whole page, which could land outside the actual
  video player depending on page layout. It now anchors to the real
  player/toolbar element (`#footer-right-section` /
  `#video-player-container` / `.video-player-app`) and pins to its right
  edge, vertically centered — the same relative spot it sits in next to
  the real poll icon in live classes.

**v2.3**
- Privacy hardening: the WebSocket hook now matches only the specific
  `poll {"operation":...}` frame shape instead of a loose "mentions
  poll" filter. Session auth token is now redacted before use anywhere,
  including debug logs. Added the Privacy section.

**v2.2**
- Delay slider now works in seconds (0–5s, 0.1s steps) instead of
  milliseconds, plus a precise decimal-capable number field (e.g. `1.2`)
- Submitted status now shows real elapsed time and attempt count, since
  actual submit time can run longer than the configured delay if the
  retry loop kicks in

**v2.1**
- Confirmed the real poll protocol: live classes send `poll
  {"operation":"start",...}` over WebSocket the instant a poll begins,
  and `stop_expiry` as it's about to close. Auto-open now triggers off
  this event directly for live classes — reliable for every poll, not
  just the first.

**v2.0**
- Visual redesign: proper extension icon, polished popup and in-page
  dropdown UI, animated toggle switches, color-coded status indicator
- WebSocket instrumentation added to help identify the site's real
  "poll started" event
- Fixed a bug where "hide with video controls" could get permanently
  stuck if it latched onto the wrong player element
- Auto-open poll panel is now edge-triggered off the poll icon's color
  change, instead of polling on a blind timer

**v1.1**
- Added settings popup (auto-submit toggle, submit delay slider, debug
  logging) backed by `chrome.storage`, synced live with the page
- Decoupled the button from the site's own DOM tree, fixing a bug where
  it would get left behind when the site's framework re-rendered the
  toolbar

**v1.0**
- Initial release: pre-select an answer, auto-detect the poll,
  auto-submit

</details>

## License

MIT — see [LICENSE](./LICENSE).

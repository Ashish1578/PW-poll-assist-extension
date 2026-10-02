/**
 * PW Live Poll Auto-Submit — content script
 *
 * Displays a small control docked next to the poll icon during live
 * PW.live classes, letting you pre-select an answer. When a poll appears
 * on screen, the script selects that answer and submits it. Only
 * operates on live classes (identified by the presence of #poll-icon) —
 * see the "Main observer loop" section below for why recorded classes
 * are out of scope.
 *
 * Design notes / known fragility:
 * - The button is deliberately NEVER inserted into PW.live's own DOM
 *   tree. Earlier versions did this and it broke when the site's
 *   framework (React) re-rendered that toolbar — React doesn't know
 *   about foreign nodes it didn't create, so it repositions its own
 *   buttons on re-render but leaves ours stuck in place. Instead, the
 *   button lives independently (fixed position, appended to <body>) and
 *   its coordinates are recalculated every animation frame from the real
 *   poll icon's live getBoundingClientRect(), so it always visually
 *   tracks the toolbar no matter how the site's layout shifts (opening
 *   chat, resizing, etc.).
 * - PW.live's poll markup has changed shape between examples seen during
 *   development (radio inputs sometimes carry a `value` attribute,
 *   sometimes don't). Detection therefore matches on the *visible*
 *   option letter text rather than the `value` attribute, and clicks the
 *   whole option button (the thing a real user would click).
 * - The Submit button has been observed living outside the poll's own
 *   DOM subtree, so it's searched for across the whole page rather than
 *   scoped to the poll container.
 * - The most reliable detection signal is the WebSocket poll_start event
 *   (see "WebSocket-driven poll detection" near the bottom of this
 *   file) — DOM/color-based detection exists only as a fallback for
 *   when that event is ever missed.
 * - The site's poll icon is a *toggle* (click = open, click again = close),
 *   so clicking it blindly is dangerous. Each poll is therefore handled by
 *   ONE "session" driven by ONE loop (see "Poll session"), and the only
 *   place the icon is ever clicked automatically is maybeOpenPanel(): only
 *   when no poll UI is visible (after one browser-task yield, not a timer),
 *   never right
 *   after the user touched the icon themselves, and rate-limited across
 *   every trigger (WebSocket event, icon color change, arming an answer).
 * - A poll's deadline is measured from when the event was *received*, not
 *   from the payload's server-side pollStartTime: client clocks drift, and
 *   trusting the server timestamp made polls look "already expired".
 * - No delay of its own is ever added: the only wait a user can hit is their
 *   own "Delay before submitting" (0 means 0). Work is triggered by DOM
 *   changes, and there are no timers on the happy path. Two things are
 *   waited for, each only for as long as the page itself takes: one browser
 *   task before the first icon click (so the site can finish rendering the
 *   poll it just received), and the page's own reaction to the option click
 *   (Submit must never land before the option is marked — see "confirm").
 * - Time-critical steps use nextFrame(): requestAnimationFrame with a timer
 *   fallback, because rAF never fires while the class tab is in the background.
 * - If PW.live changes its markup further, the things most likely to
 *   need updating are POLL_HEADING_MATCH and the button-matching logic
 *   in findMatchingOptionButton / findSubmitButton.
 */
(function () {
  "use strict";

  // ================= Config (fixed, not user-editable) =================
  const CONFIG = {
    TOOLBAR_WAIT_MS: 2500, // grace period to wait for #poll-icon to appear at all before concluding this page has no live class
    OPTION_FIND_TIMEOUT_MS: 800, // how long to wait for option buttons to render before giving up
    SUBMIT_TIMEOUT_MS: 2000, // how long to wait for Submit to become clickable before giving up
    POLL_GONE_CHECK_MS: 1000,
    POLL_HEADING_MATCH: "choice poll", // lowercase substring match against heading text
    ICON_SIZE: 40,
    DOCK_GAP: 8, // px gap between our icon and the real poll icon
    AUTO_OPEN_RETRY_MS: 250, // floor between ANY two clicks we make on the poll icon (it is a toggle); only stops two triggers firing in the same instant
    OPEN_HOLD_MS: 1000, // most we hold off opening the panel while the PREVIOUS poll's UI is still on screen and unchanged (i.e. it's evidently open)
    OPEN_VERIFY_MS: 1200, // after our click, how long to wait for the poll to show up before a single retry
    MAX_OPEN_CLICKS: 2, // per poll: the 2nd click only ever happens for an armed answer whose panel still didn't show up
    STALE_UI_TIMEOUT_MS: 400, // longest an on-screen UI that is state-for-state identical to the PREVIOUS poll's is treated as "old" rather than the new poll
    SELECTION_CONFIRM_MS: 200, // most we wait for the page to visibly register a clicked option before clicking Submit anyway (normally it's a few ms)
    SUBMIT_SAFETY_MARGIN_MS: 300, // leave this much of the poll's real window for the click itself to land
    POLL_END_GRACE_MS: 1500, // keep working this long past the reported expiry (latency / clock slop) before giving up
    UNKNOWN_POLL_WINDOW_MS: 60000, // window to assume when a poll is detected without WebSocket timing info
    SIGNAL_MERGE_MS: 4000, // the icon color change and the WS "start" frame within this window are the same poll
    POST_POLL_QUIET_MS: 1500, // after a poll ends, ignore DOM-only "new poll" detection this long (results views reuse the poll markup)
    SCAN_INTERVAL_MS: 0, // 0 = look at the DOM on every step. Scanning is cheap; any throttle would just be added latency
    BACKGROUND_TICK_MS: 120, // timer fallback for when requestAnimationFrame is paused (background tab)
  };

  // ================= User settings (editable via the extension popup) =================
  // Kept in chrome.storage.local (key "settings") so the popup and this
  // content script always agree, and so a change made in the popup takes
  // effect immediately without needing to reload the page.
  const DEFAULT_SETTINGS = {
    autoSubmitEnabled: true,
    submitDelayMs: 150, // how long to wait after selecting before clicking Submit
    debug: false,
    hideWithPlayerControls: true, // fade with the video player's own controls
    autoOpenPollPanel: true, // proactively click the poll icon if no poll is currently showing
  };
  let settings = Object.assign({}, DEFAULT_SETTINGS);

  function loadSettings() {
    try {
      chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (result) => {
        if (chrome.runtime.lastError) {
          warn("Couldn't load settings, using defaults.", chrome.runtime.lastError);
          return;
        }
        settings = Object.assign({}, DEFAULT_SETTINGS, result.settings);
        syncSettingsToUI();
        log("Settings loaded:", settings);
      });
    } catch (err) {
      warn("chrome.storage unavailable, using default settings.", err);
    }
  }

  function saveSettingsPatch(patch) {
    settings = Object.assign({}, settings, patch);
    syncSettingsToUI();
    try {
      chrome.storage.local.set({ settings });
    } catch (err) {
      warn("Couldn't persist settings.", err);
    }
  }

  function syncSettingsToUI() {
    if (!dropdownRef) return;
    const toggleEl = dropdownRef.querySelector("#pw-auto-toggle");
    if (toggleEl) toggleEl.checked = settings.autoSubmitEnabled;
  }

  // Stay in sync if the popup changes settings while this page is open.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.settings) return;
      settings = Object.assign({}, DEFAULT_SETTINGS, changes.settings.newValue);
      syncSettingsToUI();
      log("Settings updated from popup:", settings);
    });
  } catch (err) {
    warn("Couldn't attach storage change listener.", err);
  }

  // ================= Logging =================
  const PREFIX = "[PW Poll Assist]";
  function log(...args) {
    if (settings.debug) console.log(PREFIX, ...args);
  }
  function warn(...args) {
    console.warn(PREFIX, ...args);
  }
  function logError(context, err) {
    console.error(PREFIX, context, err);
  }

  // ================= State =================
  let selectedOption = null; // "A" | "B" | "C" | "D" | null
  let armedAt = 0; // when selectedOption was last armed (ms epoch) — tells "meant for this poll" from "meant for the next one"
  let answerWrapRef = null;
  let dropdownRef = null;
  let iconRef = null;
  let observer = null;
  let injectPollId = null;
  let trackingRafId = null;
  const scriptStartTime = Date.now();
  let destroyed = false;

  // ================= UI: build pieces =================
  function buildIconWrap() {
    const wrap = document.createElement("div");
    wrap.id = "pw-answer-btn-wrap";
    wrap.innerHTML = `
      <div id="pw-answer-icon" title="Pre-select poll answer" role="button" aria-label="Pre-select poll answer" tabindex="0">
        <svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" fill="none" viewBox="0 0 40 40" aria-hidden="true">
          <path fill="#ffffff" d="M20 4C11.163 4 4 11.163 4 20s7.163 16 16 16 16-7.163 16-16S28.837 4 20 4zm-2.2 22.8l-6.6-6.6 2.263-2.263 4.337 4.325 9.337-9.337 2.263 2.275L17.8 26.8z"/>
        </svg>
      </div>
    `;
    document.body.appendChild(wrap);
    return wrap;
  }

  function buildDropdown() {
    const dropdown = document.createElement("div");
    dropdown.id = "pw-answer-dropdown";
    dropdown.setAttribute("role", "dialog");
    dropdown.setAttribute("aria-label", "Poll Assist");
    dropdown.innerHTML = `
      <div class="pw-header">
        <span class="pw-header-title">Poll Assist</span>
        <span class="pw-header-badge" id="pw-version-badge"></span>
      </div>
      <div class="pw-toggle-row">
        <span class="pw-toggle-label">Auto-submit</span>
        <label class="pw-switch">
          <input type="checkbox" id="pw-auto-toggle">
          <span class="pw-switch-track"><span class="pw-switch-thumb"></span></span>
        </label>
      </div>
      <div class="pw-options" role="group" aria-label="Answer options">
        <button type="button" class="pw-opt-btn" data-val="A" aria-pressed="false">A</button>
        <button type="button" class="pw-opt-btn" data-val="B" aria-pressed="false">B</button>
        <button type="button" class="pw-opt-btn" data-val="C" aria-pressed="false">C</button>
        <button type="button" class="pw-opt-btn" data-val="D" aria-pressed="false">D</button>
      </div>
      <div class="pw-status" aria-live="polite">
        <span class="pw-status-icon">●</span>
        <span class="pw-status-text">Pick your answer — it'll be submitted the instant the poll opens.</span>
      </div>
    `;
    document.body.appendChild(dropdown);

    // Single source of truth for the version display: read it from the
    // manifest rather than hardcoding it here (and in popup.html) as
    // separate strings that have to be remembered and kept in sync by
    // hand on every release — a fragile process that has already drifted
    // at least once.
    try {
      const badge = dropdown.querySelector("#pw-version-badge");
      if (badge) badge.textContent = `v${chrome.runtime.getManifest().version}`;
    } catch (err) {
      logError("Couldn't read extension version", err);
    }

    return dropdown;
  }

  function positionDropdown() {
    if (!dropdownRef || !iconRef) return;
    try {
      const rect = iconRef.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const dropW = Math.min(190, vw - margin * 2);
      const dropH = dropdownRef.offsetHeight || 170;

      let top = rect.top - dropH - margin;
      if (top < margin) top = rect.bottom + margin;
      top = Math.max(margin, Math.min(top, vh - dropH - margin));

      let left = rect.right - dropW;
      left = Math.max(margin, Math.min(left, vw - dropW - margin));

      dropdownRef.style.width = `${dropW}px`;
      dropdownRef.style.top = `${top}px`;
      dropdownRef.style.left = `${left}px`;
    } catch (err) {
      logError("positionDropdown failed", err);
    }
  }

  function setArmedVisual(isArmed) {
    if (iconRef) iconRef.classList.toggle("pw-armed", !!isArmed);
  }

  function setStatus(text, kind) {
    if (dropdownRef && dropdownRef._pwSetStatus) dropdownRef._pwSetStatus(text, kind);
    log("status:", text);
  }

  function wireDropdown(dropdown) {
    const statusTextEl = dropdown.querySelector(".pw-status-text");
    const statusIconEl = dropdown.querySelector(".pw-status-icon");
    const toggleEl = dropdown.querySelector("#pw-auto-toggle");
    toggleEl.checked = settings.autoSubmitEnabled;

    dropdown.querySelectorAll(".pw-opt-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();

        // Clicking the already-selected option deselects it.
        if (selectedOption === btn.dataset.val) {
          selectedOption = null;
          btn.classList.remove("selected");
          btn.setAttribute("aria-pressed", "false");
          dropdown._pwSetStatus("Pick your answer — it'll be submitted the instant the poll opens.", "idle");
          setArmedVisual(false);
          log("Option deselected");
          return;
        }

        selectedOption = btn.dataset.val;
        dropdown.querySelectorAll(".pw-opt-btn").forEach((b) => {
          b.classList.remove("selected");
          b.setAttribute("aria-pressed", "false");
        });
        btn.classList.add("selected");
        btn.setAttribute("aria-pressed", "true");
        dropdown._pwSetStatus(`Ready — "${selectedOption}" will be submitted when the poll opens.`, "ready");
        setArmedVisual(true);
        log("Option armed:", selectedOption);
        // If a poll is already running, pick it up right now instead of waiting for the next one.
        onAnswerArmed();
      });
    });

    toggleEl.addEventListener("click", (e) => e.stopPropagation());
    toggleEl.addEventListener("change", () => {
      saveSettingsPatch({ autoSubmitEnabled: toggleEl.checked });
      dropdown._pwSetStatus(
        toggleEl.checked ? "Auto-submit is on." : "Auto-submit is off — you'll need to submit manually.",
        "idle"
      );
      log("Auto-submit set to", toggleEl.checked);
    });

    dropdown.addEventListener("click", (e) => e.stopPropagation());
    dropdown.addEventListener("keydown", (e) => {
      if (e.key === "Escape") dropdown.classList.remove("pw-open");
    });

    // kind: "idle" (default gray) | "ready" (blue) | "success" (green) | "warning" (amber)
    dropdown._pwSetStatus = (text, kind) => {
      statusTextEl.textContent = text;
      statusIconEl.className = "pw-status-icon" + (kind ? ` pw-status-${kind}` : "");
    };
  }

  function resetSelectionAfterPoll() {
    selectedOption = null;
    armedAt = 0;
    setArmedVisual(false);
    if (dropdownRef) {
      dropdownRef.querySelectorAll(".pw-opt-btn").forEach((b) => {
        b.classList.remove("selected");
        b.setAttribute("aria-pressed", "false");
      });
    }
  }

  // ================= Button creation (independent of site's DOM tree) =================
  function ensureButtonExists() {
    if (answerWrapRef && document.body.contains(answerWrapRef)) return;

    let dropdown = document.getElementById("pw-answer-dropdown");
    if (!dropdown) {
      dropdown = buildDropdown();
      wireDropdown(dropdown);
    }

    const wrap = buildIconWrap();
    const icon = wrap.querySelector("#pw-answer-icon");
    iconRef = icon; // set before setArmedVisual() below, which reads iconRef
    setArmedVisual(!!selectedOption);
    wrap.addEventListener("mouseenter", markActivity);
    dropdown.addEventListener("mouseenter", markActivity);
    dropdown.addEventListener("mousemove", markActivity);

    const toggleDropdown = (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.contains("pw-open");
      if (isOpen) {
        dropdown.classList.remove("pw-open");
      } else {
        dropdown.classList.add("pw-open");
        positionDropdown();
      }
    };
    icon.addEventListener("click", toggleDropdown);
    icon.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault(); // stop Space from also scrolling the page
        toggleDropdown(e);
      }
    });

    answerWrapRef = wrap;
    dropdownRef = dropdown;
  }

  // ================= Activity-based visibility =================
  // Own timer, not the site's internal CSS classes. Earlier versions
  // tried to mirror Video.js's own `vjs-user-active` /
  // `vjs-user-inactive` classes, but that proved unreliable — this site's
  // player didn't reliably transition back to "active" the way we
  // expected, leaving the button stuck hidden. Instead, we track real
  // mouse movement ourselves (over the player area, or over our own
  // button/dropdown) and fade out after a period of inactivity — the same
  // UX pattern video players use, driven by activity we can directly
  // observe rather than internal class names we have to guess at.
  const INACTIVITY_HIDE_MS = 3000; // matches the ~3s idle timeout most video players use
  let lastActivityAt = Date.now();

  let cachedPlayerRoot = null;
  function getPlayerRoot() {
    if (cachedPlayerRoot && document.body.contains(cachedPlayerRoot)) {
      return cachedPlayerRoot;
    }
    try {
      const anchor = document.querySelector(".vjs-current-time, .vjs-duration, .vjs-control-bar");
      const root =
        (anchor && anchor.closest(".video-js")) ||
        document.querySelector(".video-js") ||
        document.getElementById("video-player-container") ||
        document.querySelector(".video-player-app");
      cachedPlayerRoot = root || null;
    } catch (err) {
      logError("getPlayerRoot failed", err);
      cachedPlayerRoot = null;
    }
    return cachedPlayerRoot;
  }

  function markActivity() {
    lastActivityAt = Date.now();
  }

  document.addEventListener(
    "mousemove",
    (e) => {
      const root = getPlayerRoot();
      if (!root) {
        // No player detected at all — any movement counts as activity so
        // the button doesn't get stuck hidden on pages without one.
        markActivity();
        return;
      }
      const rect = root.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) {
        markActivity();
        return;
      }
      if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
        markActivity();
      }
    },
    { passive: true }
  );

  function shouldShowButton() {
    if (!settings.hideWithPlayerControls) return true;
    if (dropdownRef && dropdownRef.classList.contains("pw-open")) return true; // never hide mid-use
    return Date.now() - lastActivityAt < INACTIVITY_HIDE_MS;
  }
  // Runs every animation frame: finds the real poll icon (if any) and
  // pins our button beside it. Recorded classes (no #poll-icon at all)
  // are handled entirely in tick() — the button is never created there,
  // so this only ever needs to handle the live-class case.
  function trackPosition() {
    if (destroyed) return;
    try {
      if (answerWrapRef && document.body.contains(answerWrapRef)) {
        const visible = shouldShowButton();
        answerWrapRef.classList.toggle("pw-hidden", !visible);
        if (!visible && dropdownRef) dropdownRef.classList.remove("pw-open");

        const pollIcon = document.querySelector("#poll-icon");
        if (pollIcon) {
          const rect = pollIcon.getBoundingClientRect();
          // Only reposition if the icon is actually visible/laid out
          // (rect.width === 0 usually means display:none / not rendered).
          if (rect.width > 0 && rect.height > 0) {
            const left = rect.left - CONFIG.ICON_SIZE - CONFIG.DOCK_GAP;
            answerWrapRef.style.position = "fixed";
            answerWrapRef.style.top = `${rect.top}px`;
            answerWrapRef.style.left = `${Math.max(4, left)}px`;
          }
        }
        if (dropdownRef && dropdownRef.classList.contains("pw-open")) {
          positionDropdown();
        }
      }
    } catch (err) {
      logError("trackPosition failed", err);
    }
    trackingRafId = requestAnimationFrame(trackPosition);
  }

  // ================= Global UI event wiring (once) =================
  document.addEventListener("click", (e) => {
    // Ignore the clicks this script makes itself (poll icon / option / submit) —
    // otherwise every auto-open would slam the panel shut while you're using it.
    if (!e.isTrusted) return;
    if (!dropdownRef) return;
    if (answerWrapRef && answerWrapRef.contains(e.target)) return;
    if (dropdownRef.contains(e.target)) return;
    dropdownRef.classList.remove("pw-open");
  });

  window.addEventListener("resize", () => {
    if (dropdownRef && dropdownRef.classList.contains("pw-open")) positionDropdown();
  });

  // ================= Poll detection =================
  // Only a *visible* match counts. A closed panel that the site keeps
  // mounted (display:none) is not "an open poll" — treating it as one made
  // the old code believe the panel was open and skip opening it.
  function isVisible(el) {
    try {
      return !!el && el.isConnected && el.getClientRects().length > 0;
    } catch (_e) {
      return false;
    }
  }

  function isOwnUi(el) {
    return !!((dropdownRef && dropdownRef.contains(el)) || (answerWrapRef && answerWrapRef.contains(el)));
  }

  function containsPollHeading(node) {
    const spans = node.querySelectorAll("span");
    for (const sp of spans) {
      const t = sp.textContent;
      if (t && t.toLowerCase().includes(CONFIG.POLL_HEADING_MATCH)) return true;
    }
    return false;
  }

  // The poll UI = the smallest element holding both the heading ("... Choice
  // Poll") and its radio inputs. Starting from the radios makes the common
  // case (no poll on screen) a single cheap query instead of a scan of every
  // <span> on the page.
  function findPollContainer() {
    try {
      const radios = document.querySelectorAll('input[type="radio"]');
      if (radios.length === 0) return null;
      for (const radio of radios) {
        let node = radio.parentElement;
        for (let i = 0; i < 12 && node && node !== document.body; i++, node = node.parentElement) {
          if (containsPollHeading(node)) {
            if (isVisible(node)) return node;
            break; // heading found, but this poll UI is hidden — try the next radio
          }
        }
      }
    } catch (err) {
      logError("findPollContainer failed", err);
    }
    return null;
  }

  // A short text fingerprint of the poll UI, used to tell "the previous
  // poll's leftover UI" apart from "the new poll's UI" (see isLeftoverUi).
  function uiSignature(node) {
    try {
      let sig = (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 400);
      // Text alone isn't enough: consecutive polls often have identical text
      // (just "A B C D"). What tells a fresh UI from a used one is its
      // *state* — enabled vs disabled, selected vs not.
      let n = 0;
      for (const el of node.querySelectorAll("button, input")) {
        if (++n > 40) break;
        const selected =
          el.checked === true ||
          el.getAttribute("aria-pressed") === "true" ||
          el.getAttribute("aria-checked") === "true" ||
          el.getAttribute("aria-selected") === "true";
        sig += (el.disabled || el.getAttribute("aria-disabled") === "true" ? "|d" : "|e") + (selected ? "s" : "-");
      }
      return sig;
    } catch (_e) {
      return "";
    }
  }

  // Re-scanning the DOM every frame is wasteful; rescan when the DOM changed
  // (MutationObserver sets domDirty) or every SCAN_INTERVAL_MS otherwise
  // (covers pure style changes, e.g. display:none -> block, that don't
  // add/remove nodes).
  let domDirty = true;
  let scanCache = { at: 0, node: null };
  function currentPollContainer() {
    const now = Date.now();
    const cached = scanCache.node;
    if (!domDirty && now - scanCache.at < CONFIG.SCAN_INTERVAL_MS && (!cached || isVisible(cached))) {
      return cached;
    }
    scanCache = { at: now, node: findPollContainer() };
    domDirty = false;
    return scanCache.node;
  }

  function isOptionButton(btn, letter) {
    const want = letter ? letter.toUpperCase() : null;
    for (const s of btn.querySelectorAll("span")) {
      const t = s.textContent && s.textContent.trim().toUpperCase();
      if (!t) continue;
      if (want ? t === want : /^[A-D]$/.test(t)) return true;
    }
    return false;
  }

  // true / false when the page reports whether this option is selected, null
  // when it doesn't say (so we never guess).
  function isOptionSelected(btn) {
    try {
      const radio = btn.querySelector('input[type="radio"]');
      if (radio) return !!radio.checked;
      for (const attr of ["aria-pressed", "aria-checked", "aria-selected"]) {
        const v = btn.getAttribute(attr);
        if (v === "true") return true;
        if (v === "false") return false;
      }
    } catch (_e) {
      // fall through
    }
    return null;
  }

  function findMatchingOptionButton(container, letter) {
    if (!container || !letter) return null;
    try {
      for (const btn of container.querySelectorAll("button")) {
        if (btn.disabled || btn.getAttribute("aria-disabled") === "true") continue;
        if (isOptionButton(btn, letter)) return btn;
      }
    } catch (err) {
      logError("findMatchingOptionButton failed", err);
    }
    return null;
  }

  function hasOptionButtons(container) {
    try {
      for (const btn of container.querySelectorAll("button")) {
        if (!btn.disabled && isOptionButton(btn, null)) return true;
      }
    } catch (err) {
      logError("hasOptionButtons failed", err);
    }
    return false;
  }

  // The Submit button has been observed outside the poll's own subtree, so
  // it can't be looked up strictly inside the container — but "the first
  // button on the whole page containing 'submit'" also picks up unrelated
  // ones ("Submit feedback", a doubt/rating form, ...). So: the closest
  // scope around the poll wins, an exact "Submit" beats a longer label, and
  // far-away buttons are only accepted when the label is exactly "Submit".
  // Without the poll on screen there is nothing to anchor to, so no guess is
  // made at all — a wrong click on some unrelated Submit is worse than a
  // clear "couldn't find Submit" warning.
  function findSubmitButton(container) {
    if (!container) return null;
    try {
      const cands = [];
      for (const b of document.querySelectorAll("button")) {
        if (isOwnUi(b)) continue;
        const t = (b.textContent || "").trim().toLowerCase();
        if (!t.includes("submit") || !isVisible(b)) continue;
        cands.push({ b, rank: t === "submit" ? 0 : t.startsWith("submit") ? 1 : 2 });
      }
      if (cands.length === 0) return null;

      let scope = container;
      for (let i = 0; i < 6 && scope && scope !== document.body; i++, scope = scope.parentElement) {
        const inScope = cands.filter((c) => scope.contains(c.b));
        if (inScope.length) return inScope.reduce((best, c) => (c.rank < best.rank ? c : best)).b;
      }
      const exact = cands.filter((c) => c.rank === 0);
      return exact.length ? exact[0].b : null;
    } catch (err) {
      logError("findSubmitButton failed", err);
    }
    return null;
  }

  // Does this look like a poll you can vote in right now (as opposed to a
  // results / "answer recorded" view that reuses the same heading)?
  function looksLikeLiveVote(container) {
    return hasOptionButtons(container) && !!findSubmitButton(container);
  }

  // ================= Scheduling =================
  // requestAnimationFrame never fires in a background tab, and a live class
  // is very often left in one. Every time-critical step therefore also has a
  // timer fallback (timers keep running, just throttled) — whichever fires
  // first runs the callback, the other is a no-op.
  function nextFrame(fn) {
    let fired = false;
    let timer = 0;
    const run = () => {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
      fn();
    };
    requestAnimationFrame(run);
    timer = setTimeout(run, CONFIG.BACKGROUND_TICK_MS);
  }

  // Lets the site's own already-queued work run first. When a poll event
  // arrives, our handler runs BEFORE the site has rendered what it just
  // received (the hook's message is queued ahead of the site's own render),
  // so "no poll UI on screen yet" at that instant does not mean the panel is
  // closed. One task later it usually does — and that is a few milliseconds,
  // not a timer: it is the only thing standing between "poll event" and
  // "click", and it is what stops us toggling an already-open panel shut.
  function afterSiteTask(fn, light) {
    const finish = () => {
      // In a hidden tab timers are throttled to ~1s, so skip the 2nd hop there
      // (and `light` callers only ever want the single message-task hop).
      if (light || document.hidden) fn();
      else setTimeout(fn, 0);
    };
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        finish();
      };
      ch.port2.postMessage(0);
    } catch (_e) {
      finish();
    }
  }

  // ================= Poll session =================
  // Everything that happens for one poll — opening the panel, waiting for
  // its UI, selecting, submitting — lives in ONE session object driven by
  // ONE loop (superviseSession). That's deliberate: the site's poll icon is
  // a *toggle*, and the old code had two independent code paths that could
  // each click it (the WebSocket "start" event and the icon-color change).
  // When both fired, or when either fired while the panel was already open,
  // the net effect was closing the panel. Now there is exactly one place
  // that ever clicks it (maybeOpenPanel), with rate limits.
  let session = null;
  let lastUiMark = null; // { node, sig } — the last poll UI we saw
  let lastEndedAt = 0; // when the previous session ended
  let lastIconClickAt = 0;
  let sessionSeq = 0;
  const handledPollStartIds = new Set();

  function beginSession({ id, meta, source }) {
    if (destroyed) return null;
    const now = Date.now();
    const durationMs = meta && typeof meta.durationMs === "number" ? meta.durationMs : CONFIG.UNKNOWN_POLL_WINDOW_MS;

    if (session && session.state === "live" && now - session.startedAt < CONFIG.SIGNAL_MERGE_MS) {
      // The icon's color change and the WebSocket "start" frame describe the
      // same poll and land within milliseconds of each other, in either
      // order. Fold them into one session so the panel is only opened once.
      if (source === "ws" && session.source !== "ws") {
        session.id = id;
        session.source = "ws";
        session.meta = meta;
        session.deadlineAt = now + durationMs;
        log("Poll session upgraded with WebSocket details:", id);
        return session;
      }
      if (source !== "ws") return session;
    }

    if (session && session.state === "live") endSession(session, "superseded");

    const s = {
      id,
      source, // "ws" | "icon" | "dom"
      meta, // { pollId, options, durationMs } from the WebSocket, or null
      startedAt: now,
      // Deliberately measured from *when we received the event*, not from the
      // payload's pollStartTime: that timestamp is on the server's clock, and
      // a PC clock that's even a little ahead made every poll look "already
      // expired" and got it skipped.
      deadlineAt: now + durationMs,
      state: "live",
      answered: false,
      clicks: 0, // times WE clicked the poll icon for this poll
      lastClickAt: 0,
      userToggled: false, // the user clicked the icon themselves — stop touching it
      attempt: null,
      warnedUnarmed: false,
      staleMark: lastUiMark, // what the poll UI looked like BEFORE this poll
      settled: false, // true once the site has had one task to render what it just received
    };
    session = s;
    log("Poll session started:", id, `(${source})`);
    // If a poll UI is already showing, we act on it immediately (below). Only
    // the decision to CLICK the toggle icon waits for this one-task yield.
    afterSiteTask(() => {
      s.settled = true;
      if (session === s && s.state === "live") superviseSession();
    });
    kickSupervisor();
    return s;
  }

  function endSession(s, reason) {
    if (!s || s.state === "ended") return;
    s.state = "ended";
    dropAttempt(s);
    lastEndedAt = Date.now();
    noteUi(currentPollContainer(), true);
    if (reason === "expired" && !s.answered && selectedOption && armedAt <= s.deadlineAt) {
      // The armed answer was meant for this poll and the poll is over. Don't
      // leave it armed to fire on some later, unrelated poll. (An answer armed
      // AFTER the deadline is for the next poll, so it's left alone.)
      setStatus("The poll ended before your answer could be submitted.", "warning");
      resetSelectionAfterPoll();
    }
    log("Poll session ended:", s.id, `(${reason})`);
  }

  let supervisorRunning = false;
  function kickSupervisor() {
    if (supervisorRunning) return;
    supervisorRunning = true;
    const step = () => {
      if (destroyed || !session || session.state === "ended") {
        supervisorRunning = false;
        return;
      }
      try {
        superviseSession();
      } catch (err) {
        logError("superviseSession failed", err);
      }
      if (!session || session.state === "ended") supervisorRunning = false;
      else if (session.answered) setTimeout(step, 250); // just watching the UI settle now
      else nextFrame(step);
    };
    step();
  }

  // Remember what the poll UI currently looks like, so the next poll can
  // tell a leftover copy of this one from its own fresh UI.
  let notedAt = 0;
  function noteUi(container, force) {
    // Fingerprinting the UI isn't free; a few times a second is plenty (and the
    // final state is always recorded when a session ends — see endSession).
    const t = Date.now();
    if (!force && t - notedAt < 100) return;
    notedAt = t;
    // Always a NEW object: a session's staleMark is a snapshot of an earlier
    // lastUiMark and must never change underneath it.
    if (container) {
      lastUiMark = { node: container, sig: uiSignature(container) };
    } else if (lastUiMark && lastUiMark.node.isConnected) {
      // The node is still there but is no longer a poll (results / "answer
      // recorded"): remember what it looks like *now*, so a later poll
      // rendered into the same node is recognised as new.
      lastUiMark = { node: lastUiMark.node, sig: uiSignature(lastUiMark.node) };
    }
  }

  // True while the poll UI on screen is still (an unchanged copy of) the
  // previous poll's. Acting on it would select/submit into a poll that has
  // already ended.
  function isLeftoverUi(s, container, now) {
    const m = s.staleMark;
    if (!m || now - s.startedAt >= CONFIG.STALE_UI_TIMEOUT_MS) return false;
    return container === m.node && uiSignature(container) === m.sig;
  }

  function clickPollIcon(reason) {
    try {
      const icon = document.querySelector("#poll-icon");
      if (!icon) return false;
      lastIconClickAt = Date.now();
      icon.click();
      log("Clicked poll icon —", reason);
      return true;
    } catch (err) {
      logError("clickPollIcon failed", err);
      return false;
    }
  }

  // The ONLY place the poll icon gets clicked automatically. Called only
  // when no poll UI is visible.
  function maybeOpenPanel(s, now) {
    if (!settings.autoOpenPollPanel) return;
    if (s.userToggled) return; // the user is driving the panel — don't fight them
    if (s.clicks >= CONFIG.MAX_OPEN_CLICKS) return;

    if (s.clicks === 0) {
      if (!s.settled) return; // one browser task — see afterSiteTask
      // If the PREVIOUS poll's UI is still on screen, the panel is open: it is
      // about to be swapped for the new poll (we then act on it with no click
      // at all) or the site is about to close it (we then click the moment it
      // has gone). Either way clicking now would toggle it shut, so we watch
      // the screen instead of a clock. The cap only stops a panel that is
      // permanently static from blocking us forever.
      const oldUiStillShowing = !!(s.staleMark && isVisible(s.staleMark.node));
      if (oldUiStillShowing && now - s.startedAt < CONFIG.OPEN_HOLD_MS) return;
    } else {
      // A second click is a toggle back — it only makes sense if the first
      // one evidently didn't produce the poll, and only when an armed
      // answer is actually waiting on it.
      if (!selectedOption) return;
      const opts = s.meta && Array.isArray(s.meta.options) && s.meta.options.length > 0 ? s.meta.options : null;
      if (opts && !opts.includes(selectedOption.toUpperCase())) return; // not answerable — don't close a panel the user may want
      if (now - s.lastClickAt < CONFIG.OPEN_VERIFY_MS) return;
    }
    if (now - lastIconClickAt < CONFIG.AUTO_OPEN_RETRY_MS) return; // hard floor, across every path

    if (clickPollIcon(s.clicks === 0 ? `poll ${s.id} started, panel not showing it` : `retry — panel still not showing poll ${s.id}`)) {
      s.clicks++;
      s.lastClickAt = now;
    }
  }

  function warnUnarmedOnce(s) {
    if (s.warnedUnarmed) return;
    s.warnedUnarmed = true;
    setStatus("Poll detected, but no option was pre-selected!", "warning");
    warn("Poll appeared with no pre-selected option.");
  }

  // One step of the loop that drives the current poll.
  function superviseSession() {
    const s = session;
    if (!s || s.state === "ended") return;
    const now = Date.now();
    if (now > s.deadlineAt + CONFIG.POLL_END_GRACE_MS) {
      endSession(s, "expired");
      return;
    }

    const container = currentPollContainer();
    noteUi(container);
    if (s.answered) return; // nothing left to do for this poll

    if (now > s.deadlineAt) {
      // The poll's window is over. The grace period exists so an attempt
      // that's already in flight can finish or fail cleanly, and so we can
      // watch the site swap its UI (which lets the next poll tell this one's
      // leftovers from its own) — never to start new work on a dead poll.
      if (s.attempt) advanceAttempt(s, container, now);
      return;
    }

    if (s.attempt) {
      advanceAttempt(s, container, now);
      return;
    }
    if (container) {
      if (isLeftoverUi(s, container, now)) return; // wait for the site to swap in the new poll
      if (!selectedOption) {
        warnUnarmedOnce(s);
        return;
      }
      beginAttempt(s, container, now);
      return;
    }
    maybeOpenPanel(s, now);
  }

  // ================= Selecting + submitting =================
  function beginAttempt(s, container, now) {
    const letter = selectedOption;
    s.warnedUnarmed = true; // from here on the status line belongs to this attempt's outcome

    // The WebSocket payload is the site's own authoritative data: if the
    // armed answer isn't one of this poll's options, don't waste time
    // searching the DOM for something that can't exist.
    const opts = s.meta && Array.isArray(s.meta.options) && s.meta.options.length > 0 ? s.meta.options : null;
    if (opts && !opts.includes(letter.toUpperCase())) {
      setStatus(`Armed answer "${letter}" isn't one of this poll's options (${opts.join(", ")}).`, "warning");
      warn(`Selected option "${letter}" isn't in this poll's real option list:`, opts);
      resetSelectionAfterPoll();
      return;
    }

    s.attempt = {
      letter,
      phase: "select", // select -> confirm -> delay -> submit
      startedAt: now,
      optionBtn: null,
      selectedAt: 0,
      delayMs: 0,
      submitStartedAt: 0,
      submitTimeoutMs: 0,
      reselects: 0,
      sawSelected: false, // the page has shown our option as selected at least once
      clickedAt: 0, // when we last clicked the option
      reacted: false, // the page changed the option in response to that click
      hopStarted: false,
      hopDone: false,
      optionObserver: null,
      lostAt: 0,
    };
    log(`Attempting "${letter}" on poll ${s.id}.`);
    advanceAttempt(s, container, now);
  }

  // The page processes a click a moment AFTER the click handler returns (React
  // and friends commit the new state in a later task). A Submit that lands
  // before that goes out with no option selected — so after clicking the
  // option we watch for the page's reaction (see "confirm" in advanceAttempt).
  function stopOptionWatch(a) {
    if (a && a.optionObserver) {
      a.optionObserver.disconnect();
      a.optionObserver = null;
    }
  }

  function dropAttempt(s) {
    if (s && s.attempt) stopOptionWatch(s.attempt);
    if (s) s.attempt = null;
  }

  function watchOptionReaction(s, a, btn) {
    stopOptionWatch(a);
    try {
      const mo = new MutationObserver(() => {
        if (a.reacted) return;
        a.reacted = true;
        if (session === s && s.attempt === a) superviseSession(); // right now, not next frame
      });
      mo.observe(btn, { attributes: true, childList: true, subtree: true, characterData: true });
      if (btn.parentElement) mo.observe(btn.parentElement, { attributes: true, childList: true });
      a.optionObserver = mo;
    } catch (err) {
      logError("watchOptionReaction failed", err);
    }
  }

  function clickOption(s, a, btn, now) {
    a.optionBtn = btn;
    a.clickedAt = now;
    if (!a.selectedAt) a.selectedAt = now; // the delay you set counts from the FIRST selection
    a.reacted = false;
    a.hopStarted = false;
    a.hopDone = false;
    a.sawSelected = false;
    watchOptionReaction(s, a, btn); // before the click, so a synchronous reaction is caught too
    btn.click();
    // Pages that react without touching the DOM (e.g. only a radio's `checked`)
    // never trigger the observer — look again one task later.
    afterSiteTask(() => {
      if (session === s && s.attempt === a) superviseSession();
    }, true);
  }

  function failAttempt(s, statusText, warnText) {
    setStatus(statusText, "warning");
    warn(warnText);
    // Clear the armed answer rather than leaving it to silently fire on some
    // later, unrelated poll if the user forgets to re-pick.
    resetSelectionAfterPoll();
    dropAttempt(s);
  }

  function advanceAttempt(s, container, now) {
    const a = s.attempt;
    if (!a) return;

    // The user changed their mind while we were waiting (the submit delay
    // can be up to a minute): honour the *current* choice, never a stale one.
    if (!selectedOption) {
      dropAttempt(s);
      setStatus("Answer cleared — nothing was submitted.", "idle");
      log("Armed answer was cleared mid-attempt; aborting.");
      return;
    }
    if (selectedOption !== a.letter) {
      dropAttempt(s); // the loop starts a fresh attempt with the new letter
      log(`Armed answer changed ${a.letter} -> ${selectedOption} mid-attempt; restarting.`);
      return;
    }

    const remainingMs = s.deadlineAt - now;
    if (remainingMs <= 0) {
      failAttempt(s, "This poll has already ended — not attempting to submit.", "Poll window has passed; skipping.");
      return;
    }
    const usableMs = Math.max(0, remainingMs - CONFIG.SUBMIT_SAFETY_MARGIN_MS);

    if (!container) {
      // The poll UI is gone (panel closed, site swapped it out, or you
      // submitted by hand). Give it a moment to come back before giving up.
      if (!a.lostAt) a.lostAt = now;
      if (now - a.lostAt >= CONFIG.SUBMIT_TIMEOUT_MS) {
        failAttempt(s, "The poll closed before your answer could be submitted.", "Poll UI disappeared mid-attempt.");
      }
      return;
    }
    if (a.lostAt) {
      a.lostAt = 0;
      a.startedAt = now; // it's back: restart the "wait for the option to render" clock
    }

    if (a.phase === "select") {
      const btn = findMatchingOptionButton(container, a.letter);
      if (!btn) {
        if (now - a.startedAt >= CONFIG.OPTION_FIND_TIMEOUT_MS) {
          failAttempt(
            s,
            `Poll detected, but option "${a.letter}" wasn't found.`,
            `Option "${a.letter}" not found in poll markup — site layout may have changed.`
          );
        }
        return;
      }
      clickOption(s, a, btn, now);
      setStatus(`Selected "${a.letter}".`, "ready");

      if (!settings.autoSubmitEnabled) {
        log("Auto-submit is off; leaving submission to the user.");
        resetSelectionAfterPoll(); // one-shot, exactly like a submitted answer
        dropAttempt(s);
        return;
      }
      // Shorten the configured delay if it would run past the poll's real window.
      a.delayMs = Math.min(settings.submitDelayMs, usableMs);
      a.phase = "confirm";
      return; // Submit must wait for the page to register the option — see below
    }

    // If the site re-rendered and replaced the option we clicked, look at the
    // new element: if the page already shows it selected, that's our click
    // carried over; otherwise our selection went with the old node — pick again.
    if (a.optionBtn && !a.optionBtn.isConnected) {
      const fresh = findMatchingOptionButton(container, a.letter);
      if (fresh && isOptionSelected(fresh) === true) {
        a.optionBtn = fresh;
        a.sawSelected = true;
        a.reacted = true;
      } else {
        if (++a.reselects > 3) {
          failAttempt(s, `Selected "${a.letter}", but the poll kept re-rendering.`, "Option element kept getting replaced.");
          return;
        }
        log("Option element was replaced by a re-render; selecting again.");
        a.phase = "select";
        a.startedAt = now;
        return;
      }
    }

    // The page can reset the selection under us (a re-render, a repeated
    // event). If we saw our option selected and it no longer is, select it
    // again — the delay you set keeps counting from the FIRST selection.
    // Only when the page really reports selection state, so a UI that
    // doesn't can never be toggled off by a needless second click.
    const sel = isOptionSelected(a.optionBtn);
    if (sel === true) {
      a.sawSelected = true;
    } else if (sel === false && a.sawSelected) {
      if (++a.reselects > 3) {
        failAttempt(s, `Selected "${a.letter}", but the poll kept resetting it.`, "Selection kept being reset by the page.");
        return;
      }
      log("The page reset the selection; selecting again.");
      clickOption(s, a, a.optionBtn, now);
      a.phase = "confirm";
      return;
    }

    if (a.phase === "confirm") {
      // Don't click Submit until the page has MARKED the option: it either
      // reports it selected, or visibly reacted to our click. (Event-driven —
      // typically a few ms. The cap only keeps a page that shows no sign at all
      // from stalling us.)
      const marked = a.sawSelected || a.reacted;
      if (marked && !a.hopStarted) {
        a.hopStarted = true;
        // One more task so anything else the page queued for this click finishes.
        afterSiteTask(() => {
          a.hopDone = true;
          if (session === s && s.attempt === a) superviseSession();
        }, true);
      }
      if (!(marked && a.hopDone) && now - a.clickedAt < CONFIG.SELECTION_CONFIRM_MS) return;
      stopOptionWatch(a);
      a.phase = "delay";
    }

    if (a.phase === "delay") {
      if (now - a.selectedAt < a.delayMs) return;
      a.phase = "submit";
      a.submitStartedAt = now;
      a.submitTimeoutMs = Math.min(CONFIG.SUBMIT_TIMEOUT_MS, usableMs);
    }

    if (a.phase === "submit") {
      const btn = findSubmitButton(container);
      if (btn && !btn.disabled && btn.getAttribute("aria-disabled") !== "true") {
        btn.click();
        const elapsed = now - a.submitStartedAt;
        const note = elapsed > 60 ? " (waited for Submit to become clickable)" : "";
        setStatus(`Submitted "${a.letter}" in ${elapsed}ms${note}.`, "success");
        s.answered = true;
        dropAttempt(s);
        resetSelectionAfterPoll();
        return;
      }
      if (now - a.submitStartedAt >= a.submitTimeoutMs) {
        failAttempt(
          s,
          `Selected "${a.letter}", but couldn't find/click Submit button.`,
          "Gave up looking for a clickable Submit button after the timeout."
        );
      }
    }
  }

  // The user just armed an answer. If a poll is running right now, act on it
  // immediately (opening the panel if it isn't showing) instead of waiting
  // for the next one.
  function onAnswerArmed() {
    if (!selectedOption) return;
    armedAt = Date.now();
    const s = session;
    if (s && s.state === "live") {
      // Already answered, or its window has passed: the pick is for the next poll.
      if (s.answered || armedAt > s.deadlineAt) return;
      s.userToggled = false; // arming is the user's latest, explicit instruction
      if (s.clicks >= CONFIG.MAX_OPEN_CLICKS) {
        s.clicks = 0;
        s.lastClickAt = 0;
      }
      log("Answer armed while a poll is running — acting on it now.");
      superviseSession();
      return;
    }
    detectDomOnlyPoll();
  }

  // ================= Fallback detection (no WebSocket info) =================
  // A live poll UI is on screen and an answer is armed, but no WebSocket
  // event told us about it (missed frame, socket reconnecting, ...).
  function detectDomOnlyPoll() {
    if (!selectedOption) return;
    if (session && session.state === "live") return;
    // Right after a poll ends the site often shows a results view built from the
    // same markup; give it a moment rather than mistake that for a new poll.
    if (Date.now() - lastEndedAt < CONFIG.POST_POLL_QUIET_MS) return;
    const container = currentPollContainer();
    if (!container) return;
    if (lastUiMark && lastUiMark.node === container && lastUiMark.sig === uiSignature(container)) return; // same UI we already dealt with
    if (!looksLikeLiveVote(container)) return;
    beginSession({ id: `dom-${++sessionSeq}`, meta: null, source: "dom" });
  }

  // ================= Detecting a pending poll via the icon color =================
  // The poll icon's SVG path fill changes from white (#ffffff, idle) to the
  // site's theme color when a poll becomes pending. Important: this color
  // appears to be a persistent "a poll has happened" marker rather than one
  // that resets between polls, so we only act on it actually *changing* to
  // a pending value (an edge), never on it simply remaining pending. This
  // is a fallback signal only — it never clicks anything itself; it just
  // starts a session, and the session decides whether opening is needed.
  function getPollIconFill() {
    try {
      const pollIcon = document.querySelector("#poll-icon");
      const path = pollIcon ? pollIcon.querySelector("svg path") : null;
      if (!path) return null;
      return (path.getAttribute("fill") || "").trim().toLowerCase();
    } catch (err) {
      logError("getPollIconFill failed", err);
      return null;
    }
  }

  function isPendingFillValue(fill) {
    return !!fill && fill !== "#ffffff" && fill !== "white";
  }

  let lastKnownPollIconFill = null; // null = not yet observed
  function checkPollIconFill() {
    const fill = getPollIconFill();
    if (fill === null) return;
    if (lastKnownPollIconFill === null) {
      lastKnownPollIconFill = fill; // first look just establishes the baseline
      return;
    }
    if (fill === lastKnownPollIconFill) return;
    const wasPending = isPendingFillValue(lastKnownPollIconFill);
    lastKnownPollIconFill = fill;
    if (!isPendingFillValue(fill) || wasPending) return; // only a fresh idle -> pending edge counts
    beginSession({ id: `icon-${++sessionSeq}`, meta: null, source: "icon" });
  }

  // A dedicated, narrowly-scoped observer on just the poll icon's own SVG
  // path — cheap to run, and reacts the instant the fill color flips to
  // "pending" without needing to watch attribute changes across the whole
  // page. Re-attaches automatically if the site re-renders the icon as a
  // new DOM node (common in SPA frameworks).
  let pollIconObserver = null;
  let watchedPollIconPath = null;
  function ensurePollIconWatched() {
    try {
      const pollIcon = document.querySelector("#poll-icon");
      const path = pollIcon ? pollIcon.querySelector("svg path") : null;
      if (!path || path === watchedPollIconPath) return;
      if (pollIconObserver) pollIconObserver.disconnect();
      pollIconObserver = new MutationObserver(() => {
        checkPollIconFill();
      });
      pollIconObserver.observe(path, { attributes: true, attributeFilter: ["fill"] });
      watchedPollIconPath = path;
      log("Now watching poll icon for pending-color changes.");
    } catch (err) {
      logError("ensurePollIconWatched failed", err);
    }
  }

  // If the user clicks the poll icon themselves, they're driving the panel —
  // from then on this poll, we never click it for them (unless they arm an
  // answer, which is an explicit request; see onAnswerArmed).
  document.addEventListener(
    "click",
    (e) => {
      if (!e.isTrusted || !session || session.state === "ended") return;
      const t = e.target;
      if (t && t.closest && t.closest("#poll-icon")) session.userToggled = true;
    },
    true
  );

  // Could this batch of DOM changes involve the poll UI? Chat messages and
  // other page noise never add buttons/inputs, so they don't warrant an
  // immediate re-check (the per-frame loop still covers everything else).
  function mutationsRelevant(records) {
    try {
      const container = scanCache.node;
      for (const r of records) {
        if (r.type === "attributes") return true; // only "disabled" is observed
        for (const n of r.addedNodes) {
          if (n.nodeType === 1 && (n.matches("button, input") || n.querySelector("button, input"))) return true;
        }
        for (const n of r.removedNodes) {
          if (n.nodeType !== 1) continue;
          if (container && (n === container || n.contains(container))) return true;
          if (n.matches("button, input") || n.querySelector("button, input")) return true;
        }
      }
    } catch (_e) {
      return true; // when in doubt, check
    }
    return false;
  }

  // ================= Main observer loop =================
  // Poll Assist only operates on live classes (identified by the
  // presence of #poll-icon). Recorded classes have no reliable anchor
  // for correct on-screen positioning — after trying several fallback
  // selectors that didn't hold up across different page layouts, this is
  // now simply out of scope rather than a half-working feature.
  //
  // Once we've confirmed we're in a live class (seen the icon at least
  // once), that determination sticks for the rest of the page's life —
  // a momentary absence (the site's own framework re-rendering the
  // toolbar mid-frame, which briefly removes and re-adds elements, is
  // common) must never tear the button down and rebuild it. Only an
  // icon that's *never once* appeared within the initial grace window
  // is treated as "this is a recorded class."
  let everSawPollIcon = false;

  function tick() {
    if (destroyed) return;

    const pollIconExists = !!document.querySelector("#poll-icon");
    if (pollIconExists) everSawPollIcon = true;

    if (!everSawPollIcon) {
      const gracePassed = Date.now() - scriptStartTime > CONFIG.TOOLBAR_WAIT_MS;
      if (!gracePassed) return; // still within the initial grace window — keep waiting

      // Never saw the icon at all within the grace window — recorded
      // class. Tear down anything that might exist and stay inactive.
      if (answerWrapRef && document.body.contains(answerWrapRef)) {
        answerWrapRef.remove();
        log("No live poll icon found on this page — Poll Assist is inactive here.");
      }
      answerWrapRef = null;
      iconRef = null;
      const dropdownEl = document.getElementById("pw-answer-dropdown");
      if (dropdownEl) dropdownEl.remove();
      dropdownRef = null;
      return;
    }

    ensureButtonExists();
    ensurePollIconWatched();
    checkPollIconFill();
    detectDomOnlyPoll();
  }

  // Coalesces potentially-many MutationObserver callbacks (a busy SPA can
  // batch-fire several in a single frame) into at most one tick() per
  // animation frame, avoiding redundant full-page scans without adding
  // any perceptible detection latency.
  let tickScheduled = false;
  function scheduleTick() {
    if (tickScheduled) return;
    tickScheduled = true;
    nextFrame(() => {
      tickScheduled = false;
      tick();
    });
  }

  function start() {
    loadSettings();

    try {
      observer = new MutationObserver((records) => {
        domDirty = true;
        // While a poll is being worked on, react at once (this callback runs
        // right after the DOM change) instead of waiting for the next frame.
        if (session && session.state === "live" && mutationsRelevant(records)) {
          try {
            superviseSession();
          } catch (err) {
            logError("superviseSession failed", err);
          }
        }
        scheduleTick();
      });
      // Broad attribute watching across the whole page would be
      // expensive (lots of unrelated elements churn class/style
      // attributes). Poll-container detection only needs childList
      // changes; the poll icon's own fill-color change is watched
      // separately by a narrowly-scoped observer (see
      // ensurePollIconWatched) for a cheap, instant reaction instead.
      // "disabled" is watched too so a Submit button that becomes enabled is
      // clicked the moment it does. (Watching class/style would be far too noisy.)
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    } catch (err) {
      logError("Failed to start MutationObserver", err);
    }

    // 500ms rather than 1000ms so the pending-poll color change (and any
    // SPA re-renders the MutationObserver misses) gets picked up promptly.
    injectPollId = setInterval(tick, 500);
    // Coming back to a tab that sat in the background: catch up immediately.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) {
        domDirty = true;
        scheduleTick();
      }
    });
    tick();

    trackingRafId = requestAnimationFrame(trackPosition);
    log("Started.");
  }

  function destroy() {
    destroyed = true;
    try {
      if (observer) observer.disconnect();
    } catch (err) {
      logError("Error disconnecting observer", err);
    }
    try {
      if (pollIconObserver) pollIconObserver.disconnect();
    } catch (err) {
      logError("Error disconnecting poll-icon observer", err);
    }
    if (injectPollId) clearInterval(injectPollId);
    if (trackingRafId) cancelAnimationFrame(trackingRafId);
    log("Cleaned up.");
  }

  // ================= WebSocket-driven poll detection =================
  // PW.live's live-class socket (central-socket.penpencil.co) sends a
  // real, unambiguous event the instant a poll starts:
  //   "poll {"operation":"start","pollId":"...","data":{...}}"
  // and a corresponding "stop_expiry" event as it's about to close. This
  // is far more reliable than watching for DOM/color changes — it fires
  // fresh for every single poll, not just the first. It starts a poll
  // session; the DOM-based color-change detection above stays in place as
  // a fallback for when a frame is ever missed.
  function parseWSFrame(raw) {
    if (typeof raw !== "string") return null;
    const spaceIdx = raw.indexOf(" ");
    if (spaceIdx === -1) {
      try {
        return { topic: null, payload: JSON.parse(raw) };
      } catch (_e) {
        return null;
      }
    }
    const topic = raw.slice(0, spaceIdx);
    const jsonPart = raw.slice(spaceIdx + 1);
    try {
      return { topic, payload: JSON.parse(jsonPart) };
    } catch (_e) {
      return null;
    }
  }

  function handlePollSocketPayload(payload) {
    if (!payload || typeof payload !== "object") return;
    const op = payload.operation;
    const pollId = payload.pollId || (payload.data && payload.data.pollId);

    if (op === "start") {
      if (pollId && handledPollStartIds.has(pollId)) return; // duplicate delivery of the same event
      if (pollId) {
        handledPollStartIds.add(pollId);
        // Simple unbounded-growth guard for very long sessions.
        if (handledPollStartIds.size > 200) {
          const oldest = handledPollStartIds.values().next().value;
          handledPollStartIds.delete(oldest);
        }
      }

      const data = (payload && payload.data) || {};
      const realOptions = Array.isArray(data.pollOptions)
        ? data.pollOptions
            .map((o) => (o && typeof o.optionLabel === "string" ? o.optionLabel.trim().toUpperCase() : null))
            .filter(Boolean)
        : null;
      const durationMs = typeof data.expiryDuration === "number" && data.expiryDuration > 0 ? data.expiryDuration * 1000 : null;
      const meta = { pollId: pollId || null, options: realOptions, durationMs };
      log("Captured real poll metadata from WebSocket:", meta);

      beginSession({ id: pollId || `ws-${++sessionSeq}`, meta, source: "ws" });
    } else if (op === "stop_expiry" || op === "stop" || op === "end") {
      log("WebSocket: poll", pollId || "(unknown id)", "is stopping/ending — operation:", op);
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.__pwPollAssistWS !== true) return;

    if (settings.debug) {
      console.log(
        `%c[PW Poll Assist][WS ${msg.direction}]`,
        "color:#34d399;font-weight:bold;",
        msg.url,
        msg.data
      );
    }

    const parsed = parseWSFrame(msg.data);
    if (parsed && parsed.topic === "poll") {
      handlePollSocketPayload(parsed.payload);
    }
  });

  // Only tear down on a real unload. `beforeunload` is NOT one: it also fires
  // when the user cancels a "leave this page?" prompt (or starts a download /
  // mailto: navigation), after which the page carries on — and the extension,
  // having destroyed itself, silently stopped working until a reload.
  window.addEventListener("pagehide", (e) => {
    if (!e.persisted) destroy();
  });

  start();
})();

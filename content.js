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
    AUTO_OPEN_RETRY_MS: 1200, // cooldown between click retries while a poll is pending but not yet open
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
  // Real metadata from the confirmed WebSocket poll_start payload, e.g.:
  //   {"operation":"start","pollId":"...","data":{"type":"SINGLE",
  //    "expiryDuration":30,"pollStartTime":1788411108,
  //    "pollOptions":[{"optionLabel":"A",...}, ...]}}
  // Captured once per poll and used to make detection/submission
  // decisions based on the site's own authoritative data instead of
  // assumptions — cleared whenever the corresponding DOM poll container
  // disappears (see watchForPollGone) so it can never bleed into a
  // later poll if a future "start" event were ever missed.
  let currentPollMeta = null;
  let lastHandledPollNode = null;
  let answerWrapRef = null;
  let dropdownRef = null;
  let iconRef = null;
  let observer = null;
  let pollGoneIntervalId = null;
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
    if (!dropdownRef) return;
    if (answerWrapRef && answerWrapRef.contains(e.target)) return;
    if (dropdownRef.contains(e.target)) return;
    dropdownRef.classList.remove("pw-open");
  });

  window.addEventListener("resize", () => {
    if (dropdownRef && dropdownRef.classList.contains("pw-open")) positionDropdown();
  });

  // ================= Poll detection =================
  function findPollContainer() {
    try {
      const spans = document.querySelectorAll("span");
      for (const h of spans) {
        const text = h.textContent && h.textContent.trim().toLowerCase();
        if (text && text.includes(CONFIG.POLL_HEADING_MATCH)) {
          let node = h;
          for (let i = 0; i < 8 && node; i++) {
            if (node.querySelectorAll && node.querySelectorAll('input[type="radio"]').length > 0) {
              return node;
            }
            node = node.parentElement;
          }
        }
      }
    } catch (err) {
      logError("findPollContainer failed", err);
    }
    return null;
  }

  function findMatchingOptionButton(container, letter) {
    if (!letter) return null;
    try {
      const buttons = container.querySelectorAll("button");
      for (const btn of buttons) {
        const spans = btn.querySelectorAll("span");
        for (const s of spans) {
          if (s.textContent && s.textContent.trim().toUpperCase() === letter.toUpperCase()) {
            return btn;
          }
        }
      }
    } catch (err) {
      logError("findMatchingOptionButton failed", err);
    }
    return null;
  }

  // Same caching idea as makeSubmitButtonFinder — avoids re-scanning the
  // poll container's buttons on every animation frame once the target
  // option button has already been located once.
  function makeOptionButtonFinder(container, letter) {
    let cached = null;
    return function findOptionButtonCached() {
      if (cached && document.body.contains(cached)) return cached;
      cached = findMatchingOptionButton(container, letter);
      return cached;
    };
  }

  function findSubmitButton() {
    try {
      const buttons = document.querySelectorAll("button");
      for (const b of buttons) {
        if (b.textContent && b.textContent.trim().toLowerCase().includes("submit")) {
          return b;
        }
      }
    } catch (err) {
      logError("findSubmitButton failed", err);
    }
    return null;
  }

  // Wraps findSubmitButton() with a cache: once the button element is
  // located, subsequent checks just read its .disabled property directly
  // instead of re-scanning every button on the page on every animation
  // frame for up to SUBMIT_TIMEOUT_MS. Falls back to a fresh scan if the
  // cached element ever gets removed from the page.
  function makeSubmitButtonFinder() {
    let cached = null;
    return function findSubmitButtonCached() {
      if (cached && document.body.contains(cached)) {
        return !cached.disabled ? cached : null;
      }
      cached = findSubmitButton();
      return cached && !cached.disabled ? cached : null;
    };
  }

  // Generic rAF-driven polling helper: checks `checkFn()` every animation
  // frame (much lower latency than a fixed setTimeout interval) until it
  // returns a truthy value or `timeoutMs` elapses.
  function pollUntil(checkFn, timeoutMs, onSuccess, onTimeout) {
    const startedAt = Date.now();
    function frame() {
      let result;
      try {
        result = checkFn();
      } catch (err) {
        logError("pollUntil checkFn failed", err);
        result = null;
      }
      if (result) {
        onSuccess(result, Date.now() - startedAt);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        onTimeout(Date.now() - startedAt);
        return;
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function handlePoll(container) {
    try {
      // If this exact poll (by its real, unique ID from the WebSocket
      // event) has already been successfully answered, don't process it
      // again — a re-detected container for the same poll is most likely
      // a results/confirmation view, not a new question.
      if (currentPollMeta && currentPollMeta.pollId && consumedPollIds.has(currentPollMeta.pollId)) {
        log(`Poll ${currentPollMeta.pollId} was already answered — ignoring re-detected container.`);
        return;
      }

      if (!selectedOption) {
        setStatus("Poll detected, but no option was pre-selected!", "warning");
        warn("Poll appeared with no pre-selected option.");
        return;
      }

      // If the WebSocket poll_start event gave us this poll's real
      // option list, check the armed answer against it immediately.
      // This is the site's own authoritative data (not a DOM guess), so
      // a mismatch here means the armed answer genuinely isn't valid for
      // this poll — no reason to waste the OPTION_FIND_TIMEOUT_MS window
      // searching the DOM for something that can't exist.
      if (currentPollMeta && Array.isArray(currentPollMeta.options) && currentPollMeta.options.length > 0) {
        const normalized = selectedOption.toUpperCase();
        if (!currentPollMeta.options.includes(normalized)) {
          setStatus(
            `Armed answer "${selectedOption}" isn't one of this poll's options (${currentPollMeta.options.join(", ")}).`,
            "warning"
          );
          warn(`Selected option "${selectedOption}" isn't in this poll's real option list:`, currentPollMeta.options);
          resetSelectionAfterPoll();
          return;
        }
      }

      // The WebSocket payload also gives us this poll's real,
      // authoritative deadline (pollStartTime + expiryDuration). Use it
      // to make sure we never attempt to click Submit after the poll has
      // actually closed, and to shorten the configured delay/timeout if
      // they'd otherwise run past it — rather than blindly trusting
      // settings.submitDelayMs regardless of how much real time is left.
      let effectiveSubmitDelayMs = settings.submitDelayMs;
      let effectiveSubmitTimeoutMs = CONFIG.SUBMIT_TIMEOUT_MS;
      if (currentPollMeta && typeof currentPollMeta.deadlineMs === "number") {
        const realRemainingMs = currentPollMeta.deadlineMs - Date.now();
        if (realRemainingMs <= 0) {
          setStatus("This poll has already expired (per its real timing) — not attempting to submit.", "warning");
          warn("Poll deadline (from WebSocket-reported expiry) has already passed; skipping.");
          resetSelectionAfterPoll();
          return;
        }
        const safetyMarginMs = 300; // leave room for the click itself to land
        const usableWindowMs = Math.max(0, realRemainingMs - safetyMarginMs);
        if (effectiveSubmitDelayMs > usableWindowMs) {
          log(
            `Configured delay (${effectiveSubmitDelayMs}ms) exceeds this poll's real remaining time ` +
              `(${realRemainingMs}ms) — shortening to fit.`
          );
          effectiveSubmitDelayMs = usableWindowMs;
        }
        effectiveSubmitTimeoutMs = Math.min(effectiveSubmitTimeoutMs, usableWindowMs);
      }

      // The poll's heading can render an instant before its option
      // buttons do, so give it a brief window (checked every frame, not
      // on a slow fixed interval) rather than failing on the very first
      // look.
      pollUntil(
        makeOptionButtonFinder(container, selectedOption),
        CONFIG.OPTION_FIND_TIMEOUT_MS,
        (optionBtn) => {
          optionBtn.click();
          setStatus(`Selected "${selectedOption}".`, "ready");

          if (!settings.autoSubmitEnabled) {
            log("Auto-submit is off; leaving submission to the user.");
            return;
          }

          setTimeout(() => {
            const submitStartedAt = Date.now();
            const findSubmitReady = makeSubmitButtonFinder();
            pollUntil(
              findSubmitReady,
              effectiveSubmitTimeoutMs,
              (submitBtn) => {
                submitBtn.click();
                const elapsed = Date.now() - submitStartedAt;
                const note = elapsed > 60 ? " (waited for Submit to become clickable)" : "";
                setStatus(`Submitted "${selectedOption}" in ${elapsed}ms${note}.`, "success");
                if (currentPollMeta && currentPollMeta.pollId) {
                  consumedPollIds.add(currentPollMeta.pollId);
                  if (consumedPollIds.size > 200) {
                    const oldest = consumedPollIds.values().next().value;
                    consumedPollIds.delete(oldest);
                  }
                }
                resetSelectionAfterPoll();
              },
              () => {
                setStatus(`Selected "${selectedOption}", but couldn't find/click Submit button.`, "warning");
                warn("Gave up looking for a clickable Submit button after the timeout.");
                resetSelectionAfterPoll();
              }
            );
          }, effectiveSubmitDelayMs);
        },
        () => {
          setStatus(`Poll detected, but option "${selectedOption}" wasn't found.`, "warning");
          warn(`Option "${selectedOption}" not found in poll markup — site layout may have changed.`);
          // Clear the stale selection rather than leaving it armed — this
          // poll is a lost cause either way (it won't be retried; see
          // lastHandledPollNode), and leaving an old answer "armed" risks
          // it silently getting applied to a completely different,
          // unrelated poll that appears next if the user forgets to
          // re-pick.
          resetSelectionAfterPoll();
        }
      );
    } catch (err) {
      logError("handlePoll failed", err);
      setStatus("Something went wrong handling this poll — check the console.", "warning");
      resetSelectionAfterPoll();
    }
  }

  function watchForPollGone(container) {
    if (pollGoneIntervalId) clearInterval(pollGoneIntervalId);
    pollGoneIntervalId = setInterval(() => {
      if (!document.body.contains(container)) {
        lastHandledPollNode = null;
        // Deliberately NOT clearing currentPollMeta here. If the site
        // replaces the voting container with a different DOM node for a
        // results/confirmation view of the *same* poll, this container
        // is correctly detected as "gone" — but currentPollMeta.pollId
        // needs to stay valid past that moment for the
        // consumedPollIds check in handlePoll() to recognize that
        // re-rendered node as the same already-answered poll, not a new
        // one. currentPollMeta is only ever overwritten by a genuinely
        // new WebSocket poll_start event (see handlePollSocketPayload),
        // which is the correct trigger for "this is really a new poll."
        clearInterval(pollGoneIntervalId);
        pollGoneIntervalId = null;
        log("Poll node removed from DOM; ready for the next one.");
      }
    }, CONFIG.POLL_GONE_CHECK_MS);
  }

  // ================= Detecting a pending poll (event-driven) =================
  // The poll icon's SVG path fill changes from white (#ffffff, idle) to
  // the site's theme color (var(--primary)) when a poll becomes pending.
  // Important: this color appears to be a persistent "a poll has
  // happened" marker rather than one that resets between polls, so we
  // can't just check "is it currently colored" (that stays true for the
  // rest of the class after the first poll and would cause continuous
  // re-clicking). Instead we track the raw value and only act on it
  // actually *changing* to a pending value (an edge), never on it simply
  // remaining pending.
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
  let lastAutoOpenAttempt = 0;
  function maybeAutoOpenPollPanel() {
    if (!settings.autoOpenPollPanel) return;
    if (findPollContainer()) return; // already open — never toggle it closed
    try {
      const fill = getPollIconFill();
      if (fill === null) return; // icon not present yet

      if (fill === lastKnownPollIconFill) return; // no change — nothing to do

      const wasPending = isPendingFillValue(lastKnownPollIconFill);
      const isPendingNow = isPendingFillValue(fill);
      lastKnownPollIconFill = fill;

      if (!isPendingNow || wasPending) return; // only act on a fresh 0→1 transition

      const now = Date.now();
      if (now - lastAutoOpenAttempt < CONFIG.AUTO_OPEN_RETRY_MS) return;
      lastAutoOpenAttempt = now;

      const pollIcon = document.querySelector("#poll-icon");
      if (!pollIcon) return;
      pollIcon.click();
      log("Poll icon just switched to its pending color — clicked it to open the panel.");
    } catch (err) {
      logError("maybeAutoOpenPollPanel failed", err);
    }
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
        maybeAutoOpenPollPanel();
      });
      pollIconObserver.observe(path, { attributes: true, attributeFilter: ["fill"] });
      watchedPollIconPath = path;
      log("Now watching poll icon for pending-color changes.");
    } catch (err) {
      logError("ensurePollIconWatched failed", err);
    }
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

    const container = findPollContainer();
    if (container && container !== lastHandledPollNode) {
      lastHandledPollNode = container;
      log("New poll detected.");
      handlePoll(container);
      watchForPollGone(container);
    } else if (!container) {
      maybeAutoOpenPollPanel();
    }
  }

  // Coalesces potentially-many MutationObserver callbacks (a busy SPA can
  // batch-fire several in a single frame) into at most one tick() per
  // animation frame, avoiding redundant full-page scans without adding
  // any perceptible detection latency.
  let tickScheduled = false;
  function scheduleTick() {
    if (tickScheduled) return;
    tickScheduled = true;
    requestAnimationFrame(() => {
      tickScheduled = false;
      tick();
    });
  }

  function start() {
    loadSettings();

    try {
      observer = new MutationObserver(scheduleTick);
      // Broad attribute watching across the whole page would be
      // expensive (lots of unrelated elements churn class/style
      // attributes). Poll-container detection only needs childList
      // changes; the poll icon's own fill-color change is watched
      // separately by a narrowly-scoped observer (see
      // ensurePollIconWatched) for a cheap, instant reaction instead.
      observer.observe(document.documentElement, { childList: true, subtree: true });
    } catch (err) {
      logError("Failed to start MutationObserver", err);
    }

    // 500ms rather than 1000ms so the pending-poll color change (and any
    // SPA re-renders the MutationObserver misses) gets picked up promptly.
    injectPollId = setInterval(tick, 500);
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
    if (pollGoneIntervalId) clearInterval(pollGoneIntervalId);
    if (trackingRafId) cancelAnimationFrame(trackingRafId);
    log("Cleaned up.");
  }

  // ================= WebSocket-driven poll detection =================
  // PW.live's live-class socket (central-socket.penpencil.co) sends a
  // real, unambiguous event the instant a poll starts:
  //   "poll {"operation":"start","pollId":"...","data":{...}}"
  // and a corresponding "stop_expiry" event as it's about to close. This
  // is far more reliable than watching for DOM/color changes — it fires
  // fresh for every single poll, not just the first. When available
  // (live classes), it's used to trigger opening the poll panel
  // immediately; the DOM-based color-change detection stays in place as
  // a fallback for contexts without this socket (e.g. recorded classes).
  const handledPollStartIds = new Set();
  // Tracks poll IDs we've successfully selected+submitted an answer for.
  // Unlike lastHandledPollNode (which is tied to a specific DOM node
  // reference and reset once that node is removed), this is identity-
  // based and durable — it stays valid even if the site re-renders the
  // same poll into a different DOM subtree afterward (e.g. a results or
  // "your answer was recorded" view), preventing that from being
  // mistaken for a brand new poll to answer.
  const consumedPollIds = new Set();

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

  function openPollPanelNow(reason) {
    if (!settings.autoOpenPollPanel) return;
    // Deliberately no "is a poll already open" check here, unlike
    // maybeAutoOpenPollPanel below. This path only ever runs in response
    // to a WebSocket poll_start event for a specific, unique pollId
    // (deduped via handledPollStartIds — see handlePollSocketPayload),
    // which is a far stronger and more precise signal than "does some
    // poll-shaped DOM node currently exist." That looser DOM check was
    // tried here previously and caused false positives: if the
    // *previous* poll's container lingers in the DOM for a moment after
    // it ends (e.g. showing a brief results state) right as a new poll's
    // start event arrives, it would look like "already open" and the
    // click would be silently skipped — leaving the new poll unopened
    // until manually clicked.
    try {
      const pollIcon = document.querySelector("#poll-icon");
      if (!pollIcon) return;
      pollIcon.click();
      log("Clicked poll icon —", reason);
    } catch (err) {
      logError("openPollPanelNow failed", err);
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
      let deadlineMs = null;
      if (typeof data.pollStartTime === "number" && typeof data.expiryDuration === "number") {
        deadlineMs = (data.pollStartTime + data.expiryDuration) * 1000;
      }
      currentPollMeta = { pollId: pollId || null, options: realOptions, deadlineMs };
      log("Captured real poll metadata from WebSocket:", currentPollMeta);

      openPollPanelNow(`WebSocket confirmed poll ${pollId || "(unknown id)"} started`);
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

  window.addEventListener("pagehide", destroy);
  window.addEventListener("beforeunload", destroy);

  start();
})();

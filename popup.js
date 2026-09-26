(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    autoSubmitEnabled: true,
    submitDelayMs: 150,
    debug: false,
    hideWithPlayerControls: true,
    autoOpenPollPanel: true,
  };

  const autoSubmitEl = document.getElementById("autoSubmitEnabled");
  const submitDelayEl = document.getElementById("submitDelay"); // in seconds, 0-5
  const submitDelayNumberEl = document.getElementById("submitDelayNumber"); // in seconds, 0-60
  const hideWithPlayerControlsEl = document.getElementById("hideWithPlayerControls");
  const autoOpenPollPanelEl = document.getElementById("autoOpenPollPanel");
  const debugEl = document.getElementById("debug");
  const resetBtn = document.getElementById("resetBtn");
  const statusEl = document.getElementById("statusMsg");
  const versionBadgeEl = document.getElementById("versionBadge");

  // Single source of truth for the version display — read from the
  // manifest instead of a hardcoded string that has to be kept in sync
  // by hand (see the matching note in content.js's buildDropdown()).
  try {
    if (versionBadgeEl) versionBadgeEl.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch (err) {
    console.error("Couldn't read extension version", err);
  }

  // Settings are stored internally as milliseconds (submitDelayMs) so the
  // content script's timing logic doesn't need to care about display
  // units. The popup UI works in seconds for readability, converting at
  // the boundary.
  function clampDelayMs(ms) {
    const n = Number(ms);
    if (Number.isNaN(n)) return DEFAULT_SETTINGS.submitDelayMs;
    return Math.min(60000, Math.max(0, Math.round(n)));
  }

  function msToSeconds(ms) {
    return Math.round(ms) / 1000;
  }

  function secondsToMs(seconds) {
    const n = Number(seconds);
    if (Number.isNaN(n)) return DEFAULT_SETTINGS.submitDelayMs;
    return clampDelayMs(n * 1000);
  }

  // The slider's filled-in-accent-color portion is drawn via a --pct
  // custom property consumed by a CSS linear-gradient (see popup.css) —
  // range inputs have no native concept of "filled up to here", so this
  // has to be kept in sync in JS whenever the value changes.
  function updateSliderFill() {
    const min = Number(submitDelayEl.min) || 0;
    const max = Number(submitDelayEl.max) || 1;
    const val = Number(submitDelayEl.value);
    const pct = ((val - min) / (max - min)) * 100;
    submitDelayEl.style.setProperty("--pct", `${pct}%`);
  }

  function applyToForm(settings) {
    autoSubmitEl.checked = settings.autoSubmitEnabled;
    const delayMs = clampDelayMs(settings.submitDelayMs);
    const delaySeconds = msToSeconds(delayMs);
    // Slider only goes to 5s; clamp its displayed value but let the
    // number input show the true value even if it's higher.
    submitDelayEl.value = Math.min(delaySeconds, 5);
    submitDelayNumberEl.value = delaySeconds;
    updateSliderFill();
    hideWithPlayerControlsEl.checked = settings.hideWithPlayerControls;
    autoOpenPollPanelEl.checked = settings.autoOpenPollPanel;
    debugEl.checked = settings.debug;
  }

  function showSaved() {
    statusEl.textContent = "Saved";
    statusEl.classList.remove("error");
    statusEl.classList.add("visible");
    clearTimeout(showSaved._t);
    showSaved._t = setTimeout(() => {
      statusEl.classList.remove("visible");
    }, 1200);
  }

  function saveField(patch) {
    try {
      chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (result) => {
        const merged = Object.assign({}, DEFAULT_SETTINGS, result.settings, patch);
        chrome.storage.local.set({ settings: merged }, () => {
          if (chrome.runtime.lastError) {
            statusEl.textContent = "Couldn't save settings.";
            statusEl.classList.add("visible", "error");
            console.error(chrome.runtime.lastError);
            return;
          }
          showSaved();
        });
      });
    } catch (err) {
      statusEl.textContent = "Couldn't save settings.";
      statusEl.classList.add("visible", "error");
      console.error(err);
    }
  }

  // Load current settings on open.
  try {
    chrome.storage.local.get({ settings: DEFAULT_SETTINGS }, (result) => {
      applyToForm(Object.assign({}, DEFAULT_SETTINGS, result.settings));
    });
  } catch (err) {
    applyToForm(DEFAULT_SETTINGS);
    console.error(err);
  }

  autoSubmitEl.addEventListener("change", () => {
    saveField({ autoSubmitEnabled: autoSubmitEl.checked });
  });

  // Slider drives the number input live as you drag (both in seconds)...
  submitDelayEl.addEventListener("input", () => {
    submitDelayNumberEl.value = submitDelayEl.value;
    updateSliderFill();
  });
  submitDelayEl.addEventListener("change", () => {
    saveField({ submitDelayMs: secondsToMs(submitDelayEl.value) });
  });

  // ...and the number input lets you type an exact value, including
  // fractional seconds like 1.2, and beyond the slider's 5s max if
  // someone really wants a longer delay.
  submitDelayNumberEl.addEventListener("input", () => {
    const seconds = Number(submitDelayNumberEl.value);
    if (!Number.isNaN(seconds) && seconds <= 5) {
      submitDelayEl.value = seconds;
      updateSliderFill();
    }
  });
  submitDelayNumberEl.addEventListener("change", () => {
    const ms = secondsToMs(submitDelayNumberEl.value);
    const seconds = msToSeconds(ms);
    submitDelayNumberEl.value = seconds;
    if (seconds <= 5) submitDelayEl.value = seconds;
    updateSliderFill();
    saveField({ submitDelayMs: ms });
  });

  hideWithPlayerControlsEl.addEventListener("change", () => {
    saveField({ hideWithPlayerControls: hideWithPlayerControlsEl.checked });
  });

  autoOpenPollPanelEl.addEventListener("change", () => {
    saveField({ autoOpenPollPanel: autoOpenPollPanelEl.checked });
  });

  debugEl.addEventListener("change", () => {
    saveField({ debug: debugEl.checked });
  });

  resetBtn.addEventListener("click", () => {
    applyToForm(DEFAULT_SETTINGS);
    try {
      chrome.storage.local.set({ settings: DEFAULT_SETTINGS }, () => showSaved());
    } catch (err) {
      console.error(err);
    }
  });
})();

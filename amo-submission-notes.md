# Firefox Add-on (AMO) submission notes

Reference copy for the "Version notes" and "Notes to Reviewer" fields when
submitting to addons.mozilla.org. Paste the relevant block into the form.

## Version notes (v3.3)

Rebuilt the delay slider as a fully custom control with a live-filling track and
spec-chip value readout. No functional changes to poll detection or submission
logic in this release — UI polish only.

Full version history is documented in README.md.

## Notes to Reviewer

This extension does not require a user account or login of any kind. It runs
entirely on pw.live class pages and needs no credentials to test — the poll
detection and auto-submit UI are visible as soon as a live class page loads.

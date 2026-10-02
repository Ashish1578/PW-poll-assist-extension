# Firefox Add-on (AMO) submission notes

Reference copy for the "Version notes" and "Notes to Reviewer" fields when
submitting to addons.mozilla.org. Paste the relevant block into the form.

## Version notes (v3.5.2)

Bug-fix release for poll detection and submission. The poll panel could fail to
open, or be closed again, when a poll started (the site's poll icon is a toggle
and two code paths could each click it). Poll handling is now a single state
machine that clicks the icon only when the poll isn't already showing. An
answer picked while a poll is already running is now applied immediately.
Also fixed: choosing the wrong "Submit" button on pages with several; polls
skipped because of client/server clock skew; a deselected or changed answer
still being submitted after the delay; a stale answer staying armed for the
next poll; the extension disabling itself after a cancelled "leave page?"
prompt; stalling while the tab is in the background; and high idle CPU use on
busy pages. No artificial delays are introduced: the only wait is the user-set
"Delay before submitting", and 0 means Submit follows as soon as the page has
registered the selected option (it is never clicked before that). Work is now
triggered directly by DOM changes.

Change to the MAIN-world WebSocket hook (websocket-hook.js): frames delivered
as Blob objects (the WebSocket default when binaryType is unchanged) were
previously ignored. The hook now reads only the first 16 bytes of such a frame
to apply the same `poll {` prefix filter as for text frames, and reads the rest
only if that prefix matches. Non-poll frames are still never inspected,
stored, or forwarded. No new permissions.

Full version history is documented in README.md.

## Notes to Reviewer

This extension does not require a user account or login of any kind. It runs
entirely on pw.live class pages and needs no credentials to test — the poll
detection and auto-submit UI are visible as soon as a live class page loads.

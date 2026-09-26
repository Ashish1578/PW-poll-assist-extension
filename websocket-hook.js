/**
 * PW Live Poll Auto-Submit — WebSocket instrumentation
 *
 * Runs in the page's OWN JavaScript context (world: "MAIN", document_start)
 * so it can wrap the native WebSocket constructor before the site opens any
 * connections, letting the extension react to real poll-start/stop events
 * in real time (see README's "Real-time poll detection" section).
 *
 * Privacy posture — read this before changing the filter below:
 * - This never modifies or blocks any traffic; every original send/receive
 *   still happens exactly as the page intended. It only *observes*.
 * - Only frames matching the known PW.live poll-protocol shape
 *   (`poll {...}` — see below) are ever touched. Chat, video telemetry,
 *   and anything else on the socket is never inspected or forwarded.
 * - The connection URL contains the user's session auth token as a query
 *   parameter. That token is stripped out before the URL is used for
 *   anything (including debug logs) — this script has no use for it and
 *   there's no reason to expose it, even locally.
 * - Communication with the isolated content script uses window.postMessage
 *   because MAIN-world scripts have no access to chrome.* extension APIs.
 *   That channel is visible to any other script sharing this page's
 *   window (the site itself, or other extensions), which is exactly why
 *   the filter below is kept as narrow as possible — only the specific
 *   poll-protocol frames it needs, nothing broader.
 * - Nothing this script touches is ever sent anywhere over the network by
 *   the extension; it only relays to the content script running on this
 *   same page, which acts on it locally (see content.js).
 */
(function () {
  "use strict";

  if (window.__pwPollAssistWSHooked) return;
  window.__pwPollAssistWSHooked = true;

  const NativeWebSocket = window.WebSocket;
  if (!NativeWebSocket) return;

  // Matches PW.live's actual poll-protocol frames, e.g.:
  //   poll {"operation":"start","pollId":"...",...}
  // Deliberately specific (not a loose "mentions poll" match) so chat
  // messages or other traffic that merely contain the word "poll" are
  // never touched, inspected, or forwarded.
  const POLL_FRAME_PATTERN = /^poll\s*\{/i;

  function redactUrl(url) {
    try {
      const u = new URL(url, window.location.href);
      if (u.searchParams.has("token")) {
        u.searchParams.set("token", "[redacted]");
      }
      return u.toString();
    } catch (_err) {
      // If url isn't a normal absolute URL for some reason, fall back to
      // a blunt redaction rather than risk leaking it unredacted.
      return typeof url === "string" ? url.replace(/token=[^&]*/i, "token=[redacted]") : "[unknown url]";
    }
  }

  function forward(direction, url, data) {
    try {
      let text = null;
      if (typeof data === "string") {
        text = data;
      } else if (data instanceof ArrayBuffer) {
        try {
          text = new TextDecoder("utf-8").decode(data);
        } catch (_e) {
          text = null;
        }
      } else {
        // Blob payloads would need async reading — skip; PW.live's poll
        // protocol frames observed so far are plain text, not Blobs.
        return;
      }
      if (!text || !POLL_FRAME_PATTERN.test(text)) return;

      window.postMessage(
        {
          __pwPollAssistWS: true,
          direction, // "send" | "receive"
          url: redactUrl(url),
          data: text,
          ts: Date.now(),
        },
        "*"
      );
    } catch (_err) {
      // Never let instrumentation errors affect the page's real socket.
    }
  }

  // Use a Proxy over the constructor so `instanceof WebSocket` and static
  // properties (WebSocket.OPEN, etc.) keep working exactly as the page
  // expects — we're only adding a listener + wrapping send(), not
  // replacing the object itself.
  const WSProxy = new Proxy(NativeWebSocket, {
    construct(target, args) {
      const ws = Reflect.construct(target, args);
      const url = args[0];

      ws.addEventListener("message", (event) => {
        forward("receive", url, event.data);
      });

      const originalSend = ws.send.bind(ws);
      ws.send = function (data) {
        forward("send", url, data);
        return originalSend(data);
      };

      return ws;
    },
  });

  window.WebSocket = WSProxy;
})();

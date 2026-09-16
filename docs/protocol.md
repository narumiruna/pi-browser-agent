# Bridge Protocol

## Transport and framing

The Chrome service worker connects to `ws://127.0.0.1:<port>`. Each WebSocket message contains one UTF-8 JSON object. The maximum frame size is 4 MiB. Unknown frame types, non-JSON values, excessive nesting, dangerous prototype keys, and schema mismatches are rejected.

The protocol is JSON-RPC-like but is not MCP. It has no MCP initialization, resource, prompt, or transport semantics.

## Authentication

1. Pi validates the HTTP `Origin` as an exact `chrome-extension://<32-character-id>` origin.
2. Pi sends `auth.challenge` with a random challenge ID, 256-bit nonce, and 30-second expiry.
3. Chrome sends `hello` with protocol version, stable client ID, extension version, and capabilities.
4. Chrome computes `HMAC-SHA256(secret, challengeId.nonce.clientId.origin)` and sends `auth.response`.
5. Pi verifies the proof using constant-time comparison, consumes the challenge, binds the first valid extension ID, and sends `auth.result`.

Secrets never appear in WebSocket URLs, HTTP headers, pi session entries, or tool output. Challenges are single-use, short-lived, and connection-scoped.

## Frames

| Type | Direction | Purpose |
| --- | --- | --- |
| `hello` | Chrome → pi | Negotiate protocol and capabilities |
| `auth.challenge` | pi → Chrome | Supply nonce and expiry |
| `auth.response` | Chrome → pi | Prove possession of the pairing secret |
| `auth.result` | pi → Chrome | Accept or reject authentication |
| `request` | pi → Chrome | Invoke one bounded browser method |
| `response` | Chrome → pi | Return a JSON result or typed error |
| `event` | Chrome → pi | Report tab changes, user-selected text, or revocation |
| `cancel` | pi → Chrome | Abort one request |
| `ping` / `pong` | Both | Keep the connection alive and check liveness |

Requests contain a UUID, method, JSON parameters, timeout, optional confirmation flag, and tab context. Responses contain the same UUID and exactly one of `result` or `error`.

## Methods

| Method | Parameters | Result |
| --- | --- | --- |
| `browser.getConnectionState` | `{}` | Browser-side connection and tab state |
| `tabs.getActive` | `{}` | Bound tab metadata and tab context |
| `tabs.navigate` | `{url}` | New tab context |
| `page.getVisibleText` | `{}` | URL, title, visible text, truncation state |
| `page.getSelection` | `{}` | Selected text and URL |
| `page.captureVisible` | `{}` | PNG data URL and MIME type |
| `page.click` | `{selector}` | Click status |
| `page.type` | `{selector,text}` | Type status |
| `webmcp.listTools` | `{}` | Serializable page tool metadata |
| `webmcp.callTool` | `{name,arguments}` | Serializable page tool result |

No method accepts source code or executes arbitrary JavaScript supplied by the model.

## Events

- `tab.changed` carries the new `TabContext` after binding, authentication, or navigation.
- `user.prompt` carries user-selected page text and its UI source. The pi extension wraps it as untrusted browser content before calling `pi.sendUserMessage`.
- `pairing.revoke` asks pi to persistently remove its pairing secret. Pi acknowledges success by closing the authenticated connection with close code `1000` and reason `Pairing revoked`; Chrome then clears its local pairing. If no authenticated connection exists, Chrome can only clear its local data and tells the user to run `/chrome-revoke` in pi.

## Errors

Stable error codes include authentication failures, permission denial, stale context, missing tab binding, request cancellation and timeout, oversized messages, unsupported capabilities, unknown methods, and internal failures. Tool callers receive actionable messages and do not infer success from connection closure.

## Limits

- WebSocket frame: 4 MiB.
- Visible text returned to the model: 50 KiB including a truncation marker.
- Chrome-to-pi selected text: 50,000 JavaScript characters before wrapping.
- Request timeout: 60 seconds maximum; 15 seconds by default.
- JSON nesting: 20 levels.
- JSON object keys: 1,000 per object.
- JSON array items: 10,000 per array.

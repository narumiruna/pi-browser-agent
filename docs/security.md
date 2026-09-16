# Security model

## Boundary and assets

The bridge grants a paired Chrome extension bounded access to one explicitly bound HTTP(S) tab. The pairing secret, extension-ID binding, page contents, user account state, and the local pi session are protected assets.

The browser page, page-provided WebMCP metadata and results, WebSocket peers before authentication, and model-generated tool arguments are untrusted. Loopback networking is a transport boundary, not an authentication boundary.

## Controls

- The server binds only to `127.0.0.1` and checks the exact `chrome-extension://<id>` WebSocket origin.
- A 256-bit secret authenticates a client with a 30-second, single-use HMAC challenge. The first valid pairing binds the extension ID.
- Pi stores configuration atomically with mode `0600`; Chrome uses extension-local storage. Secrets are not included in URLs, tool results, or pi session entries.
- Every frame is schema-checked and size-limited. Requests have bounded timeouts, correlation IDs, cancellation, known methods, and a navigation epoch.
- The production manifest starts with `activeTab`; persistent host access is optional and origin-scoped.
- Browser operations expose no arbitrary JavaScript, cookie, storage, password, file-input, or unrestricted network capability.
- Form submission, download, cross-origin navigation, and every WebMCP invocation require confirmation. Pairing can be revoked from either side.
- Page text sent to the model is truncated and labelled as untrusted data.

## Threat analysis

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Malicious webpage | No page-controlled network transport, runtime validation, bounded output, sensitive-element denial, mutation confirmation, stale-context checks, and untrusted-content labels. | A page can present deceptive visible text or change after inspection; the user and model must treat page output as data. |
| Malicious Chrome extension | Exact origin validation plus first-pair extension-ID binding and secret proof prevent an unpaired extension from using the bridge. | Another local extension that steals the pairing secret and can spoof the bound ID is outside Chrome's normal isolation guarantees. Revoke and pair again after suspected compromise. |
| Localhost probing by a website | Loopback alone grants nothing. Browser WebSocket origins that are not exact Chrome-extension origins are rejected before authentication. | A website can detect that a port responds or consume a small amount of handshake work; rate-based denial of service is an accepted local-only MVP risk. |
| DNS rebinding or remote access | The listener uses the literal IPv4 loopback address, never `0.0.0.0` or a hostname, and validates `Origin`. | A fully compromised local network stack or browser is outside scope. |
| Stolen pairing secret | Secret files are user-only, challenges are nonce-bound, short-lived, connection-scoped, and single-use; pairing rotation disconnects the old client. | Local malware running as the same OS user can read process files or browser profile data. Native Messaging or OS keychain storage is a future hardening option. |
| Replay | Each challenge is random, expires after 30 seconds, and is consumed on the first response. The proof binds challenge ID, nonce, client ID, and origin. | None known within the HMAC and random-number assumptions. |
| Prompt injection | Browser text and WebMCP output are wrapped as untrusted content and never become system instructions. WebMCP tools are exposed through one stable tool rather than dynamically changing pi's instruction surface. | Models can still mishandle adversarial content. Confirmation is required before high-impact mutations. |
| Over-privileged permissions | Production uses `activeTab` and asks for an optional per-origin host grant only from the popup. It does not request `<all_urls>`, cookies, downloads, or debugger access. | A bound tab can contain sensitive visible account data. Binding and persistent grants remain explicit user decisions. |
| Cross-tab or navigation race | One tab is bound and each request includes tab ID, URL, and document epoch. Chrome rejects stale contexts. | Same-document application state can change without navigation; selectors are resolved immediately and must refer to visible elements. |
| Oversized or malformed data | Frame, JSON shape, nesting, key, array, text, and timeout limits are enforced before processing; oversized responses become typed errors. | Screenshot data can approach the frame limit and fail rather than being recompressed. |
| Lifecycle leaks | Session shutdown closes sockets and pending work; reconnect backoff and heartbeat timers are cancelled; start/stop is idempotent. | Abrupt process termination relies on the operating system to release the loopback port. |

## Accepted MVP risks

This is a single-user local bridge, not a sandbox against malware running as the same OS account. Transport is plaintext on loopback because confidentiality from same-user local malware cannot be provided by TLS with a bundled trust root. Native Messaging, keychain-backed credentials, operation audit logs, and policy-managed extension IDs are deferred.

WebMCP is experimental and page-controlled. Its absence does not affect the DOM-based core, and its invocation always requires confirmation.

The Extension.js 4.1.19 development toolchain currently brings a high-severity denial-of-service advisory through Less's optional `image-size` parser. Neither Less nor `image-size` is included in the Chrome or pi runtime artifacts, and this repository does not compile untrusted Less input. `npm audit --omit=dev` is clean. Upgrade Extension.js when its dependency chain resolves the advisory.

## Security verification

Run:

```sh
npm test
npm run test:e2e
npm audit --omit=dev
```

The tests cover invalid origins and secrets, challenge expiry and replay, malformed and oversized frames, unknown protocol versions, stale navigation, denied mutations, worker/server restarts, revocation, and output truncation. Development-only Extension.js dependencies are not shipped in either runtime artifact.

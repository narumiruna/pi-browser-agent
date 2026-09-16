# Security model

## Trust boundaries

Trusted extension contexts are the Side Panel and MV3 service worker. Web pages, injected page results, model output, WebMCP definitions, and WebMCP results are untrusted.

`chrome.storage.local` is restricted to `TRUSTED_CONTEXTS`. OAuth values never enter runtime messages, the service worker, injected functions, model messages, tool results, IndexedDB sessions, or logs. Diagnostic strings pass through credential redaction.

## Authentication

OpenAI access requires an explicit **Log in** gesture before Chrome requests the two provider origins. The device flow validates response shapes and the ChatGPT account claim. Polling handles pending, slowdown, denial, local or server expiry, and cancellation. Automatic refresh runs inside the credential store's serialized provider mutation, and a rotated refresh token replaces the old credential in one storage write.

Logout first aborts the agent, waits for it to become idle, then removes persistent credentials. Requests cannot silently switch providers or hosts after auth failure.

## Current-tab controls

- Only the active HTTP(S) tab in the focused Chrome window is targeted.
- Tab and window activation automatically update the target; unsupported pages clear it.
- Tab ID, URL, and context epoch identify the operation context.
- Navigation or a visible-tab change after request creation causes `STALE_CONTEXT`.
- Host access is requested from a user gesture and scoped to a selected origin.
- Password and file inputs are always denied.
- Form submissions, downloads, cross-origin links, cross-origin navigation, and WebMCP calls require confirmation.
- Cross-origin navigation additionally requires destination host permission.
- Tools accept fixed schemas; injected code cannot evaluate model-provided JavaScript.

Mutation tools declare `replay: "never"` and execute sequentially. Interrupted sessions do not continue automatically.

## Untrusted content and limits

Visible page text, selection, screenshot metadata, tab metadata, and WebMCP results are wrapped as untrusted content before model use. They cannot enter the system-prompt channel. Visible text and selections are truncated to 50 KB. Screenshots are rejected above 3 MB. Clipboard input accepts at most four PNG, JPEG, WebP, or GIF images using 3 MB in total; SVG and other MIME types are rejected, and transcript rendering constructs data URLs only for validated raster-image content. Session records are rejected above 5 MB and retention is capped at 50 sessions.

## Build boundary

The production build includes `pi-agent-core`, selected `pi-ai` provider code, and browser-owned OAuth. It excludes native processes, shell tools, filesystem discovery, dynamic remote code, and Node OAuth callback modules. `npm run audit:artifact` rejects executable Node built-in imports, loopback transport URLs, remote scripts, source maps, embedded credential patterns, and unexpected permissions.

`npm audit --omit=dev` is clean. A full development-dependency audit reports four high-severity denial-of-service advisories through Extension.js → Less → `image-size`. These parsers are not shipped in the Chrome artifact, and the build does not process untrusted Less input. The available forced fix downgrades Extension.js across a breaking boundary, so the development-only advisory is accepted until the toolchain updates its dependency.

## Residual risks

- Codex subscription endpoints can change independently of this extension.
- Browser-profile credential storage is less protected than an OS keychain.
- Browser or panel termination can interrupt a stream; the last complete transcript remains recoverable, but partial content is not treated as complete.
- Page confirmation describes an intended action, but the page can still change between inspection and execution. Link targets are rechecked immediately before controlled navigation.

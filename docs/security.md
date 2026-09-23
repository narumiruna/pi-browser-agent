# Security model

## Trust boundaries

Trusted extension contexts are the Side Panel and MV3 service worker. Web pages, injected page results, bookmark titles and URLs, model output, WebMCP definitions, and WebMCP results are untrusted.

`chrome.storage.local` is restricted to `TRUSTED_CONTEXTS`. API keys and OAuth values never enter runtime messages, the service worker, injected functions, model messages, tool results, IndexedDB sessions, or logs. Diagnostic strings pass through credential redaction.

## Authentication

Provider setup requires an explicit user gesture. API-key prompts are provider-owned, and Pi Browser Agent stores their result under only that provider ID. OpenAI Codex login requests its two authentication origins and validates device-flow response shapes and the ChatGPT account claim. Polling handles pending, slowdown, denial, local or server expiry, and cancellation. Automatic refresh runs inside the credential store's cross-context serialized mutation, and a rotated refresh token replaces the old credential in one storage write.

Credential removal first aborts the agent, waits for it to become idle, then removes only the selected provider credential. Before each run, Chrome asks for the selected model endpoint's exact origin. Requests cannot silently switch providers or hosts after auth failure.

## Current-tab controls

- Chat, provider authentication, and individually confirmed bookmark reads work without a readable tab. Only the active, accessible HTTP(S) tab in the focused Chrome window is targeted by page tools. A no-page turn keeps those tools disabled even if the active tab changes; queued instructions cannot upgrade it.
- The UI capability label is not authorization: known restricted origins, local files, and apparent PDFs are excluded before binding; Chrome-denied injection marks a web tab unavailable until reload/navigation. The worker still checks visibility, exact-origin approval, and epoch for every operation. File/PDF page reads and local import are not implemented.
- Tab and window activation automatically update the target; unsupported pages clear it. UI-only page status (bounded title and kind) changes even between two unsupported tabs; protected URLs and file paths are not sent to the model by default.
- Tab ID, URL, and context epoch identify the operation context.
- Navigation or a visible-tab change after request creation causes `STALE_CONTEXT`.
- Ordinary host access is approved from an explicit user gesture and scoped to selected exact origins in trusted extension storage. The worker requires both that app-level approval and Chrome host permission.
- Screenshot capture separately requests optional `<all_urls>` from its confirmation gesture because Chrome requires it when `activeTab` is no longer live. Although Chrome treats that grant as satisfying narrower host checks, Pi Browser Agent does not add exact app approvals from it. The worker still captures only the active visible HTTP(S) viewport and rechecks the grant before each capture.
- Password and file inputs are always denied.
- Form submissions, downloads, cross-origin links, cross-origin navigation, and WebMCP calls require confirmation.
- Cross-origin navigation additionally requires destination host permission. User-confirmed opening of a new web tab is separate from agent navigation; entering a search query and accepting the displayed URL is required before it goes to the search provider. Page access after opening still requires exact-origin approval.
- Tools accept fixed schemas; injected code cannot evaluate model-provided JavaScript.

Mutation tools declare `replay: "never"` and execute sequentially. Interrupted sessions do not continue automatically.

The user-driven element picker is not a mutation capability. The worker binds one random token to the exact active tab context for at most one minute and accepts results only from the extension's top-frame sender. Its fixed full-viewport shield receives pointer/click/context/drag activation instead of the target, so the target's click, navigation, and submit behavior does not run. Cleanup is idempotent across selection, `Esc`, repeated toggle, navigation, tab/focus change, timeout, Side Panel close, and worker restart. Because this is an extension overlay rather than browser-internal DevTools interception, a page-level capture listener registered earlier can still observe an intercepted event. Saved selectors and rectangles are untrusted relocation hints and never bypass normal mutation discovery and revalidation.

Picker extraction is bounded to five composer items, 8 KB per context, and 16 KB combined. It reads top-frame light DOM only; field values, editable text, password/file data, hidden text, full HTML, and credential-bearing URLs are excluded. The worker validates exact keys, scalar limits, geometry, sender, token, page URL, and context freshness before the panel receives a chip. The selected JSON enters only a user message under an explicit untrusted-data header.

Element discovery uses the same approved-origin and visible-tab checks as ordinary page reads. It exposes only bounded control descriptions, not field values, editable contents, hidden text, full HTML, or sensitive password/file targets. Descriptions are untrusted model input. Short references require an accompanying random snapshot ID; a reference is not a capability to bypass permission, confirmation, or target checks. Actual nodes live only in the extension's isolated world, not page attributes. Worker metadata expires after five minutes and is invalidated on new discovery, navigation, activation/focus changes, and restart. Detached/replaced nodes and changed action metadata fail closed, including changes to resolved submit override URLs, effective submit form identity, submitter name/value, and encoding/validation overrides through direct, label, or nested targets. Submitter payload metadata stays in the isolated-world fingerprint for comparison; it is not returned to the model or persisted, and no editable field values are read. Discovery and reference-based mutations reject ancestor-only hit tests, including controls fully clipped by overflow ancestors, and zero-opacity CSS filter functions on targets or their filtering ancestors. Filter checks on slotted light-DOM controls follow exposed assigned slots and shadow hosts, including nested slot assignments; they do not enumerate shadow-owned controls or expose closed-root slot assignments. Boxless `display: contents` ancestors do not apply their own filters and are skipped. Active modal, popover, and fullscreen roots are checked, including roots inside shadow trees, but filters on their outside filtering ancestors are not applied to top-layer content. Name collection applies the same filter check, starting at each directly slotted text node's exposed assigned slot rather than skipping to its parent host. Parent visibility and text-range hit checks remain required; changed filtered names invalidate reference fingerprints, including after focus handlers. Serialized computed filters longer than 4,096 UTF-16 units are rejected before parsing, rather than partially inspected or assumed visible, including during final mutation and post-focus checks. This bounds parser input, not browser style computation; arbitrary SVG filter effects are not evaluated. Final mutation assertions recheck cancellation, host access, snapshot freshness, and the visible context; typing also rechecks after focus handlers run, with a fresh filter cache. Filter decisions are shared only within a synchronous validation phase, never across operations or the focus-handler boundary. Once an injected mutation reports success, snapshot invalidation caused by that mutation does not retroactively report it as rejected. Read results and deferred navigation authorization still require snapshot freshness; failed or unknown operations are not assumed successful or replayed.

## Bookmark controls

- Bookmark access is an optional permission and is never requested at install, login, startup, or ordinary prompt submission.
- Every bookmark search or recent-item read requires a fresh operation-specific confirmation. If permission is missing, only that Confirm-button gesture can request it.
- The worker rejects bookmark requests carrying a page `TabContext`, rechecks permission before each read, and does not retry after revocation.
- Production code calls only `chrome.bookmarks.search()` and `chrome.bookmarks.getRecent()`; runtime validation exposes no write or whole-tree method, and the artifact audit rejects bookmark mutation calls.
- Confirmation explains that returned bookmark titles and URLs are sent to the selected model provider and saved in the session. This limits prompt-injection-driven disclosure to a user-approved query and bounded result.
- The permission can be revoked from Chrome's extension settings. Chrome's permission itself covers the broader bookmarks API even though Pi Browser Agent implements reads only.

Bookmark tools declare `replay: "never"` and execute sequentially so a resumed or parallel run cannot silently reuse one confirmation.

## Untrusted content and limits

Visible page text, selection, selected-element context, screenshot metadata, tab metadata, bookmark data, and WebMCP results are wrapped as untrusted content before model use. They cannot enter the system-prompt channel. Visible text and selections are truncated to 50 KB. Screenshots require the optional broad Chrome grant, are limited by runtime checks to the current visible HTTP(S) viewport, and are rejected above 3 MB. Annotation accepts only a validated PNG header and matching decoded dimensions, rejects sources above 16,384 px per side or 64 million pixels, downscales editing to at most 4,096 px per side and 16 million pixels, and bounds stroke/point counts and pen width. Export must be a non-empty PNG of at most 3 MB and is revalidated against the existing four-image/3 MB composer limits. Editing is local, the original result is immutable, and cancel/`Esc` stores and sends nothing. Clipboard input accepts at most four PNG, JPEG, WebP, or GIF images using 3 MB in total; SVG and other MIME types are rejected, and transcript rendering constructs data URLs only for validated raster-image content. Bookmark search requires a non-empty query, and search and recent reads are capped at 50 normalized nodes and 50 KB. Voice input uses Chrome's Web Speech service and may send audio to the browser's configured speech provider; Pi Browser Agent receives an editable transcript and does not submit it to the model until the user sends the message. Session records are rejected above 5 MB and retention is capped at 50 sessions.

## Transcript rendering

Assistant Markdown is untrusted. Bundled Marked escapes raw HTML and suppresses image rendering; DOMPurify permits only presentation tags and necessary attributes. A separate URL check rejects non-HTTP(S), relative, and credential-bearing links. Allowed links open only on user clicks with `noopener noreferrer`. Script, SVG, MathML, forms, embeds, event handlers, inline styles, and passive remote resources are excluded. Sanitization also applies to incomplete streams and restored transcripts. Existing validated raster-image message blocks remain on their separate data-URL path.

User messages, thinking, and tool payloads remain plain text. Copy controls invoke the Clipboard API only from a user gesture and report failures without requesting new permissions. Rendered HTML, disclosure state, and DOM node registries are not persisted or sent to models. Saved discovery results cannot restore a live reference registry.

## Build boundary

The production build includes `pi-agent-core`, browser-compatible built-in `pi-ai` provider code, and browser-owned Codex OAuth. It excludes Amazon Bedrock's Node-only adapter, native processes, shell tools, filesystem discovery, dynamic remote code, and Node OAuth callback modules. The browser-boundary probe bundles all registered providers and their lazy API paths. `npm run audit:artifact` parses emitted JavaScript and rejects executable Node built-in imports while ignoring documentation strings, and also rejects loopback transport URLs, remote scripts, source maps, embedded credential patterns, bookmark mutation calls, and unexpected required, optional, or host permissions. It also requires screenshot access to remain declared as optional `<all_urls>` and rejects every required host permission.

On 2026-09-21, `npm audit --omit=dev` and `npm audit` both reported zero vulnerabilities. Markdown dependencies are pinned to Marked 18.0.13 and DOMPurify 3.4.15 in the lockfile and bundled locally; no parser or sanitizer code is fetched at runtime.

## Residual risks

- Provider APIs and catalogs can change independently of this extension, and an endpoint may decline extension-origin requests even after Chrome grants host access.
- The complete static model catalog increases the packaged Side Panel size.
- Browser-profile credential storage is less protected than an OS keychain.
- Browser or panel termination can interrupt a stream; the last complete transcript remains recoverable, but partial content is not treated as complete.
- Page confirmation describes an intended action, but the page can still change between inspection and execution. Link targets are rechecked immediately before controlled navigation.
- Element-picker selectors can become stale or match a different node after DOM changes. They are descriptive context only, not authorization to mutate.
- A normal page overlay cannot suppress an event already observed by an earlier page-level capture listener, although the selected target and its default activation remain blocked.

# Permissions and data storage

## Manifest permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary page access after the user invokes the extension. |
| `contextMenus` | Send the current selection to the Side Panel. |
| `scripting` | Run fixed bounded operation functions in the current page. |
| `sidePanel` | Host the agent and user interface. |
| `storage` | Store settings, credentials, and undelivered context-menu selections. |
| `tabs` | Identify the active tab and its URL when the user switches tabs or windows. |

## Optional host permissions

| Permission | Purpose |
| --- | --- |
| `<all_urls>` | Satisfy Chrome's `captureVisibleTab()` requirement after temporary `activeTab` access ends. Requested only from the first screenshot confirmation. |

Chrome describes `<all_urls>` as access to all sites. Pi Chrome declares it as optional rather than required, requests it only from the screenshot confirmation's Confirm gesture, and rechecks it before every capture. The runtime continues to target only the active visible HTTP(S) tab in the focused window, reject stale tab contexts, capture only the viewport, and cap the PNG at 3 MB. Denial leaves the confirmation open; revocation causes the next screenshot request to ask again. Screenshot content is sent to the selected model provider and stored in the session transcript.

## Optional API permissions

| Permission | Purpose |
| --- | --- |
| `bookmarks` | Search bookmark titles and URLs or read a bounded recent-bookmark list after explicit confirmation. |

`bookmarks` is absent by default. A bookmark tool request first opens Pi Chrome's operation confirmation. If access has not been granted, its Confirm button requests the optional permission from the user gesture; denial leaves the operation unapproved. The service worker checks the grant again before every read. Chrome grants the bookmarks API as one capability that can also support writes, but Pi Chrome has no create, update, move, remove, tree-read, import, or export runtime method. The production artifact audit rejects bookmark mutation calls.

Optional host patterns cover `<all_urls>`, the two OpenAI authentication origins, and HTTP(S) page/provider origins. `<all_urls>` is requested only for screenshot capture. Chrome treats that broad grant as satisfying narrower origin requests, so a later exact-origin request can succeed without another native Chrome prompt. Pi Chrome therefore also records each normalized exact origin approved through an explicit Send, login, site-access, catalog-load, or cross-origin confirmation action. Ordinary access requires both Chrome host permission and this app-level approval; `<all_urls>` alone does not authorize a new page or provider origin. Independently granted exact Chrome origins are migrated into this approval list when detected.

OpenAI authentication origins are requested together only from **Log in to OpenAI Codex**. When the user submits a prompt, the Side Panel approves the visible page origin and the exact selected model endpoint origin in one user gesture before starting or queueing the task. Radius approves `radius.pi.dev` while loading its dynamic catalog. The account menu keeps **Allow current site** as a manual retry. Confirming cross-origin navigation or a cross-origin link approves the destination origin as part of that confirmation. Selecting the extension action also grants temporary `activeTab` access to the page visible at that time. There is no production `host_permissions` grant and no host access or app approval occurs without a user gesture, except migration of an independently granted exact Chrome origin.

The extension CSP permits HTTP(S) connections so a user-selected built-in provider can operate after Chrome grants its optional host permission. It still permits scripts only from the packaged extension and does not permit remote scripts. Screenshot and bookmark access can be revoked separately from Chrome's extension settings. A later protected operation fails or returns to its explicit confirmation flow without an automatic background permission request.

## Storage

| Store | Data | Lifetime |
| --- | --- | --- |
| `chrome.storage.local` | Provider-scoped API keys or Codex OAuth credential, selected provider/model, interface font and text-size preferences, system prompt, AGENTS-style instructions, active session ID, app-approved exact host patterns | Until credential removal, settings or host approval change, session selection, or extension data removal |
| `chrome.storage.session` | An undelivered context-menu selection | Browser session |
| IndexedDB `pi-chrome-sessions` | Versioned complete messages and tool results, including confirmed bookmark titles and URLs, model state, names, timestamps, embedded screenshot and pasted-image content | Until retention deletion or user clear |
| Memory | Live agent, partial stream, confirmations, login cancellation, unsent pasted-image previews | Side Panel lifetime |

Local extension storage is restricted to trusted contexts. Content injection has no storage API channel and receives only operation parameters.

## Retention and recovery

Confirmed bookmark results are sent to the selected model provider as conversation tool results and then persist in the same transcript record as other complete messages. Search requires a non-empty query; search and recent reads return at most 50 normalized items and 50 KB. Pi Chrome does not keep a separate bookmark cache or index.

Clipboard images are read only after an explicit paste into the composer. One message accepts up to four PNG, JPEG, WebP, or GIF images with a combined binary size of 3 MB. Images remain in memory until sent or removed; sent images are embedded in the transcript.

IndexedDB stores at most 50 sessions, newest first. Each serialized session is limited to 5 MB. If a live transcript reaches that limit, embedded images and then the oldest messages are removed until the record can be saved, and the Side Panel reports the loss. The active session ID is stored separately so Side Panel and Chrome restarts restore the selected session even when records have equal timestamps. Deleting a session deletes its transcript and inline image content in the same record. Clearing session storage removes the object store contents before creating a new empty session.

A session is `running` only while an agent invocation is active. A Web Lock prevents two live Side Panels from owning the same session. Startup changes only a successfully claimed stale `running` record to `interrupted`. Partial streaming state is memory-only; completed messages remain available for review, and mutation tools are not replayed.

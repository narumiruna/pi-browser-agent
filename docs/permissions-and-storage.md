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

## Optional API permissions

| Permission | Purpose |
| --- | --- |
| `bookmarks` | Search bookmark titles and URLs or read a bounded recent-bookmark list after explicit confirmation. |

`bookmarks` is absent by default. A bookmark tool request first opens Pi Chrome's operation confirmation. If access has not been granted, its Confirm button requests the optional permission from the user gesture; denial leaves the operation unapproved. The service worker checks the grant again before every read. Chrome grants the bookmarks API as one capability that can also support writes, but Pi Chrome has no create, update, move, remove, tree-read, import, or export runtime method. The production artifact audit rejects bookmark mutation calls.

Optional host patterns are the two OpenAI origins and HTTP(S) page origins. OpenAI origins are requested together only from **Log in**. When the user submits a prompt, the Side Panel requests the visible page's origin before starting or queueing the task; the account menu keeps **Allow current site** as a manual retry. Confirming cross-origin navigation or a cross-origin link requests the destination origin as part of that confirmation. Selecting the extension action also grants temporary `activeTab` access to the page visible at that time. There is no production `host_permissions` grant and no site access request occurs without a user gesture.

The extension CSP permits connections only to `auth.openai.com` and `chatgpt.com`; it does not permit remote scripts. Bookmark access can be revoked separately from Chrome's extension settings. A later read fails without an automatic retry or background permission request.

## Storage

| Store | Data | Lifetime |
| --- | --- | --- |
| `chrome.storage.local` | OpenAI credential, system prompt, AGENTS-style instructions, active session ID | Until logout, settings change, session selection, or extension data removal |
| `chrome.storage.session` | An undelivered context-menu selection | Browser session |
| IndexedDB `pi-chrome-sessions` | Versioned complete messages and tool results, including confirmed bookmark titles and URLs, model state, names, timestamps, embedded screenshot and pasted-image content | Until retention deletion or user clear |
| Memory | Live agent, partial stream, confirmations, login cancellation, unsent pasted-image previews | Side Panel lifetime |

Local extension storage is restricted to trusted contexts. Content injection has no storage API channel and receives only operation parameters.

## Retention and recovery

Confirmed bookmark results are sent to OpenAI as conversation tool results and then persist in the same transcript record as other complete messages. Search requires a non-empty query; search and recent reads return at most 50 normalized items and 50 KB. Pi Chrome does not keep a separate bookmark cache or index.

Clipboard images are read only after an explicit paste into the composer. One message accepts up to four PNG, JPEG, WebP, or GIF images with a combined binary size of 3 MB. Images remain in memory until sent or removed; sent images are embedded in the transcript.

IndexedDB stores at most 50 sessions, newest first. Each serialized session is limited to 5 MB. If a live transcript reaches that limit, embedded images and then the oldest messages are removed until the record can be saved, and the Side Panel reports the loss. The active session ID is stored separately so Side Panel and Chrome restarts restore the selected session even when records have equal timestamps. Deleting a session deletes its transcript and inline image content in the same record. Clearing session storage removes the object store contents before creating a new empty session.

A session is `running` only while an agent invocation is active. A Web Lock prevents two live Side Panels from owning the same session. Startup changes only a successfully claimed stale `running` record to `interrupted`. Partial streaming state is memory-only; completed messages remain available for review, and mutation tools are not replayed.

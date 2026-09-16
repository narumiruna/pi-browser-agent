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

Optional host patterns are the two OpenAI origins and HTTP(S) page origins. OpenAI origins are requested together only from **Log in**. When the user submits a prompt, the Side Panel requests the visible page's origin before starting or queueing the task; the account menu keeps **Allow current site** as a manual retry. Confirming cross-origin navigation or a cross-origin link requests the destination origin as part of that confirmation. Selecting the extension action also grants temporary `activeTab` access to the page visible at that time. There is no production `host_permissions` grant and no site access request occurs without a user gesture.

The extension CSP permits connections only to `auth.openai.com` and `chatgpt.com`; it does not permit remote scripts.

## Storage

| Store | Data | Lifetime |
| --- | --- | --- |
| `chrome.storage.local` | OpenAI credential, system prompt, AGENTS-style instructions, active session ID | Until logout, settings change, session selection, or extension data removal |
| `chrome.storage.session` | An undelivered context-menu selection | Browser session |
| IndexedDB `pi-chrome-sessions` | Versioned complete messages, model state, names, timestamps, embedded image content | Until retention deletion or user clear |
| Memory | Live agent, partial stream, confirmations, login cancellation | Side Panel lifetime |

Local extension storage is restricted to trusted contexts. Content injection has no storage API channel and receives only operation parameters.

## Retention and recovery

IndexedDB stores at most 50 sessions, newest first. Each serialized session is limited to 5 MB. If a live transcript reaches that limit, embedded images and then the oldest messages are removed until the record can be saved, and the Side Panel reports the loss. The active session ID is stored separately so Side Panel and Chrome restarts restore the selected session even when records have equal timestamps. Deleting a session deletes its transcript and inline image content in the same record. Clearing session storage removes the object store contents before creating a new empty session.

A session is `running` only while an agent invocation is active. A Web Lock prevents two live Side Panels from owning the same session. Startup changes only a successfully claimed stale `running` record to `interrupted`. Partial streaming state is memory-only; completed messages remain available for review, and mutation tools are not replayed.

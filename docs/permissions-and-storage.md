# Permissions and data storage

## Manifest permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary access after the user invokes the extension. |
| `contextMenus` | Explicitly bind a tab or send its current selection to the Side Panel. |
| `scripting` | Run the fixed bounded operation functions in the bound tab. |
| `sidePanel` | Host the agent and user interface. |
| `storage` | Store settings, credentials, and session-only tab binding. |

Optional host patterns are the two OpenAI origins and HTTP(S) page origins. OpenAI origins are requested together only from **Log in**. A page origin is requested directly from the **Allow site** click handler. Tab binding uses the page context menu so Chrome grants `activeTab` in the same gesture. There is no production `host_permissions` grant.

The extension CSP permits connections only to `auth.openai.com` and `chatgpt.com`; it does not permit remote scripts.

## Storage

| Store | Data | Lifetime |
| --- | --- | --- |
| `chrome.storage.local` | OpenAI credential, system prompt, AGENTS-style instructions, active session ID | Until logout, settings change, session selection, or extension data removal |
| `chrome.storage.session` | Bound tab ID and an undelivered context-menu selection | Browser session |
| IndexedDB `pi-chrome-sessions` | Versioned complete messages, model state, names, timestamps, embedded image content | Until retention deletion or user clear |
| Memory | Live agent, partial stream, confirmations, login cancellation | Side Panel lifetime |

Local extension storage is restricted to trusted contexts. Content injection has no storage API channel and receives only operation parameters.

## Retention and recovery

IndexedDB stores at most 50 sessions, newest first. Each serialized session is limited to 5 MB. If a live transcript reaches that limit, embedded images and then the oldest messages are removed until the record can be saved, and the Side Panel reports the loss. The active session ID is stored separately so Side Panel and Chrome restarts restore the selected session even when records have equal timestamps. Deleting a session deletes its transcript and inline image content in the same record. Clearing session storage is refused while another Side Panel owns a live session; otherwise it removes the object store contents before creating a new empty session.

A session is `running` only while an agent invocation is active. A Web Lock prevents two live Side Panels from owning the same session. Startup changes only a successfully claimed stale `running` record to `interrupted`. Partial streaming state is memory-only; completed messages remain available for review, and mutation tools are not replayed.

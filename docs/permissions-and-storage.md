# Permissions and data storage

## Manifest permissions

| Permission | Purpose |
| --- | --- |
| `activeTab` | Temporary access after the user invokes the extension. |
| `contextMenus` | Explicitly send the current selection to the Side Panel. |
| `scripting` | Run the fixed bounded operation functions in the bound tab. |
| `sidePanel` | Host the agent and user interface. |
| `storage` | Store settings, credentials, and session-only tab binding. |

Optional host patterns are the two OpenAI origins and HTTP(S) page origins. OpenAI origins are requested together only from **Log in**. A page origin is requested from **Allow site**. There is no production `host_permissions` grant.

The extension CSP permits connections only to `auth.openai.com` and `chatgpt.com`; it does not permit remote scripts.

## Storage

| Store | Data | Lifetime |
| --- | --- | --- |
| `chrome.storage.local` | OpenAI credential, system prompt, AGENTS-style instructions | Until logout, settings change, or extension data removal |
| `chrome.storage.session` | Bound tab ID | Browser session |
| IndexedDB `pi-chrome-sessions` | Versioned complete messages, model state, names, timestamps, embedded image content | Until retention deletion or user clear |
| Memory | Live agent, partial stream, confirmations, login cancellation | Side Panel lifetime |

Local extension storage is restricted to trusted contexts. Content injection has no storage API channel and receives only operation parameters.

## Retention and recovery

IndexedDB stores at most 50 sessions, newest first. Each serialized session is limited to 5 MB. Deleting a session deletes its transcript and inline image content in the same record. Clearing session storage removes the object store contents before creating a new empty session.

A session is `running` only while an agent invocation is active. Startup changes stale `running` records to `interrupted`. Partial streaming state is memory-only; completed messages remain available for review, and mutation tools are not replayed.

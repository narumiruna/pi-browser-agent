# Local Pi ↔ Browser tasks

## Scope

The optional project-local Pi plugin connects Pi Coding Agent in WSL to Pi Browser Agent in **existing Windows Chrome and its existing profile**. It does not launch Linux or Windows Chrome, create a profile, or copy a profile or credentials.

The Node Pi plugin launches only a helper with an installed Windows Bun runtime through WSL interop. The helper uses a standard native Windows WebSocket to Chrome's already user-enabled loopback CDP endpoint. It discovers the endpoint from bounded metadata of at most 1,024 bytes in `%LOCALAPPDATA%/Google/Chrome/User Data/DevToolsActivePort`. No project listening server, port forwarding, Native Messaging registration, external relay, endpoint URL/token input, or feature environment flag is used.

**CDP grants broad authority over the existing personal profile**, including tabs, cookies, website data, and credentials. The narrow task adapter is not a sandbox against a malicious local Pi extension or OS account. Trust the Pi environment before approving this connection.

Production Chrome code remains browser-only: no Node.js, native process, shell tool, general filesystem access, or loopback bridge. All helper/process/CDP code stays outside the production artifact under `.pi/`. Local describes only inter-agent transport; model/provider, website, and remote MCP network behavior is unchanged.

```mermaid
sequenceDiagram
  participant User
  participant Pi as Pi plugin in WSL
  participant Helper as Windows Bun helper
  participant Chrome as Existing Windows Chrome
  participant Settings as Browser Settings
  participant Panel as Real Browser Side Panel
  User->>Pi: /browser-connect; saved ID or first input; automatic-task consent
  Pi->>Helper: WSL interop; bounded stdio
  Helper->>Chrome: Read fixed endpoint metadata; connect WebSocket
  Chrome-->>User: Native debugging approval
  User->>Chrome: Allow connection
  Helper->>Settings: Find or create pinned Settings tab; request connection
  User->>Settings: Allow local connection; confirm
  Settings->>Panel: Open from actual button gesture
  Pi->>Panel: One text task; stable ID
  Panel->>Panel: Start once if ready, idle, and composer empty
  Panel-->>User: Missing access or protected-action confirmation
  User->>Panel: Required approvals only
  Panel-->>Pi: Final assistant text from accepted run
  Pi->>Helper: Disconnect; best-effort revoke; detach
  Note over Helper,Chrome: Chrome, tabs, and profile stay open
```

## Requirements and owner setup

1. Use Pi Coding Agent in WSL with WSL interop available. The declared development dependency is Pi Coding Agent 1.5.0. Windows Chrome 144 or newer must already be running with the existing profile you intend to trust. The helper uses the fixed Google Chrome user-data metadata path above; it accepts no alternate browser path, profile, or endpoint.
2. Install Windows Bun yourself if it is not already installed, and make `bun.exe` available on the Windows PATH. The plugin discovers it through a fixed, non-interactive PowerShell metadata query. Windows Bun is required to run the native TypeScript helper and import shared TypeScript from WSL. Missing Bun fails with an actionable message; the plugin never installs or downloads a runtime. No Playwright browser installation is required for this connection.
3. From the repository root, install locked dependencies and build:

   ```sh
   npm ci
   npm run build
   ```

   In existing Windows Chrome, load `dist/chrome` with **Load unpacked** at `chrome://extensions`. If it is already loaded, select that extension's **Reload** action after the build. Do not restart Chrome or create another profile. Copy its public extension ID from this Windows page: exactly 32 lowercase letters `a`–`p`. This ID pins the extension targets; it is not a credential or token.
4. In Chrome, open `chrome://inspect/#remote-debugging` and enable remote debugging yourself. Chrome 144+ supports this existing-browser connection flow. See the [official automatic-connection instructions](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced.md#automatically-connecting-to-a-running-chrome-instance). Do not use legacy `--remote-debugging-port` launch commands: that path requires a different profile and is not this integration. Do not disable origin checks or weaken browser security.
5. Start Pi from this repository root and approve project trust. Pi discovers `.pi/extensions/browser-tasks/index.ts`. If Pi was already open, use `/reload` to load the updated plugin. This is separate from Chrome's extension **Reload** action. No global plugin installation is required.
6. In an idle interactive Pi session with no pending messages, run `/browser-connect` **without arguments**. Enter the public extension ID on the first connection. Pi saves it in `<getAgentDir()>/pi-browser-agent.json`, normally `~/.pi/agent/pi-browser-agent.json`, and reuses it later. Review and confirm existing-profile trust and automatic task execution for each connection. The helper attaches to Chrome's own endpoint and may create only the fixed, pinned Browser Settings tab; it leaves other tabs open. Approve Chrome's native debugging connection prompt yourself. Pi cannot approve it for you.
7. In **Settings → Tools → Local Coding Agent connection**, select the real **Allow local connection** button, then confirm. This button gesture opens the actual conversation Side Panel. The helper does not automate consent. Setup waits up to ten minutes for approval and panel readiness; an ordinary extension tab cannot substitute for the Side Panel.
8. Keep the Side Panel open. Use the Browser model and credentials already configured in this profile, or configure them through the normal Browser dialogs. Credentials are never copied to or from Pi. Complete provider login and native Chrome permissions yourself. For Pi → Browser work, leave Browser idle with an empty composer and no attachments. Tasks then start without another Pi task confirmation or Browser **Send**. Missing provider/site access and protected browser actions still require their normal approvals.

Connection controls act separately from **Save general settings** and have no draft. General Cancel does not undo consent. Pending connection operations block general Settings Save and exit controls. Inspect rejected or changed connections before another explicit attempt.

## Pi user configuration

The Pi user file is `<getAgentDir()>/pi-browser-agent.json`, normally `~/.pi/agent/pi-browser-agent.json`. It contains the public extension ID, not credentials or connection consent:

```json
{
  "extensionId": "abcdefghijklmnopabcdefghijklmnop"
}
```

The ID must have exactly 32 lowercase letters `a`–`p`. `/browser-connect` saves a valid first input after the profile-trust confirmation, before connection setup. Later connections read it without an input prompt, including after a failed connection. Edit or remove `extensionId` to select another extension. There is no project override or automatic reconnect.

Writes use an owner-only temporary file and atomic replacement. Other JSON fields are retained. Missing files cause no startup write. Invalid JSON, invalid IDs, symbolic links, non-files, and files larger than 16 KiB stop setup without overwriting the file. Correct the reported path before connecting again.

## Coding → Browser

`browser_task` uses the connection's explicit automatic-task consent. It creates a stable ID before dispatch, submits once without another Pi confirmation, and waits up to ten minutes. Local status polling is read-only, every 250 ms; it never repeats task submission.

The Browser receiver fills the existing composer and shows a cancellable **Coding task** chip. A private callback starts the task once when the panel is ready and idle with an empty composer. An occupied composer or active operation rejects the task without overwriting user work. Queued means startup or required access approval is pending, not that Send is required. Automatic preflight only reads existing exact-origin approvals. Missing provider/site access opens the existing confirmation dialog and requires its real approval-button gesture. The helper never selects that button or approves a browser action. Delegated slash-prefixed text is model input, not a Browser command.

Editing the offered text cancels delegation and retains the edit as an ordinary draft. Adding images, selected elements, or page drawing also cancels delegation. The chip's cancel control removes an unchanged offered draft. Browser authentication, exact-origin approval, native permission prompts, visible-tab/stale-worker checks, and action confirmations remain required.

Only final assistant text from the accepted run returns to Pi. History, thinking, HTML, attachments, and provider credentials are not exported. The trusted Browser credential store redacts exact known provider values, including JSON-escaped forms, before answer export. This does not detect every transformed secret. Completion rechecks the live connection and session after redaction; late output cannot revive cancelled work. An additional user instruction cancels delegation instead of exporting a mixed-task answer.

If waiting ends without a result, retain the task ID and inspect it with `browser_task_status`. A timeout does not prove that Browser execution stopped. Do not submit a replacement or repeatedly call the status tool for pending work. Disconnection loses memory-only task handles; saved results cannot recreate them.

### Pi tools

All four tools are inactive until connection setup succeeds. They execute sequentially and require interactive Pi approval where specified.

| Tool                  | Input                                                    | Behavior                                                                               |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `browser_task`        | `{ "task": "Read the requested page and cite its URL" }` | Start once under connection consent and wait. Required access/action approvals remain. |
| `browser_task_status` | `{ "taskId": "<id>" }`                                   | Read a tracked status or answer without execution or retry.                            |
| `browser_task_cancel` | `{ "taskId": "<id>" }`                                   | Confirm cancellation; earlier effects are not undone.                                  |
| `browser_task_reply`  | `{ "taskId": "<id>", "answer": "<selected answer>" }`    | Confirm the exact answer for an explicitly accepted, running Browser → Coding task.    |

Pi permits only one unfinished outgoing task and cannot delegate back while handling a Browser task. Repeated submission tool-call IDs cannot create another task. Acceptance, reply, and cancellation mutations are attempted at most once per task in the live client; uncertain mutations are not replayed.

## Browser → Coding

The connected-only Browser tool `coding_task({task})` redacts known stored provider values from outgoing task text, asks fresh confirmation of that text in every confirmation mode, then queues it and waits up to ten minutes. Its reply is untrusted data, not Browser authorization. The tool is unavailable while Browser handles an incoming Pi task.

Pi does not automatically poll an unsolicited inbox, inject a prompt, or export a transcript. To process the queued task:

1. While Pi is idle with no pending messages, run `/browser-inbox`. Confirm the local inbox read. A notification lists task IDs; unaccepted text does not enter model context.
2. Run `/browser-accept <task-id>`. Review and confirm the complete request. Pi rechecks idle state, claims the unchanged task once, and starts an explicit turn with an untrusted-data wrapper. Existing project rules and action approvals still apply.
3. Use `browser_task_reply` to return only the selected answer. Review its exact text in Pi's confirmation. Do not include credentials or conversation history.
4. Browser receives the answer as an untrusted tool result and continues its run. Normal permissions and action confirmations still apply.

Browser timeout or cancellation cancels its queued/running task and stops local waiting. It cannot guarantee that an already-started Coding action stopped; use Pi's stop control when necessary. Cancellation cannot undo code, page, provider, or remote-server effects.

### Pi commands

| Command                     | Behavior                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/browser-connect`          | Reuse the saved public extension ID or prompt once, confirm profile trust and automatic tasks, then wait for native Chrome and Browser Settings approvals. Requires idle, disconnected Pi and no arguments. |
| `/browser-disconnect`       | Confirm best-effort revocation and detachment; leave Chrome, tabs, and profile intact. Takes no arguments.                                                                                                  |
| `/browser-inbox`            | Explicitly review queued Browser → Coding task IDs while idle. Takes no arguments.                                                                                                                          |
| `/browser-accept <task-id>` | Review and accept one task from the last inbox read, then start one Coding turn.                                                                                                                            |

## Protocol and limits

`connectExistingBrowser({projectRoot,extensionId,signal,onStatus})` returns a `LocalBrowserClient` over a `TaskConnection` with an approved identity. The Windows helper uses only fixed CDP operations and fixed expressions against `window.__piBrowserLocal` version `2`, role `settings` or `conversation`. It accepts no endpoint on stdin. Helper stdio frames are at most 64 KiB, with at most eight ordinary outstanding requests. One close request can interrupt a full queue.

Chrome target discovery internally receives browser target metadata. Only exact extension URLs pinned by the public ID are used; unrelated URLs and titles never enter Pi tools, model messages, or logs. The conversation guard requires `chrome.tabs.getCurrent()` to return `undefined` and `conversationReady` to be `true`. Setup waits for the actual Side Panel to finish initialization before activating task tools; an ordinary extension tab cannot substitute for it. Model tools have no generic CDP, JavaScript, storage, credential, arbitrary-path, or endpoint API.

Requests have exact method-specific keys. Connection methods are `connect`, `status`, and `disconnect`; task methods are `send`, `get`, `inbox`, `accept`, `reply`, and `cancel`. Task access compares approved client, generation, and window. Shared `parseLocalConnection` accepts exactly the four metadata fields. Responses must match task ID, direction, and immutable text; terminal records cannot change through the client.

A task contains `id`, `from`, `to`, `task`, `status`, and optional `answer`:

1. `id` is 1–64 ASCII letters, digits, underscores, or hyphens. New submissions use UUIDs.
2. `from` and `to` are different values from `coding` and `browser`.
3. `task` is non-empty UTF-8 text of at most 8 KiB.
4. `status` is `queued`, `running`, `completed`, `failed`, or `cancelled`.
   - `completed` and `failed` require non-empty `answer` text of at most 24 KiB.
   - Other states must not contain `answer`.

Local task responses are at most 48 KiB, including JSON overhead. Each local operation has a 15-second deadline. Connection setup and answer waiting each have a ten-minute limit. The client tracks at most 64 tasks; an inbox contains at most ten queued Browser → Coding tasks and is also bounded by response bytes. Errors use fixed local text, not raw page, provider, or native-process diagnostics.

## Storage, lifecycle, and recovery

Trusted `chrome.storage.session` key `piBrowserAgentLocalCodingSessionV2` stores exactly `{clientId,generation,windowId,state}`. State is `pending`, `approved`, or `rejected`. A profile-wide Web Lock serializes writes with complete-record comparison. Approval and disconnect each create a fresh generation. This is consent metadata, not a bearer credential. Version 1 approved only draft exchange and is not migrated. Reload the Chrome extension and Pi plugin, then approve a fresh connection for automatic tasks. API version 2 rejects mismatched old builds. Do not clear credentials or conversations for this update.

Queues, handles, reviewed inbox records, and submission tokens stay in memory. Accepted text and selected answers can remain in each agent's normal model/session records. Consent changes, Browser conversation changes, and panel closure invalidate delegated work; reopening restores no task execution. No failed or interrupted mutation is replayed.

Use **Settings → Tools → Disconnect local Coding Agent** to revoke local approval. `/browser-disconnect` asks Pi confirmation, clears local handles, and attempts to revoke only its own pending or approved local connection. Pi shutdown, reload, and session replacement use the same best-effort cleanup. It detaches only its own CDP sessions and closes its WebSocket and helper. It never sends `Browser.close` or `Target.closeTarget`, terminates Chrome, closes tabs (including the Settings tab), or removes the profile. Chrome and the existing session stay running.

Failed or abrupt loss can leave stale session metadata or in-flight work. Before a fresh `/browser-connect`, inspect the Browser transcript and current page, stop Browser work if needed, and revoke stale approval in Settings. Also stop Pi work if needed. Disconnection is not proof that every running action stopped, and cancellation cannot undo earlier effects. There is no automatic reconnect, replay, or safe recovery by recreating an uncertain task. Successful Pi tree navigation keeps the client but clears task handles; cancelled navigation retains recovery state.

Existing Browser credentials, settings, website data, and conversations remain in the current Windows profile. An ignored legacy `.pi/browser-profile/` directory may remain from an earlier development attempt and can contain private credentials. Current code does not create or use it and never automatically deletes or migrates it. Keep it out of Git.

The obsolete unreleased `piBrowserAgentCodingConnectionV1` local-storage key is not read, migrated, or automatically erased. If present from an older development build, stop delegated work and use trusted extension DevTools to remove only that key. Do not clear credentials, MCP records, or conversations for this cleanup. There is no external revocation step or secret to paste into a prompt.

## Verification status and owner acceptance

Safe live probes verified Windows Chrome **156.0.8078.79**, Windows Bun **1.3.14**, shared TypeScript imports through the WSL UNC path, and an actual native WebSocket connection from the Windows helper to existing default Chrome. Only `Browser.getVersion` and `Target.getTargets` were read, with reported targets filtered to Browser Agent Settings metadata. The probes read no page contents or credentials, modified no profile data, launched or closed no browser, and changed no settings. Remote debugging was already enabled on that machine; setup must not assume this elsewhere.

On 2026-11-05, an explicitly owner-authorized live test completed WSL-to-Windows task transfer through the actual Windows Bun helper and the typed task client. The test opened the pinned Browser Settings view, used a separate authorized UI diagnostic to select its own Allow confirmation and Send, and received the exact expected model reply back in WSL. It first checked for drafts and active work, used a new empty conversation, and kept the active tab on extension Settings so page tools had no web-page context. It requested no website, bookmark, or file operation. The diagnostic connection was revoked and detached after the test; Chrome, its tabs, profile, and the test conversation were retained. That test covered the earlier manual-Send workflow. The current adapter starts tasks through a guarded callback after new connection consent; it does not click Send or automate required approvals.

For the earlier manual-Send workflow, `npm run ci` passed 2,575 unit/integration tests, both TypeScript programs, the 50-file artifact audit, and 343 E2E tests. Isolated attached-browser E2E covers both task directions, trusted Send, redaction, cancellation during mutation confirmation, and detach without browser/tab closure. Model responses in those isolated tests were mocked. Actual Windows helper startup, strict ready framing, and stdin-EOF cleanup also passed without requesting a connection.

The automatic-task update passed `npm run check`, 2,599 unit/integration tests, the production build, both TypeScript programs, and the 50-file artifact audit. All 349 E2E scenarios passed in two disjoint runs: `--grep-invert 'controls and dialogs'` covered 329 scenarios, and `tests/e2e/i18n.spec.ts --grep 'controls and dialogs'` covered 20. Splitting the suite avoided the 300-second command limit reached by the combined run. Task coverage includes automatic start, real missing-access approval, permission-only focus changes, same-URL navigation rejection, cancellation, draft protection, slash-text handling, redaction, and unchanged mutation confirmation. These tests use temporary profiles and mocked model responses, not the owner's Windows profile.

This does not establish the updated native Windows workflow, a live Browser-to-Coding round trip through an interactive Pi session, every native permission-denial path, or shutdown/session-replacement behavior in the personal profile. The live diagnostic was a temporary client, not persistent enrollment of the user's running Pi plugin. Run `/reload` and `/browser-connect` in the real Pi session to create its own reviewed connection.

The profile owner, or an explicitly authorized operator, must perform the remaining checks after the build, Chrome extension Reload, and Pi `/reload` steps above. The adapter must not approve its own connection, native permissions, or protected actions:

1. Run `/browser-connect`, enter the public extension ID once, review automatic-task consent, approve Chrome's native connection prompt, and select Browser Settings **Allow local connection** and its confirmation. Verify that the real Side Panel opens and no task starts before one is submitted. Keep it open. On a later connection, verify that the saved ID is reused without another input prompt.
2. Use a small, non-sensitive Pi task with an idle, empty Browser composer. Verify automatic start without another Pi task confirmation or Send. Verify missing provider/site access still requires approval, normal browser-action confirmations remain visible, and only final assistant text returns to Pi.
3. Request a small Browser `coding_task`, confirm its text, and use explicit Pi inbox review, acceptance, and exact-answer confirmation. Verify no automatic transcript export or delegation back.
4. Cancel or revoke approval and inspect uncertain effects. Check Browser session changes and panel closure without replay. Check Pi disconnect, reload, shutdown, and session replacement: Chrome and all tabs must remain open, the profile must remain intact, and stale local approval must be inspected and revoked before a fresh connection.

See [architecture](architecture.md), [security](security.md), and [permissions and storage](permissions-and-storage.md).

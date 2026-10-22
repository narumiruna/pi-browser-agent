# Pi Browser Agent

Pi Browser Agent is a Chrome-native AI assistant. The Side Panel runs `pi-agent-core` and the browser-compatible built-in provider/model catalog from `pi-ai`. Chat works on any tab; bounded page tools work only on the active, accessible HTTP(S) tab in the focused Chrome window. With separate approval, Pi can also search or inspect recent Chrome bookmarks without a web page.

No local agent process, native host, shell, general filesystem access, pairing secret, or loopback connection is required. Skill import reads only the file you explicitly select.

## Requirements

- Node.js 22.19 or a newer supported even-numbered release
- Chrome 116 or newer
- A credential for at least one supported provider, or a ChatGPT Plus/Pro account with Codex access

## Install and build

```sh
npm ci
npm run build
```

Load the production artifact:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `dist/chrome`.
5. Select the extension action to open the Side Panel.

## First use

1. Open **Settings** and choose the provider and model you want to use.
2. Select **Add credential** from the top-right menu, or **Configure authentication** in Settings. Choose **Sign in with an account** or **Sign in with an API key**, then choose a provider from the filtered list. OpenAI Codex account login asks for access to `auth.openai.com` and `chatgpt.com` before starting its device flow; OpenAI API keys use the separate OpenAI provider.
3. Enter a prompt from any tab. Pi Browser Agent requests the selected provider endpoint; on an accessible HTTP(S) page it also asks for current-site access when needed. It follows the visible web tab automatically, but never reads a protected page.
4. Check **Current page** above the prompt and send your request. The agent can answer without a page, list web tabs and suggest switching to one, or open an HTTP(S) URL when your task needs it. Switching tabs or opening a website requires your confirmation (or a matching prior approval in Balanced/Convenient) and site access; a search query is sent to the search provider only after its exact destination URL is approved. On an ordinary web page, Send still preflights current-site access before the model decides whether to use page tools.
5. To include an image, paste it into the composer, review the preview, and send it with optional text. Choose a model marked **Image input**.
6. To point out a page element, select the cursor-and-dashed-box button beside the microphone, hover the page highlight, and select the target. Review or remove the resulting chip before sending. Selection supports the top-frame DOM and does not activate the target.
7. To let Pi inspect the visible page, ask it to capture the screen and confirm the first screenshot request. Chrome asks for optional all-sites access because its screenshot API requires `<all_urls>` after the temporary `activeTab` grant ends; Pi Browser Agent still captures only the current visible HTTP(S) viewport. A completed screenshot result has an **Annotate screenshot** action; draw locally, attach the rendered image, then select **Send**.
8. To dictate a prompt, select the microphone. The first use opens a full Pi Browser Agent tab where Chrome can request microphone access; approve it, close that tab, select the microphone again, and speak. Select it once more before reviewing and sending the transcript.
9. When Pi requests a bookmark read, review and confirm the search or recent-item limit when the dialog appears. Balanced/Convenient can reuse an identical approval; Chrome asks for the optional bookmark permission the first time.

**Element selection shortcut:** Press **Cmd+Shift+E** on macOS or **Ctrl+Shift+E** on Windows/Linux to open Pi Browser Agent and start selecting a page element. Press it again, or press **Esc**, to cancel selection without closing the panel. If site access is missing, select the picker button when prompted to authorize the site. The shortcut never sends a message. Change its assignment at `chrome://extensions/shortcuts`; another extension or Chrome can leave the suggested key unassigned. The picker tooltip shows the assigned key, refreshed when the panel receives focus. A command waiting for panel startup expires after 10 seconds; page/tab/window changes and worker restart discard it. Retry the shortcut if startup takes longer.

**Browser action confirmations:** Settings offers **Strict** (confirm every protected action), **Balanced** (default on new installations; remember an approved matching action until Chrome restarts), and **Convenient** (remember it across restarts until cleared). Existing installations start in Strict until a mode is selected. Approvals match the action and target: changed WebMCP arguments, bookmark queries, or destination URLs ask again. Submits, downloads, native option selections, actual checkbox/radio state changes, and clicks without a stable target always ask; the same WebMCP call may still have side effects. Use **Clear remembered approvals** in Settings or switch modes to revoke shortcuts. Chrome's own permission prompts and runtime access checks remain separate.

Voice input uses Chrome's Web Speech service in the browser language. Spoken audio may be processed by the browser's speech provider; only the resulting editable transcript is submitted to Pi when you select **Send**. The model transport is always SSE. Closing the Side Panel aborts the active run and marks the session interrupted; reopening never automatically repeats a browser mutation.

Pi Browser Agent registers the browser-compatible built-in `pi-ai` providers and their tool-capable chat model catalogs. Credential setup first selects an authentication method and then shows only providers that support that method in Chrome. API-key authentication is available for browser-compatible providers; OpenAI Codex is currently the only account-login choice and uses the browser device flow. Adding a credential does not change the selected model. Radius models load after configuration. Amazon Bedrock is excluded because its `pi-ai` adapter intentionally loads a Node-only AWS SDK module. Other provider OAuth implementations are Node-only, so Pi Browser Agent exposes only their API-key path. Image-generation providers are separate from chat agents and are not exposed.

## Remote MCP

Open **Settings → Remote MCP servers** to add a public HTTPS Streamable HTTP endpoint and an optional bearer token. Select **Save disconnected**, then **Connect and preview** to approve the exact endpoint and enable its tools. These controls save immediately, independently of other settings.

MCP tools also work without a readable page. Every call requires fresh confirmation in every confirmation mode. Arguments go to the configured server; tool metadata and results can go to the selected model provider and saved session. Cookies, redirects, OAuth, stdio, local bridges, resources, and non-text result blocks are not supported. Closing the panel or changing server settings cancels local work; interrupted calls are never replayed automatically. Cancellation cannot undo server-side effects.

Use **Disable** to stop a server, or **Remove server and token** to delete its configuration and token. See [remote MCP support and limits](docs/mcp.md). Remote MCP is separate from page-provided WebMCP.

## Browser skills

Open **Settings → Skills**, choose a UTF-8 file named exactly `SKILL.md`, and review its plain-text preview before importing. Imports and explicit replacements start disabled. Enable a reviewed skill, then ask for it by name in chat. Importing or enabling sends no model request; a submitted run shares enabled metadata, and the model can request the body with `skills_load({id})`.

Skills provide untrusted, user-authorized task guidance. They cannot grant permissions or bypass browser confirmations. Only text is supported: no scripts, supporting files, remote installation, or local directory discovery. Changes apply to the next run. Disabling or deleting blocks future loads, but previous content remains in saved conversations; deleting sessions does not delete skills. See [format, limits, and recovery](docs/skills.md).

## Browser safety

The agent can read visible text and selection, discover visible controls and scroll containers, scroll the viewport or a container, inspect element details, select native options, capture the visible viewport, click or type using discovered element references or CSS selectors, navigate, and use page WebMCP tools when available. `browser_read_page` accepts optional `selector` (first rendered HTML match, such as `main` or `article`) and `offset` (UTF-16 text index, starting at 0). Without a selector it reads the page body. A long read returns `nextOffset` when truncated; pass it back with the same selector to continue. Invalid, missing, or non-rendered selectors fail rather than falling back to the full page. This reads rendered DOM text, including text outside the viewport, not raw HTML, form field values, or iframe/Shadow DOM contents. To use WebMCP, enable `chrome://flags/#enable-webmcp-testing`, relaunch Chrome, and reload the page; the page must provide WebMCP tools. See [WebMCP status](docs/webmcp.md) for details.

`browser_list_elements` returns up to 50 controls and vertical scroll containers from the current top-frame viewport, with bounded names, types, supported actions, and a snapshot ID. Optional exact `role`/`type` filters, a case-sensitive literal `name` substring, and a matching-result `offset` (0–2,000) refine discovery. `hasMore`/`nextOffset` describe pagination separately from `scanTruncated`; each result page replaces the previous snapshot. The agent passes that snapshot ID and a short reference such as `e1` to click/type tools instead of guessing a selector. References expire after five minutes, another discovery, a successful scroll or option selection, an actual checked-state activation, navigation, tab/focus changes, or worker restart. Rediscover after every scroll, including at a boundary. Removed/replaced controls or changed action metadata require fresh discovery; failed mutations are never automatically replayed. Discovery inspects at most 2,000 DOM elements, reports truncation, excludes password/file targets and field values, and does not enumerate controls inside iframes or Shadow DOM. Controls with zero-opacity CSS filters or computed filter strings exceeding 4,096 UTF-16 units on themselves or filtering ancestors are excluded. For slotted light-DOM controls, filter checks follow exposed assigned slots and shadow hosts, ignoring filters on boxless (`display: contents`) ancestors. Checks include an active modal, popover, or fullscreen root but stop before its outside filtering ancestors; reference mutations recheck these limits. Closed-root slot assignments are not exposed by the standard DOM API.

`browser_scroll` moves up/down by a page, half-page, or 1–10,000 pixels without action confirmation. `browser_get_element_details` returns bounded names, roles, state, geometry, and scrollability without field values. `browser_select_option` uses a discovered native single-select reference and an exact value or label; every change requires fresh confirmation because page handlers can submit or navigate. `browser_get_select_options` reads only native option labels, indices, disabled flags, and label-truncation flags, never raw values or selected-state data; it returns at most 50 entries without invalidating references and rejects catalogs above 2,000 options. This label-only catalog is a narrow exception to the form-content exclusion; hidden options and hidden groups remain excluded. Option pagination uses native indices, not returned-entry counts. `browser_set_checked` supports native checkboxes and radio activation (`true` only). Each actual change requires fresh confirmation in all modes and invalidates references; a no-op sends no events and needs no confirmation. If handlers remove the target or navigate, the final state can be unverified: inspect current state and never replay automatically.

`browser_find_text` accepts a literal case-sensitive query (at most 256 Unicode code points), optional selector, and match-ordinal offset. It returns bounded snippets, source UTF-16 offsets, and optional geometry, never mutation references. It does not scroll. Search collapses whitespace within each Text node, does not match across nodes, and scans at most 2,000 nodes/100,000 source UTF-16 units, including excluded text. Source offsets are not stable after DOM changes. New string inputs use JSON Schema code-point counts; source offsets and bounded snippets use UTF-16 units. Search conservatively excludes masked, rounded-overflow-clipped, rotated, skewed, flipped, and 3D-transformed text; it does not interpret arbitrary visual effects. `browser_wait_for` accepts either a selector state or literal text in an optional selector scope, never both. It defaults to 5,000 ms, caps at 10,000 ms, and polls every 250 ms. Waits remain in the current document; context changes/cancellation fail closed and `TIMEOUT` is distinct from access denial. Neither read renews or replaces references. No code or regular expressions are accepted. See [browser interaction schemas and agent examples](docs/browser-interactions.md). Native key presses and hover are not exposed by the current DOM-only bridge.

- Password and file inputs are denied.
- Form submissions and downloads always prompt; cross-origin links/navigation and WebMCP calls require either fresh confirmation or a matching approval in the selected confirmation mode. No cached approval replays a failed mutation.
- A request created before navigation or a visible-tab change is rejected as stale. Chat and approved bookmark reads do not require a supported page; a no-page turn cannot use page tools even after a tab switch.
- Chrome internal pages, Chrome Web Store pages, local files, and PDF viewers cannot be read or operated by page tools. A site whose URL looks like HTTP(S) but denies script injection also becomes unavailable until navigation/reload. General file/PDF import is not supported; the separate, user-selected `SKILL.md` import does not change that page-tool boundary. Enabling Chrome's file-URL access does not change it.
- Visible text and selected text are capped at 50 KB; screenshots are capped at 3 MB.
- The element picker accepts up to five chips and 16 KB of combined context. It includes bounded visible text, accessibility metadata, an allowlist of attributes, viewport geometry, and a best-effort CSS selector; it excludes field values, hidden text, full HTML, credential-bearing URLs, iframes, and Shadow DOM. Selectors are descriptive hints, not durable mutation authorization.
- Picker mode uses a layout-neutral interaction shield so selecting a button, link, or submit control does not activate it. `Esc`, a repeated button click, selection, navigation, tab/focus change, timeout, or closing the Side Panel cancels the mode. A page-level listener installed before the picker may still observe an intercepted event.
- Screenshot access is optional. Its first confirmation requests Chrome's broad `<all_urls>` capability, but the runtime accepts only the active visible HTTP(S) tab and captures only its viewport.
- Screenshot annotation runs locally, downscales oversized-but-valid captures to a bounded canvas, and limits strokes, points, and output bytes. Attach creates a new normal composer image; only **Send** transmits it. The original result is unchanged, and both images can consume session storage.
- Chrome can treat `<all_urls>` as satisfying narrower host requests. Pi Browser Agent separately records exact origins approved by explicit Send, login, site-access, catalog-load, or cross-origin confirmation actions and requires that approval for ordinary access.
- A message accepts up to four pasted PNG, JPEG, WebP, or GIF images using at most 3 MB in total.
- Page text, selections, selected-element context, screenshot metadata, bookmark data, and WebMCP results are labeled as untrusted model input.
- Bookmark access is optional and absent by default. Every search or recent-bookmark read requires confirmation, returns at most 50 items and 50 KB, and sends the returned titles and URLs to the selected model provider as part of the conversation.
- Chrome's bookmark permission covers reads and writes, but Pi Browser Agent exposes only search and recent-read operations; the production artifact audit rejects bookmark mutation calls.
- Credentials stay in trusted extension storage and are never sent to the service worker, content injection, page context, transcript, or diagnostic export.

## Sessions and settings

Assistant answers support Markdown headings, lists, tables, links, and fenced code. Raw HTML and Markdown images are not rendered; only explicit HTTP(S) links are clickable. Each answer places a labeled **Copy all** action in its bottom action row, while each copyable code block places **Copy code** inside the block's top-right corner. Box-drawing visual examples omit the local copy action. Copy labels temporarily change to **Copying…**, **Copied**, or **Copy failed**, with matching icons, tooltips, and screen-reader status updates. User messages, tool data, and thinking remain plain text.

Each Pi turn groups its activity and final answer in one response card. Production builds replace internal tool names and result payloads with quiet, human-readable activity labels; development builds retain expandable tool diagnostics. Thinking remains expandable, while errors and image results open by default. Manual expansion/collapse and keyboard focus survive streaming updates. The transcript follows new output only while you are near the bottom; when you read older content, one floating button returns to the latest message. Reopening a session restores default disclosure states; it does not change saved messages.

The conversation interface uses English. During a run, **Send** becomes **Add instruction**, and a separate clock control queues the prompt for later. The shorter keyboard hint keeps Enter focused on the primary action.

### Slash commands

Type `/` at the start of the composer to show commands. Use Arrow keys to select, then Tab or Enter to insert the command. Pointer selection also inserts it. Select **Send**, or press Enter again, to execute. Escape closes the command list before it stops a running response. Shift+Enter still inserts a line break.

| Command | Action |
| --- | --- |
| `/new` | Start a new session. |
| `/resume` | Open the saved-session picker. |
| `/tree` | Navigate and create branches in this conversation. |
| `/name [title]` | Rename this session; omit the title to open the name dialog. |
| `/settings` | Open Settings for this session. |
| `/login` | Open credential setup. Enter credentials only in its dialogs. |
| `/logout` | Remove the selected model provider's credential. |

Commands run locally, without a model request or current-site access. They require an idle conversation with no attached images or selected elements. They cannot be queued. Unknown commands, unsupported arguments, and multiline command input show a local error and retain the draft. Canceled dialogs also retain it. Only `/name` accepts an argument.

To send literal slash-prefixed text to the model, start with `//`; Pi removes the first slash and applies normal prompt permissions. Paths such as `/tmp/file` and slashes elsewhere in a message remain ordinary prompts. These commands do not load terminal extensions, skills, or templates. Other terminal commands, including `/compact`, are not supported.

**Conversation branches:** `/tree` opens a local tree without contacting a provider or reading the page. Select a user message to restore its text and images for editing; select a completed response or tool-result boundary to continue after it. **Start of conversation** returns to an empty path. Only an explicit **Send** starts a new response. Other branches remain saved and can be selected after restarting Chrome. Unsent edits are not saved until Send. Restored slash-prefixed prompts get an extra `/` escape so Send preserves model text instead of executing a local command. Use Arrow keys, Home/End, Enter, and Escape to navigate or cancel. Incomplete tool-call boundaries cannot be selected.

Only the active path goes to the model. Switching branches does not undo browser actions and never replays a tool. Saved element descriptions remain untrusted text, not live element references. The current model, instructions, and browser permissions still apply. Unsent drafts or attachments block branch changes instead of being overwritten.

Existing sessions keep their linear history until the first successful tree navigation. All branches and the active transcript projection share the existing 5 MB record limit, with at most 5,000 tree nodes. Large existing records can exceed that limit when tree metadata is added; navigation then fails without changing the saved record. Tree-enabled records do not automatically remove images or old branches to fit. Keep a copy of complete session records before downgrading: older builds can read the active transcript but do not preserve inactive branches when they save.

The Side Panel supports creating, resuming, renaming, and deleting sessions. Complete transcript boundaries, including confirmed bookmark tool results, are stored in versioned IndexedDB records. Storage keeps at most 50 sessions and limits each record to 5 MB. **Clear all session data** removes transcripts and embedded images.

Open **Account and settings** (the fixed avatar button in the top-right) and choose **Settings** to open settings in a full browser tab. The same structured menu contains credential, site-access, and conversation actions, with credential removal separated at the bottom. The settings page lets you choose a provider, model, thinking level (Minimal through Maximum), interface font, and a text size from 12 to 24 px using a slider. Save or close the page to return to the previous tab; the Side Panel conversation remains open. The selected model and thinking level are saved in each session, while the latest selections are used for new sessions. Explicitly changing either in Settings updates the opener's active session after any running response finishes. Settings persist across Side Panel and Chrome restarts. The system prompt and AGENTS-style instructions are also editable and apply to the next run. The extension does not discover instructions from the local filesystem.

All built-in browser tools are enabled by default, including tools added by updates. Use **Settings → Available tools** to disable individual tools. Saved choices apply to the next run; confirmations and Chrome permissions still apply. On upgrade from the older enabled-tool list, the original 14 tools keep their saved choices and later additions are enabled. If you previously disabled one of those later additions, disable it again and save.

## Development

```sh
npm run dev:chrome
npm test
npm run test:e2e:smoke
npm run test:e2e
npm run ci
npm audit --omit=dev
```

Run `npm run build` before either E2E command. The focused smoke test launches a temporary copy of `dist/chrome`, serves a local fixture, and mocks the model response; the full E2E command runs all browser scenarios. Test setup never edits the production artifact.

`npm run build` runs the isolated browser bundle probe, production extension build, typecheck, and artifact security audit. `npm run pack` creates the Chrome zip without publishing anything.

## Release management

Create and commit a changeset for every releaseable change:

```sh
npm run changeset
```

Pushes to `main` create or update the **chore(release): version packages** pull request. Merging that pull request updates `package.json`, `package-lock.json`, `manifest.json`, and `CHANGELOG.md`, creates the matching `vX.Y.Z` GitHub release, and uploads `pi-browser-agent.zip`. The repository must allow GitHub Actions to create pull requests.

## Troubleshooting

- **Provider host access was declined or revoked:** send again and approve the selected endpoint, or reconfigure the provider if its endpoint changed.
- **OpenAI Codex host access was revoked:** select **Add credential** → **Sign in with an account** → **OpenAI Codex (legacy)**, then approve both requested OpenAI origins.
- **A page tool is denied:** ask the agent to use an accessible HTTP(S) tab or open a website, then approve its confirmation. If access was previously declined, use **Account and site access → Allow current site**. Protected pages, local files, and PDF viewers cannot be controlled. Ordinary questions can still be sent without a page.
- **A screenshot is denied:** request it again, confirm Pi Browser Agent's explanation, and approve Chrome's optional all-sites prompt. If the grant was revoked, Chrome asks again; ordinary per-site access is not enough for `captureVisibleTab()`.
- **An annotation will not attach:** choose an image-capable model, add at least one stroke, and remove composer images if the four-image or 3 MB total limit is reached. Editing itself requests no permission and sends nothing until **Send**.
- **The element picker will not start:** make an HTTP(S) page visible and approve current-site access. Press `Esc` or select the active picker button to reset it; navigation and site-access revocation require a fresh selection.
- **A bookmark read is denied:** request it again and approve both Pi Browser Agent's operation confirmation and Chrome's optional permission prompt. Revoke bookmark access from Chrome's extension settings when it is no longer wanted.
- **Expired element reference:** ask for a new element list and review the intended action before trying again. A saved reference is not a current target, and the extension never falls back to another element.
- **Wait timeout:** the requested condition was not observed in the current document. Inspect the page before waiting again; a wait does not follow navigation.
- **Unverified checked state:** activation occurred, but removal or navigation prevented a final state check. Read current state and rediscover before another authorized action; do not replay the activation.
- **Stale context:** the visible tab changed or navigated after the tool request began. Return to the intended page and retry; Pi Browser Agent automatically tracks the visible supported tab.
- **Login pending:** finish the device flow before its 15-minute expiry. Cancel and restart if the code expires or is denied.
- **Refresh failed:** remove the affected credential, then configure that provider again. The extension does not silently fall back to another provider.
- **Voice input unavailable:** select the microphone to open Pi Browser Agent's access tab, choose **Allow microphone access**, and approve Chrome's prompt. If access is blocked, use that tab's **Open Chrome microphone settings** button, remove Pi Browser Agent from **Not allowed**, and retry. Also allow Chrome to use the microphone in your operating-system settings. Voice recognition requires a Chrome version with the Web Speech API and may require network access.
- **Interrupted session:** review the transcript before continuing. Mutation tools are never replayed automatically.

## Documentation

- [Browser interaction tools](docs/browser-interactions.md)
- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Permissions and data storage](docs/permissions-and-storage.md)
- [Privacy policy](PRIVACY.md)
- [Security model](docs/security.md)
- [Manual acceptance](docs/manual-acceptance.md)
- [WebMCP status](docs/webmcp.md)
- [Remote MCP](docs/mcp.md)
- [Browser skills](docs/skills.md)

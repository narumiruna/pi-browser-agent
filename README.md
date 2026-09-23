# Pi Browser Agent

Pi Browser Agent is a Chrome-native AI assistant. The Side Panel runs `pi-agent-core` and the browser-compatible built-in provider/model catalog from `pi-ai`. Chat works on any tab; bounded page tools work only on the active, accessible HTTP(S) tab in the focused Chrome window. With separate approval, Pi can also search or inspect recent Chrome bookmarks without a web page.

No local agent process, native host, shell, filesystem access, pairing secret, or loopback connection is required.

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
4. Check **Current page** above the prompt and send your request. The agent can answer without a page, list web tabs and suggest switching to one, or open an HTTP(S) URL when your task needs it. Switching tabs or opening a website requires your confirmation and site access; a search query is sent to the search provider only after you confirm its destination URL. On an ordinary web page, Send still preflights current-site access before the model decides whether to use page tools.
5. To include an image, paste it into the composer, review the preview, and send it with optional text. Choose a model marked **Image input**.
6. To point out a page element, select the cursor-and-dashed-box button beside the microphone, hover the page highlight, and select the target. Review or remove the resulting chip before sending. Selection supports the top-frame DOM and does not activate the target.
7. To let Pi inspect the visible page, ask it to capture the screen and confirm the first screenshot request. Chrome asks for optional all-sites access because its screenshot API requires `<all_urls>` after the temporary `activeTab` grant ends; Pi Browser Agent still captures only the current visible HTTP(S) viewport. A completed screenshot result has an **Annotate screenshot** action; draw locally, attach the rendered image, then select **Send**.
8. To dictate a prompt, select the microphone. The first use opens a full Pi Browser Agent tab where Chrome can request microphone access; approve it, close that tab, select the microphone again, and speak. Select it once more before reviewing and sending the transcript.
9. When Pi requests a bookmark read, review the requested search or recent-item limit and confirm it. Chrome asks for the optional bookmark permission the first time.

Voice input uses Chrome's Web Speech service in the browser language. Spoken audio may be processed by the browser's speech provider; only the resulting editable transcript is submitted to Pi when you select **Send**. The model transport is always SSE. Closing the Side Panel aborts the active run and marks the session interrupted; reopening never automatically repeats a browser mutation.

Pi Browser Agent registers 39 built-in `pi-ai` chat providers and their tool-capable model catalogs. Credential setup first selects an authentication method and then shows only providers that support that method in Chrome. API-key authentication is available for browser-compatible providers; OpenAI Codex is currently the only account-login choice and uses the browser device flow. Adding a credential does not change the selected model. Radius models load after configuration. Amazon Bedrock is excluded because its `pi-ai` adapter intentionally loads a Node-only AWS SDK module. Other provider OAuth implementations are Node-only, so Pi Browser Agent exposes only their API-key path. Image-generation providers are separate from chat agents and are not exposed.

## Browser safety

The agent can read visible text and selection, discover visible interactive elements, capture the visible viewport, click or type using discovered element references or CSS selectors, navigate, and use page WebMCP tools when available.

`browser_list_elements` returns up to 50 controls from the current top-frame viewport, with bounded names, types, supported actions, and a snapshot ID. The agent passes that snapshot ID and a short reference such as `e1` to click/type tools instead of guessing a selector. References expire after five minutes, another discovery, navigation, tab/focus changes, or worker restart. Removed/replaced controls or changed action metadata require fresh discovery; failed mutations are never automatically replayed. Discovery inspects at most 2,000 DOM elements, reports truncation, excludes password/file targets and field values, and does not enumerate controls inside iframes or Shadow DOM. Controls with zero-opacity CSS filters or computed filter strings exceeding 4,096 UTF-16 units on themselves or filtering ancestors are excluded. For slotted light-DOM controls, filter checks follow exposed assigned slots and shadow hosts, ignoring filters on boxless (`display: contents`) ancestors. Checks include an active modal, popover, or fullscreen root but stop before its outside filtering ancestors; reference mutations recheck these limits. Closed-root slot assignments are not exposed by the standard DOM API.

- Password and file inputs are denied.
- Form submissions, downloads, cross-origin links, cross-origin navigation, and all WebMCP calls require confirmation.
- A request created before navigation or a visible-tab change is rejected as stale. Chat and individually confirmed bookmark reads do not require a supported page; a no-page turn cannot use page tools even after a tab switch.
- Chrome internal pages, Chrome Web Store pages, local files, and PDF viewers cannot be read or operated by page tools. A site whose URL looks like HTTP(S) but denies script injection also becomes unavailable until navigation/reload. No file/PDF import is provided in this release; enabling Chrome's file-URL access does not change that boundary.
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

The Side Panel supports creating, resuming, renaming, and deleting sessions. Complete transcript boundaries, including confirmed bookmark tool results, are stored in versioned IndexedDB records. Storage keeps at most 50 sessions and limits each record to 5 MB. **Clear all session data** removes transcripts and embedded images.

Open **Account and settings** (the fixed avatar button in the top-right) and choose **Settings** to open settings in a full browser tab. The same structured menu contains credential, site-access, and conversation actions, with credential removal separated at the bottom. The settings page lets you choose a provider, model, thinking level (Minimal through Maximum), interface font, and a text size from 12 to 24 px using a slider. Save or close the page to return to the previous tab; the Side Panel conversation remains open. The selected model and thinking level are saved in each session, while the latest selections are used for new sessions. Explicitly changing either in Settings updates the opener's active session after any running response finishes. Settings persist across Side Panel and Chrome restarts. The system prompt and AGENTS-style instructions are also editable and apply to the next run. The extension does not discover instructions from the local filesystem.

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
- **OpenAI Codex host access was revoked:** select **Add credential** → **Sign in with an account** → **OpenAI Codex**, then approve both requested OpenAI origins.
- **A page tool is denied:** ask the agent to use an accessible HTTP(S) tab or open a website, then approve its confirmation. If access was previously declined, use **Account and site access → Allow current site**. Protected pages, local files, and PDF viewers cannot be controlled. Ordinary questions can still be sent without a page.
- **A screenshot is denied:** request it again, confirm Pi Browser Agent's explanation, and approve Chrome's optional all-sites prompt. If the grant was revoked, Chrome asks again; ordinary per-site access is not enough for `captureVisibleTab()`.
- **An annotation will not attach:** choose an image-capable model, add at least one stroke, and remove composer images if the four-image or 3 MB total limit is reached. Editing itself requests no permission and sends nothing until **Send**.
- **The element picker will not start:** make an HTTP(S) page visible and approve current-site access. Press `Esc` or select the active picker button to reset it; navigation and site-access revocation require a fresh selection.
- **A bookmark read is denied:** request it again and approve both Pi Browser Agent's operation confirmation and Chrome's optional permission prompt. Revoke bookmark access from Chrome's extension settings when it is no longer wanted.
- **Expired element reference:** ask for a new element list and review the intended action before trying again. A saved reference is not a current target, and the extension never falls back to another element.
- **Stale context:** the visible tab changed or navigated after the tool request began. Return to the intended page and retry; Pi Browser Agent automatically tracks the visible supported tab.
- **Login pending:** finish the device flow before its 15-minute expiry. Cancel and restart if the code expires or is denied.
- **Refresh failed:** remove the affected credential, then configure that provider again. The extension does not silently fall back to another provider.
- **Voice input unavailable:** select the microphone to open Pi Browser Agent's access tab, choose **Allow microphone access**, and approve Chrome's prompt. If access is blocked, use that tab's **Open Chrome microphone settings** button, remove Pi Browser Agent from **Not allowed**, and retry. Also allow Chrome to use the microphone in your operating-system settings. Voice recognition requires a Chrome version with the Web Speech API and may require network access.
- **Interrupted session:** review the transcript before continuing. Mutation tools are never replayed automatically.

## Documentation

- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Permissions and data storage](docs/permissions-and-storage.md)
- [Privacy policy](PRIVACY.md)
- [Security model](docs/security.md)
- [Manual acceptance](docs/manual-acceptance.md)
- [WebMCP status](docs/webmcp.md)

# Manual acceptance

Use a production build from `npm run build`. Do not test login with development output or record tokens, authorization codes, screenshots, or account IDs.

## Recorded environment

- Extension: `pi-browser-agent` 0.1.0
- `@earendil-works/pi-agent-core`: 0.85.1
- `@earendil-works/pi-ai`: 0.85.1
- Automated browser round trips: Google Chrome for Testing 153.0.8010.12
- Manual browser: Google Chrome 152.0.7977.83
- Real-account device login: passed on 2026-09-16; account tier was not recorded
- Authenticated SSE and browser-tool round trip: pending; the first request exposed a retired `gpt-5.4` default, which was replaced with `gpt-5.6-terra` before retry
- Optional bookmark permission and read-only bookmark round trip: pending for this change
- Optional screenshot `<all_urls>` grant and PNG/model round trip: passed on 2026-09-20; browser version was not recorded. The first capture detected a visible-tab change as stale, and the model retried successfully against the current tab.
- Optional screenshot native decline, revocation, and explicit cross-tab capture: pending for this change
- Non-Codex provider/model selection and authenticated request: pending for this change
- Element discovery and Markdown/disclosure automated acceptance: passed on Chrome for Testing 153.0.8010.12, including a real MV3 worker restart, mocked model discovery/type/click/submit confirmations, incremental SSE, copy denial, focus/scroll, hostile content, and restored transcripts.
- Element discovery and Markdown/disclosure manual report: on 2026-09-21 the user reported “實測看起來都正常” (actual testing looks normal), following the icon-only/right-aligned copy update. Chrome version, account tier, and individual case results were not supplied; the acceptance record remains incomplete. Do not infer those details or substitute the headless extension-page harness for browser-owned Side Panel checks.
- Screenshot annotation stable-Chrome acceptance: pending. Automated Chrome-for-Testing coverage verifies dialog cancel, mouse drawing, changed pixels, undo, clear, width, output-limit failure, attach/remove, image-only Send, queued follow-up, provider payload uniqueness, and session restore. Touch/pen, browser-owned Side Panel light/dark/narrow layout, interrupted run, and full Chrome restart remain manual.
- Element picker stable-Chrome acceptance: pending. Automated Chrome-for-Testing coverage verifies highlight pixels, button/link/submit prevention, dynamic replacement and scroll, repeated toggle, page/panel `Esc`, SPA navigation, panel and service-worker restart cleanup, denied/revoked site access, element-only provider context, and session restore. Browser-owned Side Panel light/dark/narrow layout, residual capture-listener behavior, revocation through Chrome UI, timeout observation, and full Chrome restart remain manual.
- Chat without a supported page: automated Chrome-for-Testing coverage in `tests/e2e/chat-without-page.spec.ts` checks protected Chrome/new-tab/Web Store, local files with file-URL access enabled and disabled across a Chromium restart, local/network PDF, pure chat with denied page tool, confirmed bookmark read, choosing a web tab, context-free toggle, and explicit work-tab confirmation. Stable-Chrome browser-owned Side Panel/light-dark/reduced-motion checks remain for release review; there is no local-file/PDF reading in this build.

- Browser confirmation modes: automated `tests/e2e/confirmation-modes.spec.ts` passed on Chrome for Testing 153.0.8010.12. It covers Strict/Balanced/Convenient bookmark prompts, changed request limits, decline and retry, Side Panel and MV3 worker restart, full Chromium restart, Convenient clear, and WebMCP tool/argument matching. Stable Chrome native permission prompts and browser-owned Side Panel verification remain pending before release.

## Element-picker shortcut acceptance — 2026-10-15

- Status: implementation and automated validation are complete; stable-Chrome physical-key acceptance remains pending. The user reported loading the extension, but did not yet report a shortcut result.
- Host: macOS; installed stable Google Chrome `155.0.8059.79`.
- An isolated minimal extension probe used a fresh temporary profile and a visible browser. `--load-extension` did not load an extension service worker; CDP `Extensions.loadUnpacked` returned `Method not available`, including with `--enable-unsafe-extension-debugging`. No command event, physical shortcut, or Side Panel opening was verified.
- The Chrome DevTools MCP launch also failed because its configured Linux executable is absent on this host.
- Automated verification after the CI readiness fix: `npm run ci` passed with 480 unit/integration tests and all 69 E2E tests using the default four local workers. The harness now waits for `data-conversation-ready="true"`, set only after complete conversation initialization, on startup, credential reload, and browser restart. A delayed-initialization regression test and an independent full-browser session-restore test are in `tests/e2e/extension-lifecycle.spec.ts`. Earlier parallel failures remain recorded in the plan; no stable-Chrome physical-key acceptance is inferred from automated results.
- Automated command tests use a test-only worker callback and stub native `sidePanel.open()`; they do not prove real shortcut dispatch or browser-owned panel opening. Unit tests cover intent expiry, acknowledgements, wrong-window/sender rejection, disconnect, and restart without replay.
- For manual acceptance, run `npm run build`, reload the extension at `chrome://extensions`, and check the assigned key at `chrome://extensions/shortcuts`. On an approved HTTP(S) page, close the panel and press `Cmd+Shift+E` (macOS) or `Ctrl+Shift+E` (Windows/Linux). Expected: the panel opens and the picker starts. Repeat with the panel open and with focus in the page and panel. Press again or press `Esc`: selection stops and the panel remains open. Select a button: one unsent chip appears, the button does not activate, and no message is submitted.
- Repeat after stopping the service worker through extension DevTools. Retry if startup exceeds 10 seconds. Without site approval, expect a prompt to click the picker button, no automatic permission request, and no selection until explicit authorization. Verify permission decline/revocation, restricted pages and PDFs, tab changes during startup, repeated presses during startup, and a conflicting or unassigned shortcut. Record each result and Chrome/OS version here.
- macOS physical-key acceptance and all Windows/Linux acceptance remain pending. No successful stable-Chrome result is inferred from the user's installation report. See `docs/plans/2026-10-15_element-picker-shortcut-plan.md`.

## Slash-command acceptance — 2026-10-22

Automated coverage is in `tests/unit/slash-commands.test.ts`, `tests/unit/slash-command-menu.test.ts`, `tests/unit/slash-command-routing.test.ts`, `tests/unit/authentication-actions.test.ts`, and `tests/e2e/slash-commands.spec.ts`. The 13 focused browser cases passed on headless Chrome for Testing 156.0.8078.4 on macOS, including local command effects, network isolation, lifecycle races, native-textbox semantics, active-option scrolling, and 320 px light/dark layout at 24 px text. Actual screen-reader output and the browser-owned Side Panel remain unverified; automated extension-page tests do not prove these paths.

[GitHub CI run 39751534461](https://github.com/narumiruna/pi-browser-agent/actions/runs/39751534461) passed the full required workflow on Ubuntu/Node 26, with 799 unit/integration tests and 112 browser tests against the feature merged with updated `main`. Local macOS readiness and duration failures remain recorded in `docs/plans/2026-10-22_slash-commands-plan.md`; they are not evidence of manual acceptance.

Before release, load a production build in stable Chrome and record Chrome/OS versions, assistive technology/version, and each result:

1. With focus in the composer, type `/`. Use Arrow keys, Tab, and Enter to select a command. Expected: the screen reader announces the command list, active name/description, and expanded/collapsed state. Selection inserts text and does not execute. Enter again executes. Escape closes the list; during a response, a second Escape stops the response. Shift+Enter and IME composition must not execute a command.
2. Repeat using pointer input at 320–360 px panel width, 24 px text, and light/dark appearance. Expected: commands remain readable, the selected option stays visible, there is no horizontal scrolling, and controls are not clipped.
3. On `chrome://settings` with no configured credential, run `/new`, `/name Test`, `/resume`, and `/settings`. Expected: local actions work with no model or current-site permission request. Cancel the name and credential dialogs; their command drafts remain. Use `/logout` with no credential; expect a local not-configured status. Configure a dedicated test credential through `/login` and remove it with `/logout`; another provider's credential must remain.
4. Attach an image or selected element and try a command. Expected: the draft and attachment remain with a local error. Try `/login secret`, an unknown command, and a multiline command; none reaches the provider. During a response, try Send and Queue with a command; neither interrupts nor queues it. Send `//name literal` as an ordinary prompt only when its content is safe to share; the model receives `/name literal` after normal access checks.

Status: manual checks pending. Record observed results here; do not infer them from automated checks.

## Conversation-tree acceptance — 2026-10-22

Use a dedicated test conversation and a harmless page. Automated graph/store/runtime/dialog/browser tests verify branch preservation, legacy compatibility, active-path isolation, write failure, and no automatic tool replay. Actual screen-reader announcements and the browser-owned stable-Chrome Side Panel remain unverified until observed results are recorded.

1. Send two requests, open `/tree`, and choose the first user message. Expected: its text and images return as an unsent draft; the transcript stops before that request. Edit and Send. Reopen the tree and select the original completed answer: both paths remain, and only the selected path is shown. Return to **Start of conversation**, send a third request, and verify the previous roots remain selectable.
2. Close the panel and restart stable Chrome. Expected: the selected path and all inactive branches remain. A historical click or other browser mutation must not run again during selection or restart. Tree navigation does not undo its earlier page effect. An incomplete tool-call boundary is visible but unavailable.
3. With a screen reader, open the tree and use Arrow keys, Home/End, Enter, Space, and Escape. Expected: the tree label, message role/summary, depth, current position, and unavailable boundaries are announced. Cancel changes neither history nor composer. During a save, duplicate selection and cancel are blocked until it settles.
4. Repeat at 320–360 px Side Panel width and 24 px text in light/dark appearance. Expected: labels wrap without horizontal scrolling, keyboard focus remains visible, and the active entry scrolls into view.
5. In the test conversation, try navigation with an unsent draft, pasted image, selected-element chip, or a running response. Expected: local errors retain the draft, attachments, and active path. Restored user images remain unsent until Send; stale element descriptions do not become live chips. No provider/site access prompt occurs merely from opening or choosing a tree entry.
6. Review the documented 5 MB total-record/5,000-node limits and downgrade warning before testing any older build. Do not downgrade against real tree-enabled data without preserving complete session records. Size or transaction failures must leave the previous saved path and branches intact and show an error; no branch is silently pruned.

Automated acceptance: [GitHub CI run 39792122881](https://github.com/narumiruna/pi-browser-agent/actions/runs/39792122881) passed the required workflow with 922 unit/integration tests and all 123 browser tests. Earlier local and remote timeout failures remain recorded in `docs/plans/2026-10-22_session-tree-plan.md`; no assertion or required test was waived.

Status: manual checks pending. Record Chrome/OS and assistive-technology versions with observed results. Do not infer manual acceptance from headless tests.

## Procedure

1. **Clean setup and Side Panel header**
   - Remove prior extension data, run `npm run build`, and load `dist/chrome` unpacked.
   - Confirm the action opens the Side Panel and no native or local process is running.
   - Expected: Chrome's native header shows one blue-purple Pi icon and one **Pi Browser Agent** title; the extension content does not repeat that branding.
   - Resize the Side Panel through normal and 320–360 px widths in light and dark themes, including 24 px text. Expected: the session selector, new-session button, session actions, and gear menu share one header row; both menus open without clipping and there is no horizontal page scrolling. The current URL is not repeated.
   - Check the idle and working states. Expected: run status sits at the bottom-left of the input card. While idle, microphone and **Send** sit at the bottom-right. While working, **Stop**, the clock-shaped **Queue for later** control, and **Add instruction** appear without overlapping. The keyboard hint describes only Enter and Shift+Enter; long status text truncates with its full value available on hover.
   - Repeat the conversation check with Chrome's preferred language set to Traditional Chinese. Expected: the interface remains in English, including **You**, **Thinking**, **Working**, **Stop**, **Send**, and **Add instruction**; Pi remains the assistant name.
   - Open the top-right gear menu, choose **Settings**, select a different font, drag the font-size slider, and save. Expected: Settings opens in a new full browser tab while the Side Panel conversation remains intact; saving closes the Settings tab, returns to the previous tab, updates the full interface, and both choices remain after closing and reopening the Side Panel.
   - Inspect the provider and model selectors. Expected: Amazon Bedrock is absent, Radius explains that configuration is needed before models load, and model capabilities identify reasoning and image input.
   - Confirm Settings offers only **Strict**, **Balanced**, and **Convenient** for browser action confirmation. New installations start in Balanced; an upgraded profile without this preference remains Strict. In each mode, confirm a repeated bookmark query and WebMCP call with exactly the same arguments, then repeat with changed query/arguments. Strict asks every time; Balanced and Convenient skip only identical matches. Submits and downloads still ask every time. Check dialog lifetime wording and **Clear remembered approvals**.
   - Restart the entire stable Chrome browser without clearing extension data. Balanced must ask again on the first matching request and then remember it for the new browser session. Convenient must not ask again for the same request; after **Clear remembered approvals** it must. Check that closing only the Side Panel or restarting the extension service worker does not clear Balanced. Revoke the Chrome bookmark/site permission and verify a cached match cannot silently regrant it. Record Chrome version, prompts, and results here before release. **Pending manual acceptance:** stable Chrome and browser-owned prompts have not yet been verified for this change.
2. **Authentication method and API-key provider**
   - Select **Configure authentication** in Settings. Expected: **Sign in with an account** and **Sign in with an API key** appear before any provider choice.
   - Choose **Sign in with an API key**. Expected: the searchable provider list includes **OpenAI** and excludes **OpenAI Codex (legacy)**. Choose **Back**, then cancel; no credential or model changes.
   - Repeat from **Add credential** in the Side Panel menu, choose the API-key method and a non-Codex provider, and enter a dedicated test API key.
   - Expected: secret prompts mask and clear input, status names the provider and API-key method without showing the key, and Chrome does not request provider endpoint access during static credential entry. The active and pending model selections remain unchanged.
   - Repeat setup, cancel at the secret prompt, and verify the existing key remains usable. Complete setup with a replacement test key and verify only that provider's credential changes.
   - Select the configured provider, model, and a different thinking level in Settings, save, reopen Settings to confirm the level persists, and send a harmless prompt. Expected: Chrome requests only the current page and selected provider endpoint origins; the response streams over SSE and the session records the selected provider/model.
   - Close and reopen the Side Panel, switch sessions, and create a new session. Expected: each existing session restores its own model and a new session uses the latest selection.
   - Remove the credential and retry. Expected: the request is blocked until that provider is configured again.
3. **Device login**
   - Select **Add credential** → **Sign in with an account**. Expected: only browser-safe account providers appear; the current build lists **OpenAI Codex (legacy)**, not **OpenAI** or Node-only OAuth methods.
   - Select **OpenAI Codex (legacy)** and verify Chrome asks only for `auth.openai.com` and `chatgpt.com`. Deny once; expected: setup fails closed, any prior Codex credential remains unchanged, and no device request starts.
   - Retry, approve access, open the displayed verification URL, enter the code, and finish login.
   - Expected: the panel reports **OpenAI Codex (legacy) configured with an account** without showing an access or refresh token.
4. **Text SSE response**
   - Make a harmless HTTP(S) page visible and ask for a one-sentence summary without using a bind command.
   - Expected: the Side Panel shows the page automatically, text appears incrementally, and DevTools shows an HTTPS request to `chatgpt.com/backend-api`, with no browser WebSocket or loopback request.
5. **Clipboard image round trip**
   - Copy a PNG, JPEG, WebP, or GIF image and paste it into the composer.
   - Expected: a removable preview appears; sending with optional text shows the image in the transcript and lets the model inspect it.
   - Reopen the session and confirm the image still renders. Try an image larger than 3 MB and confirm it is rejected without being attached.
6. **Voice input**
   - In a clean profile, select the microphone in the composer. Expected: Pi Browser Agent opens a full access tab because Chrome suppresses microphone prompts in the Side Panel.
   - Select **Allow microphone access**, approve Chrome's prompt, close the access tab, select the composer microphone again, and dictate a short phrase.
   - Expected: the button shows a listening state, interim text appears in the composer, and selecting the microphone again leaves an editable transcript without sending it.
   - Deny microphone access in a clean profile. Expected: the access tab reports that Chrome blocked access, offers to open Chrome microphone settings, and text entry remains usable. Remove Pi Browser Agent from **Not allowed**, retry the grant, and verify dictation works.
7. **Browser tool and optional screenshot round trip**
   - In a clean profile, ask the agent to read a unique heading, capture the visible page, type into a non-sensitive test field, and click an ordinary button.
   - Expected on the first screenshot: Pi Browser Agent explains that Chrome grants all-sites access while Pi Browser Agent captures only the visible HTTP(S) viewport. Cancel once and verify no permission prompt or image result appears. Ask again, confirm, decline Chrome's native prompt, and verify the confirmation stays open with an access error. Ask a third time and grant access; verify a PNG result appears.
   - Switch to another HTTP(S) tab without clicking the extension action and capture again. Expected: the Side Panel follows it and capture succeeds from the persisted optional grant. Switch to an internal Chrome page and confirm no page remains targeted.
   - Revoke all-sites access in Chrome's extension settings and request another screenshot. Expected: Pi Browser Agent returns to the explicit confirmation flow and never requests access in the background.
   - Expected: the read output is marked untrusted and each operation affects only the currently visible HTTP(S) tab.
   - Ask it to submit a form or call a WebMCP tool.
   - Expected: the operation waits for explicit confirmation.
8. **Read-only bookmark access**
   - Add two distinctive test bookmarks and note their exact titles, URLs, and folders. Ask Pi to search for one distinctive title.
   - Expected: Pi Browser Agent first shows an operation confirmation stating that returned titles and URLs go to the selected model provider and the session. Cancel it and verify no result appears.
   - Ask again, confirm the operation, and decline Chrome's native optional bookmark prompt. Expected: the confirmation stays open, an access error appears inside the dialog, and no bookmark result is sent.
   - Ask again, confirm the operation, and grant Chrome's optional bookmark prompt. Expected: only matching bounded results appear, labeled as untrusted bookmark data. Ask for recent bookmarks and approve its separate confirmation.
   - Revoke bookmark access in Chrome's extension settings and approve another read. Expected: the read fails without retrying, requesting background access, or changing any bookmark.
   - Recheck both test bookmarks in Chrome's bookmark manager. Expected: titles, URLs, folders, and ordering are unchanged. Delete the test bookmarks manually after recording results.
9. **Refresh**
   - Use **Refresh credential** if exposed in the tested build, or repeat a request after the token reaches refresh eligibility in a controlled test profile.
   - Expected: one refresh request succeeds, the session continues, and no credential appears in logs or storage outside trusted local storage.
10. **Permission revocation**
   - Revoke either OpenAI origin in Chrome extension settings, then send a prompt.
   - Expected: the active run aborts, the panel changes to **OpenAI Codex (legacy) not configured**, and the next request is blocked until login. No fallback host is contacted.
11. **Interruption and restart**
   - Start a response, close the Side Panel, reopen it, then restart Chrome.
   - Expected: the last complete transcript returns, the session is marked interrupted when applicable, and no click, type, navigation, or WebMCP call repeats automatically.
12. **Logout and deletion**
   - Select **Remove credential**, then attempt a request.
   - Expected: the request is blocked until login.
   - Delete one session and use **Clear all session data**; verify associated image content is no longer listed.
13. **Artifact inspection**
   - Run `npm run audit:artifact` and inspect `chrome://extensions` permissions.
   - Expected: the audit passes; `bookmarks` and screenshot `<all_urls>` access are optional rather than required, `host_permissions` is empty, and there is no bookmark mutation call, loopback URL, remote code, source map, native host, or unexpected host permission.

14. **Discovered element targets**
   - On a harmless test form in the actual Side Panel, ask Pi to list controls, fill an ordinary field, and click a button using the returned snapshot ID and short reference. Expected: no guessed selector is needed, only the named control changes, password/file targets and field values are absent from discovery, and no new permission type is requested.
   - Ask for a submit, cancel the confirmation, and verify no submit occurs. Ask again and approve; verify one submit. Replace the target DOM node or change its form/link destination while confirmation is open, then approve; expected: stale-target failure with no mutation or alternate target.
   - Retain a reference, navigate/reload, switch away and back, or wait more than five minutes, then request that exact old reference. Expected: failure requiring rediscovery, not automatic retry. Reopening a saved transcript does not reactivate historical references.
15. **Markdown, activity, and streamed disclosures**
   - Request an answer containing headings, a table, fenced code, thinking when supported, and a tool call. Expected: each Pi turn uses one response card containing subdued activity followed by the visible Markdown answer. Production output uses labels such as **Read the page**, never an internal name such as `browser_read_page`, and does not expose ordinary text result payloads. A development build may expose raw tool diagnostics. Thinking remains expandable; errors/image results open by default.
   - While text streams, toggle a disclosure using Enter/Space, leave focus on its summary, and scroll upward. Expected: expansion/focus survive subsequent chunks and completion, and the transcript does not jump to the bottom. Reopen the session; Markdown/images remain readable and disclosure defaults return.
   - Locate **Copy all** in the answer's bottom action row and **Copy code** in each copyable code block's top-right corner. Expected: both buttons have visible text and distinct icons, work with Enter/Space, and have an unambiguous spatial relationship to their content. Box-drawing visual examples have no local copy button. Select each button, then paste into a scratch field. Expected: original Markdown and code text respectively, with no thinking/tool payload added. Pending, success, and failure states temporarily replace the visible label and icon and update the tooltip and screen-reader status before returning to the default label. Deny Clipboard API access in a controlled test context; expected: **Copy failed**, no permission expansion, and no uncaught error.
   - Inspect at 320 and 360 px widths, 12 and 24 px text, and light/dark themes. Expected: tables/code scroll locally, no page-level horizontal overflow, and keyboard controls remain usable.
   - Render a controlled answer containing literal HTML, an unsafe link, and a remote Markdown image. Expected: no executable/embedded content, no unsafe link, and no request to the remote image destination. Only a user click opens an allowed HTTP(S) link.
16. **Screenshot annotation**
   - Complete a visible-viewport screenshot, select **Annotate screenshot**, and test mouse, touch, and pen where hardware is available. Expected: drawing follows the pointer at normal and resized Side Panel widths; pen width, Undo, Clear, Cancel, `Esc`, and Attach work; no stroke means Attach stays disabled.
   - Cancel once and verify no composer preview, provider request, or saved image appears. Reopen, draw, attach, remove the preview, then attach again and send an image-only prompt. Expected: one removable preview, one annotated raster in the provider request, and a restored user image after Side Panel and Chrome restart. The original screenshot remains unchanged and retains its disclosure state.
   - Repeat while a run is active using normal Enter and Alt+Enter. Expected: steer and follow-up each carry one annotated image, only accepted attachment IDs clear, and interrupted runs do not resend the image. Use a non-image model and a near-3 MB composer to verify clear capability/size errors without closing the editor.
   - Check light/dark themes, 320–360 px width, 12/24 px text, and touch scrolling outside the canvas. Expected: the modal and toolbar remain usable without page-level horizontal overflow. Confirm `chrome://extensions` shows no new permission.
17. **Page element picker**
   - On a controlled HTTP(S) page, select the cursor-and-dashed-box button beside the microphone. Expected: the Chinese hover tooltip reads **選取網頁元素**, `aria-pressed` becomes true, and hover shows a layout-neutral outline/label that follows scrolling and a dynamically replaced node.
   - Select an ordinary button, same-origin and cross-origin links, a download, and a submit control. Expected: no handler, URL, download, or form state changes; picker mode exits; a removable chip appears. Inspect the submitted provider request and confirm versioned untrusted JSON contains bounded tag/accessibility/rectangle/viewport/selector fields but no input value, password/file data, hidden text, full HTML, or URL credentials.
   - Test element-only Send, active-run steering, Alt+Enter follow-up, chip removal, five-item and 16 KB limits, duplicate selection, session switch, and tab-context change. Expected: only accepted attachment IDs clear, unsent chips do not persist, and sent JSON restores as user-message text.
   - Test repeated toggle, Side Panel and page `Esc`, timeout, reload, SPA navigation, tab activation, focus loss, Side Panel close/reopen, service-worker restart, site-access denial, and revocation in Chrome settings. Expected: no overlay or reusable token remains. Confirm iframe and Shadow DOM targets are outside this version's supported scope, no new permission type appears, and an earlier page-level capture listener may observe an intercepted event even though target/default activation is blocked.
   - Repeat in light/dark themes, 320–360 px width, and 12/24 px text. Expected: chips scroll within the composer, picker/voice/Stop/Send controls remain usable, and there is no horizontal page overflow.

18. **Chat without a supported page**
   - Open `chrome://settings`, a new tab, and the Chrome Web Store in turn. Expected: **Current page** identifies the page as not readable/operable, the picker is disabled, and Send remains available. Ask a plain question and an explicitly confirmed bookmark question; expected: only the model endpoint or a separately approved bookmark read is used, no page permission is requested and no page is read.
   - On a protected page, ask the agent to read an existing web tab. Expected: it lists bounded web-tab metadata, requests confirmation and site access before switching, then reads only the newly active tab. Deny confirmation; expected: no tab switches. Ask a context-free question, then switch tabs during the run. Expected: page tools stay disabled, including for queued instructions.
   - On a protected page, ask the agent to open a test URL or search URL. Cancel confirmation; expected: no tab opens. Confirm once; expected: exactly one new HTTP(S) tab opens and the protected tab remains unchanged. Confirm the query and destination before any third-party search request. Check site-access denial, cross-origin navigation, form submission, and download confirmations still fail closed.
   - Open a local text file and local/network PDF (including a PDF served from an extensionless HTTP(S) URL) with Chrome's file access disabled, then toggle **Allow access to file URLs** in `chrome://extensions` and retry. Expected: chat remains possible but page read, capture, picker, and operation remain unavailable in both states; no file path or PDF content is sent to the provider. If Chrome offers **Send selection to Pi Browser Agent** in the PDF viewer, select text and click it; expected: no PDF selection appears in the composer or queued instruction, and no PDF text is sent to the provider. Repeat on an ordinary HTTP(S) page and confirm its selection still arrives. Review narrow (320–360 px), dark theme, keyboard focus, status labels, and reduced motion. Record stable-Chrome results separately; an automated headless test is not proof of browser-owned Side Panel rendering.

19. **Remote MCP servers**
   - Use a dedicated HTTPS test server and a least-privilege token. Save it disconnected in Settings; verify no network request occurs until **Connect and preview**. Decline Chrome host access once, then grant it. Verify the tool preview is plain text and the password field clears. MCP controls save independently of other Settings controls.
   - Send a no-page prompt that calls one server tool. Review the exact endpoint, tool, and complete arguments, cancel once, then approve. Repeat in Strict, Balanced, and Convenient; every call must ask again. Inspect network requests for omitted cookies and no redirects or fallback destination.
   - Edit the endpoint path or port. Expected: it disconnects and the old token is not transferred. Replace/remove the token and reconnect. Disable or remove a server while a confirmation or delayed call is active; expected: pending local work cancels, no call is replayed, and removal deletes the token.
   - Revoke the server's host permission during a delayed call, close/reopen the Side Panel, and restart Chrome. Expected: cancellation, retained complete history, and no automatic connection or tool replay. Check remote state separately; cancellation cannot undo side effects.
   - Try a redirecting endpoint, a server that rejects extension origins, malformed or oversized responses, an unsupported schema/result block, and a timed-out call. Expected: a fixed bounded error without a token or raw server error, no proxy, no resource fetch, and no automatic retry. Disable an unavailable server and verify ordinary chat still works.
   - Check keyboard access, narrow width, light/dark themes, and token absence from model requests, transcripts, worker messages, and diagnostics. Automated HTTPS-fixture coverage is in the two remote MCP E2E suites. Stable-Chrome Side Panel layout and native permission-dialog acceptance remain a release-review check; no manual success is claimed here.

Record date, stable Chrome version, account tier, each pass/fail result, and any network-header difference in the pull request before release review. This repository does not publish or release from this procedure.

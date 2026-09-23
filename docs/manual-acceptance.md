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
2. **Authentication method and API-key provider**
   - Select **Configure authentication** in Settings. Expected: **Sign in with an account** and **Sign in with an API key** appear before any provider choice.
   - Choose **Sign in with an API key**. Expected: the searchable provider list includes **OpenAI** and excludes **OpenAI Codex**. Choose **Back**, then cancel; no credential or model changes.
   - Repeat from **Add credential** in the Side Panel menu, choose the API-key method and a non-Codex provider, and enter a dedicated test API key.
   - Expected: secret prompts mask and clear input, status names the provider and API-key method without showing the key, and Chrome does not request provider endpoint access during static credential entry. The active and pending model selections remain unchanged.
   - Repeat setup, cancel at the secret prompt, and verify the existing key remains usable. Complete setup with a replacement test key and verify only that provider's credential changes.
   - Select the configured provider, model, and a different thinking level in Settings, save, reopen Settings to confirm the level persists, and send a harmless prompt. Expected: Chrome requests only the current page and selected provider endpoint origins; the response streams over SSE and the session records the selected provider/model.
   - Close and reopen the Side Panel, switch sessions, and create a new session. Expected: each existing session restores its own model and a new session uses the latest selection.
   - Remove the credential and retry. Expected: the request is blocked until that provider is configured again.
3. **Device login**
   - Select **Add credential** → **Sign in with an account**. Expected: only browser-safe account providers appear; the current build lists **OpenAI Codex**, not **OpenAI** or Node-only OAuth methods.
   - Select **OpenAI Codex** and verify Chrome asks only for `auth.openai.com` and `chatgpt.com`. Deny once; expected: setup fails closed, any prior Codex credential remains unchanged, and no device request starts.
   - Retry, approve access, open the displayed verification URL, enter the code, and finish login.
   - Expected: the panel reports **OpenAI Codex configured with an account** without showing an access or refresh token.
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
   - Expected: the active run aborts, the panel changes to **OpenAI Codex not configured**, and the next request is blocked until login. No fallback host is contacted.
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
   - Select **Choose a tab** and choose a web page; expected: the newly active tab becomes the target, with site access requested only when a page-context prompt is sent. On that page, select **Continue without page context**, send a prompt, and switch tabs during the run. Expected: no page tools become usable. Check active-run queued instructions behave the same; switch back with **Use current page** for a later turn.
   - On a protected page, select **Open a website**, enter a test URL or search query, and cancel confirmation. Expected: no tab opens. Confirm once; expected: exactly one new HTTP(S) tab opens and the protected tab remains unchanged. Confirm the query and destination before any third-party search request. Check site-access denial, cross-origin navigation, form submission, and download confirmations still fail closed.
   - Open a local text file and local/network PDF (including a PDF served from an extensionless HTTP(S) URL) with Chrome's file access disabled, then toggle **Allow access to file URLs** in `chrome://extensions` and retry. Expected: chat remains possible but page read, capture, picker, and operation remain unavailable in both states; no file path or PDF content is sent to the provider. Review narrow (320–360 px), dark theme, keyboard focus, status labels, and reduced motion. Record stable-Chrome results separately; an automated headless test is not proof of browser-owned Side Panel rendering.

Record date, stable Chrome version, account tier, each pass/fail result, and any network-header difference in the pull request before release review. This repository does not publish or release from this procedure.

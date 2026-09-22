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
   - Select the configured provider and model in Settings, save, and send a harmless prompt. Expected: Chrome requests only the current page and selected provider endpoint origins; the response streams over SSE and the session records the selected provider/model.
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

Record date, stable Chrome version, account tier, each pass/fail result, and any network-header difference in the pull request before release review. This repository does not publish or release from this procedure.

# Manual acceptance

Use a production build from `npm run build`. Do not test login with development output or record tokens, authorization codes, screenshots, or account IDs.

## Recorded environment

- Extension: `pi-chrome` 0.1.0
- `@earendil-works/pi-agent-core`: 0.85.1
- `@earendil-works/pi-ai`: 0.85.1
- Automated browser round trips: Google Chrome for Testing 153.0.8010.12
- Manual browser: Google Chrome 152.0.7977.83
- Real-account device login: passed on 2026-09-16; account tier was not recorded
- Authenticated SSE and browser-tool round trip: pending; the first request exposed a retired `gpt-5.4` default, which was replaced with `gpt-5.6-terra` before retry
- Optional bookmark permission and read-only bookmark round trip: pending for this change
- Non-Codex provider/model selection and authenticated request: pending for this change

## Procedure

1. **Clean setup and Side Panel header**
   - Remove prior extension data, run `npm run build`, and load `dist/chrome` unpacked.
   - Confirm the action opens the Side Panel and no native or local process is running.
   - Expected: Chrome's native header shows one blue-purple Pi icon and one **Pi Chrome** title; the extension content does not repeat that branding.
   - Resize the Side Panel through normal and 320–360 px widths. Expected: the current URL, run status, and account menu remain usable with no horizontal page scrolling; long URLs truncate, and the account menu opens without clipping.
   - Open the top-right three-dot menu, choose **Settings**, select a different font, and save. Expected: a dedicated settings page opens, the conversation returns after saving, the full interface uses the selected font, and the choice remains after closing and reopening the Side Panel.
   - Inspect the provider and model selectors. Expected: Amazon Bedrock is absent, Radius explains that configuration is needed before models load, and model capabilities identify reasoning and image input.
2. **API-key provider and model**
   - Select a non-Codex provider and model, choose **Configure selected provider**, and enter a dedicated test API key.
   - Expected: secret prompts mask input, no key appears in status text or logs, and Chrome does not request provider host access during static credential entry.
   - Save the settings and send a harmless prompt. Expected: Chrome requests only the current page and selected provider endpoint origins; the response streams over SSE and the session records the selected provider/model.
   - Close and reopen the Side Panel, switch sessions, and create a new session. Expected: each existing session restores its own model and a new session uses the latest selection.
   - Remove the credential and retry. Expected: the request is blocked until that provider is configured again.
3. **Device login**
   - Select **Log in to OpenAI Codex** and verify Chrome asks only for `auth.openai.com` and `chatgpt.com`.
   - Open the displayed verification URL, enter the code, and finish login.
   - Expected: the panel reports **OpenAI Codex configured** without showing an access or refresh token.
4. **Text SSE response**
   - Make a harmless HTTP(S) page visible and ask for a one-sentence summary without using a bind command.
   - Expected: the Side Panel shows the page automatically, text appears incrementally, and DevTools shows an HTTPS request to `chatgpt.com/backend-api`, with no browser WebSocket or loopback request.
5. **Clipboard image round trip**
   - Copy a PNG, JPEG, WebP, or GIF image and paste it into the composer.
   - Expected: a removable preview appears; sending with optional text shows the image in the transcript and lets the model inspect it.
   - Reopen the session and confirm the image still renders. Try an image larger than 3 MB and confirm it is rejected without being attached.
6. **Voice input**
   - Select the microphone in the composer, allow microphone access if Chrome asks, and dictate a short phrase.
   - Expected: the button shows a listening state, interim text appears in the composer, and selecting the microphone again leaves an editable transcript without sending it.
   - Deny microphone access in a clean profile. Expected: the panel reports a clear permission error and text entry remains usable.
7. **Browser tool round trip**
   - Ask the agent to read a unique heading, capture the visible page, type into a non-sensitive test field, and click an ordinary button.
   - Switch to another HTTP(S) tab and confirm the Side Panel follows it; switch to an internal Chrome page and confirm no page remains targeted.
   - Expected: the read output is marked untrusted and each operation affects only the currently visible HTTP(S) tab.
   - Ask it to submit a form or call a WebMCP tool.
   - Expected: the operation waits for explicit confirmation.
8. **Read-only bookmark access**
   - Add two distinctive test bookmarks and note their exact titles, URLs, and folders. Ask Pi to search for one distinctive title.
   - Expected: Pi Chrome first shows an operation confirmation stating that returned titles and URLs go to OpenAI and the session. Cancel it and verify no result appears.
   - Ask again, confirm the operation, and decline Chrome's native optional bookmark prompt. Expected: the confirmation stays open, an access error appears inside the dialog, and no bookmark result is sent.
   - Ask again, confirm the operation, and grant Chrome's optional bookmark prompt. Expected: only matching bounded results appear, labeled as untrusted bookmark data. Ask for recent bookmarks and approve its separate confirmation.
   - Revoke bookmark access in Chrome's extension settings and approve another read. Expected: the read fails without retrying, requesting background access, or changing any bookmark.
   - Recheck both test bookmarks in Chrome's bookmark manager. Expected: titles, URLs, folders, and ordering are unchanged. Delete the test bookmarks manually after recording results.
9. **Refresh**
   - Use **Refresh credential** if exposed in the tested build, or repeat a request after the token reaches refresh eligibility in a controlled test profile.
   - Expected: one refresh request succeeds, the session continues, and no credential appears in logs or storage outside trusted local storage.
10. **Permission revocation**
   - Revoke either OpenAI origin in Chrome extension settings, then send a prompt.
   - Expected: the active run aborts, the panel changes to **Not logged in**, and the next request is blocked until login. No fallback host is contacted.
11. **Interruption and restart**
   - Start a response, close the Side Panel, reopen it, then restart Chrome.
   - Expected: the last complete transcript returns, the session is marked interrupted when applicable, and no click, type, navigation, or WebMCP call repeats automatically.
12. **Logout and deletion**
   - Select **Remove credential**, then attempt a request.
   - Expected: the request is blocked until login.
   - Delete one session and use **Clear all session data**; verify associated image content is no longer listed.
13. **Artifact inspection**
   - Run `npm run audit:artifact` and inspect `chrome://extensions` permissions.
   - Expected: the audit passes; `bookmarks` is optional rather than required, and there is no bookmark mutation call, loopback URL, remote code, source map, native host, or unexpected host permission.

Record date, stable Chrome version, account tier, each pass/fail result, and any network-header difference in the pull request before release review. This repository does not publish or release from this procedure.

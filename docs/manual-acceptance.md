# Manual acceptance

Use a production build from `npm run build`. Do not test login with development output or record tokens, authorization codes, screenshots, or account IDs.

## Recorded environment

- Extension: `pi-chrome` 0.1.0
- `@earendil-works/pi-agent-core`: 0.85.1
- `@earendil-works/pi-ai`: 0.85.1
- Automated browser round trips: Google Chrome for Testing 153.0.8010.12
- Real-account device login: not run in repository automation; requires the reviewing user's ChatGPT Plus/Pro account

## Procedure

1. **Clean setup**
   - Remove prior extension data, run `npm run build`, and load `dist/chrome` unpacked.
   - Confirm the action opens the Side Panel and no native or local process is running.
2. **Device login**
   - Select **Log in** and verify Chrome asks only for `auth.openai.com` and `chatgpt.com`.
   - Open the displayed verification URL, enter the code, and finish login.
   - Expected: the panel reports logged in without showing an access or refresh token.
3. **Text SSE response**
   - Bind a harmless page and ask for a one-sentence summary.
   - Expected: text appears incrementally and DevTools shows an HTTPS request to `chatgpt.com/backend-api`, with no browser WebSocket or loopback request.
4. **Browser tool round trip**
   - Ask the agent to read a unique heading, type into a non-sensitive test field, and click an ordinary button.
   - Expected: the read output is marked untrusted and each operation affects only the bound tab.
   - Ask it to submit a form or call a WebMCP tool.
   - Expected: the operation waits for explicit confirmation.
5. **Refresh**
   - Use **Refresh credential** if exposed in the tested build, or repeat a request after the token reaches refresh eligibility in a controlled test profile.
   - Expected: one refresh request succeeds, the session continues, and no credential appears in logs or storage outside trusted local storage.
6. **Permission revocation**
   - Revoke either OpenAI origin in Chrome extension settings, then send a prompt.
   - Expected: the active run aborts or the new request fails with a permission-revoked message. No fallback host is contacted.
7. **Interruption and restart**
   - Start a response, close the Side Panel, reopen it, then restart Chrome.
   - Expected: the last complete transcript returns, the session is marked interrupted when applicable, and no click, type, navigation, or WebMCP call repeats automatically.
8. **Logout and deletion**
   - Select **Log out**, then attempt a request.
   - Expected: the request is blocked until login.
   - Delete one session and use **Clear all session data**; verify associated image content is no longer listed.
9. **Artifact inspection**
   - Run `npm run audit:artifact` and inspect `chrome://extensions` permissions.
   - Expected: the audit passes; there is no loopback URL, remote code, source map, native host, or unexpected host permission.

Record date, stable Chrome version, account tier, each pass/fail result, and any network-header difference in the pull request before release review. This repository does not publish or release from this procedure.

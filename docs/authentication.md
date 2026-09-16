# Authentication

Pi Chrome supports only OpenAI Codex access backed by ChatGPT Plus or Pro.

## Device-code flow

1. A **Log in** click requests optional access to `https://auth.openai.com/*` and `https://chatgpt.com/*`.
2. The Side Panel requests a device authorization from OpenAI.
3. It displays the verification URI and user code.
4. Polling follows the server interval, adds five seconds after `slow_down`, and stops on completion, denial, expiry, cancellation, or an unexpected response.
5. The returned authorization code and verifier are exchanged at the token endpoint.
6. The access-token JWT must contain a non-empty `chatgpt_account_id` claim.
7. The full credential is stored in trusted `chrome.storage.local`.

The browser module also contains a Web Crypto PKCE implementation for browser-safe authorization primitives. The device endpoint currently supplies the verifier used by the exchange.

## Refresh

`pi-ai` asks the injected credential store for request auth. If the access token is near expiry, refresh occurs inside `CredentialStore.modify()`. Concurrent requests for the provider serialize, and later callers reuse the newly refreshed credential. A rotated refresh token and access token are committed together.

A refresh error preserves the previous credential for an explicit retry or new login. It does not trigger another provider or destination.

## Logout and revocation

Logout aborts active model work, waits for the agent to stop, and deletes the stored provider credential. Revoking either OpenAI origin in Chrome immediately aborts the active run; subsequent requests fail with a clear instruction to log in again.

To remove all local data, log out and use **Clear all session data**. Site permissions can be removed separately from Chrome's extension settings.

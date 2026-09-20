# Authentication

Pi Chrome supports API-key authentication for browser-compatible built-in `pi-ai` providers and browser device-code OAuth for OpenAI Codex.

## Provider setup

Select **Add credential** from the top-right menu or **Configure authentication** in Settings. Both entry points use the same method-first flow:

1. Choose **Sign in with an account** or **Sign in with an API key**.
2. Choose a provider from the searchable list filtered to that browser-supported method.
3. Complete the provider-owned prompts or account flow.

Adding a credential does not change the active or pending model selection. Credentials are keyed by provider, so a successful setup replaces that provider's prior API-key or OAuth credential. Cancelling setup, denying an authentication permission, or failing a provider prompt preserves the prior credential.

- For an API-key provider, the provider-owned `pi-ai` prompts write one provider-scoped `api_key` credential to trusted `chrome.storage.local`.
- OpenAI API keys use the **OpenAI** provider. **OpenAI Codex** is a separate provider for ChatGPT Plus/Pro account login and does not accept an API key.
- Cloudflare prompts also collect the account and gateway identifiers required by its endpoint.
- Azure OpenAI prompts for its base URL, optional API version, and optional model-to-deployment map.
- Radius requests access to `radius.pi.dev`, stores its key, and refreshes its dynamic model catalog.
- Google Vertex AI exposes its API-key path. Filesystem-based ADC and service-account-file flows are unavailable in a browser.

OpenAI Codex is currently the only provider under **Sign in with an account**. Pi Chrome does not expose other provider OAuth implementations because those `pi-ai` flows intentionally load Node-only callback-server or PKCE modules. Amazon Bedrock is also unavailable because its adapter intentionally loads a Node-only AWS SDK module.

## OpenAI Codex device flow

1. After **Sign in with an account** and **OpenAI Codex** are selected, Pi Chrome requests optional access to `https://auth.openai.com/*` and `https://chatgpt.com/*`.
2. The Side Panel requests a device authorization from OpenAI.
3. It displays the verification URI and user code.
4. Polling follows the server interval, adds five seconds after `slow_down`, and stops on completion, denial, expiry, cancellation, or an unexpected response.
5. The returned authorization code and verifier are exchanged at the token endpoint.
6. The access-token JWT must contain a non-empty `chatgpt_account_id` claim.
7. The full credential is stored in trusted `chrome.storage.local`.

## Request authorization and refresh

`pi-ai` resolves the selected provider's credential through `ChromeCredentialStore`. Browser environment and filesystem lookups always return unavailable, so requests cannot silently pick up machine credentials. Static API-key entry requests no model endpoint access; before sending, Pi Chrome requests optional access to the exact selected model endpoint. Authentication status names the provider and method without exposing credential values. Pi Chrome never inserts API keys into host-permission patterns, UI status, runtime messages, model messages, or diagnostics.

If an OAuth access token is near expiry, refresh occurs inside `CredentialStore.modify()`. Credential-map mutations serialize across providers and Side Panel contexts through a Web Lock; later callers reuse a newly refreshed credential, and rotated refresh and access tokens are committed together. A refresh error preserves the previous credential for an explicit retry or new login; it does not trigger another provider or destination.

## Credential removal and revocation

**Remove credential** aborts active model work, waits for the agent to stop, and deletes the selected provider credential. Revoking either OpenAI origin immediately aborts active work and removes the Codex credential. Revoking another provider endpoint leaves its credential stored but blocks requests until access is granted again.

To remove all local data, remove provider credentials individually and use **Clear all session data**. Page and provider host permissions can be removed separately from Chrome's extension settings.

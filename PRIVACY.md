# Privacy Policy for Pi Browser Agent

**Effective date:** September 22, 2026

Pi Browser Agent is a Chrome extension that provides an AI assistant for the page the user is viewing. This policy explains what information Pi Browser Agent handles, why it is handled, where it is stored, and when it is shared.

## Summary

- Pi Browser Agent has no developer-operated backend and includes no advertising or analytics service.
- Data remains in the user's Chrome profile unless the user sends a prompt or explicitly approves an operation that requires sharing data with a selected AI provider or another service described below.
- Pi Browser Agent does not sell user data or use it for advertising, profiling, creditworthiness, or lending.
- The developer does not receive extension data unless the user intentionally includes it in a support request or another direct communication.

## Information Pi Browser Agent handles

### Authentication information

Pi Browser Agent stores credentials supplied for user-selected AI providers. Depending on the provider, this can include an API key or OAuth access and refresh tokens. OpenAI Codex account login also stores the ChatGPT account identifier contained in the credential. Credentials are stored in `chrome.storage.local`, restricted to trusted extension contexts, and are not included in conversation transcripts or exposed to websites.

### Prompts and conversations

Pi Browser Agent handles prompts, editable voice transcripts, attached images, model responses, reasoning when supplied by the model, tool calls, tool results, and related error messages. Conversation messages are stored locally so users can resume sessions, subject to the retention and per-session size limits described below.

### Current-page information

When required by a user request, Pi Browser Agent may handle the active tab's URL and approved page context, including visible text, selected text, descriptions of visible interactive elements, screenshot content, and results returned by page or WebMCP tools. It targets only the active, visible HTTP or HTTPS tab in the focused Chrome window.

Pi Browser Agent does not continuously collect page content or maintain a background browsing-history service. Page access occurs to provide the user-facing assistant features and is subject to Chrome permissions and Pi Browser Agent's runtime checks.

### Bookmark information

If the user explicitly confirms a bookmark operation and grants the optional permission, Pi Browser Agent may search bookmark titles and URLs or read a bounded list of recent bookmarks. Every bookmark read requires confirmation. Pi Browser Agent does not create, modify, move, or delete bookmarks.

### Settings and permission records

Pi Browser Agent stores the selected provider and model, interface preferences, user-edited instructions, the active session identifier, and exact origins approved through user actions. A context-menu selection that has not yet reached the Side Panel can be held temporarily in `chrome.storage.session`.

### Voice input

Voice input uses Chrome's Web Speech service. Spoken audio may be processed by Chrome's configured speech provider. Pi Browser Agent receives an editable transcript and sends it to the selected AI provider only when the user chooses **Send**. Pi Browser Agent does not store the spoken audio.

## How information is used

Pi Browser Agent uses information only to:

- authenticate requests to a provider selected by the user;
- generate and display AI responses;
- provide user-requested page, screenshot, bookmark, voice, and browser-tool features;
- preserve user settings and conversation sessions;
- enforce permission, confirmation, size, retention, and stale-context safeguards; and
- diagnose errors shown to the user without intentionally exposing credentials.

## When information is shared

Pi Browser Agent can share information in these circumstances:

- **Selected AI provider:** When the user sends a prompt or approves a tool operation, Pi Browser Agent sends the provider the information needed for the conversation. Depending on the request, this may include prompts, prior conversation content, the current page URL, visible or selected page content, element descriptions, attached images, approved screenshots, approved bookmark titles and URLs, and tool results. Provider credentials are sent only to the associated provider endpoint for authentication.
- **OpenAI authentication:** If the user chooses OpenAI Codex account login, Pi Browser Agent communicates with OpenAI's authentication and ChatGPT services to complete and refresh the device authorization flow.
- **Chrome speech provider:** If the user enables voice input, Chrome's speech service may process spoken audio and return transcript text.
- **Current website:** At the user's request, page actions may interact with the active website. Typing actions provide text to an editable field and trigger page input and change events that the website can observe. Page-defined WebMCP calls require separate confirmation and may send arguments to, or receive results from, the website.

These services process information under their own terms and privacy policies. Users should review the policy of their selected provider before submitting content. Pi Browser Agent does not control an external provider's retention practices.

Pi Browser Agent does not sell user data, transfer it to data brokers or advertising platforms, or use it for personalized advertising, creditworthiness, or lending.

## Local storage and retention

- Provider credentials, settings, the active session identifier, and approved origins remain in `chrome.storage.local` until the user removes or changes them, clears extension data, or uninstalls Pi Browser Agent.
- An undelivered context-menu selection remains in `chrome.storage.session` until it is consumed or the browser session ends.
- Conversation records are stored in the extension's IndexedDB database. Pi Browser Agent retains at most 50 sessions and limits each serialized session record to 5 MB. If a session exceeds that limit, Pi Browser Agent first replaces embedded images with omission placeholders and then, if necessary, removes the oldest messages until the record fits. The Side Panel reports this loss to the user.
- Partial streaming output, unsent image previews, and live operation state are kept only in memory for the Side Panel's lifetime.

Users can delete individual sessions, select **Clear all session data**, remove provider credentials, revoke Chrome permissions, or uninstall the extension. Removing local data does not delete information already processed by an external provider; requests concerning provider-held data must be directed to that provider.

## Security

Pi Browser Agent restricts local credential storage to trusted extension contexts. Credentials are not sent to page scripts, content injections, the extension service worker, conversation transcripts, or diagnostic exports. Executable JavaScript and dependencies are packaged with the extension; Pi Browser Agent does not load or execute remote JavaScript or WebAssembly.

Provider requests use the endpoint supplied by the packaged provider catalog or configured by the user. Users should configure only HTTPS custom provider endpoints and should protect access to their Chrome profile and device.

No method of storage or transmission is completely secure, and Pi Browser Agent cannot guarantee the security practices of external providers or websites.

## Chrome Web Store Limited Use disclosure

The use of information received from Google APIs will adhere to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Changes to this policy

This policy may be updated when Pi Browser Agent's data practices or legal obligations change. Material changes will be published at this URL with a revised effective date.

## Contact

Questions or privacy requests can be submitted through the public issue tracker:

https://github.com/narumiruna/pi-browser-agent/issues

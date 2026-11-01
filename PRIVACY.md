# Privacy Policy for Pi Browser Agent

**Effective date:** November 1, 2026

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

Pi Browser Agent handles prompts, editable voice transcripts, attached images, model responses, reasoning when supplied by the model, tool calls, tool results, and related error messages. A user can annotate a completed screenshot locally; the editable strokes and unsent rendered preview remain in memory, and the new image is shared only after **Send**. The original screenshot is not modified. Conversation messages are stored locally so users can resume sessions, subject to the retention and per-session size limits described below.

A user can also draw freehand marks over a live, approved HTTP(S) page while the conversation is idle. Pen choices and raw strokes remain in memory and are not sent to the model or saved in a session. Drawing alone makes no screenshot or provider request. Explicit **Send** uses existing screenshot consent to capture one ordinary PNG of the visible page, including the marks and a slight 1% shield tint. The image can contain sensitive visible content, including visible iframe pixels. This does not inspect iframe DOM or change page-owned content. Live page content can move beneath marks; marks do not automatically follow elements.

If capture fails, editable marks remain only when the original page context and protection are safe. After a later submission failure, the PNG preview and text remain for manual retry without another capture. Unconfirmed surface cleanup blocks sending until removal is confirmed. Cancellation or page/context/protection changes discard unsent strokes; raw strokes are not recoverable after the page or panel closes. A sent PNG goes to the selected provider and is retained like other conversation images. Removing the drawing surface does not delete a sent image or authorize a browser action. See [page drawing and verification status](docs/page-annotation.md).


### Region capture

A user can select a viewport rectangle on an approved HTTP(S) page and choose **Preview region**. Starting or changing the selection makes no screenshot or provider request. Preview uses the existing explicit screenshot consent. Chrome first captures the full visible viewport in trusted worker memory; the worker decodes and crops it before returning any image to the Side Panel. The original full-viewport PNG is not returned to the panel, attached, logged, saved in a session, or sent to the provider by this workflow. Failed cropping never falls back to the original image.

Only the cropped PNG is shown for local review. **Attach** adds it to the composer; only a later explicit **Send** shares it with the selected provider and saves it as an ordinary conversation image. **Retake** discards the preview and starts a new selection without automatic capture. **Cancel** discards unsent region work. The crop retains a slight 1% shield tint but excludes the selection outline and Side Panel controls. Cleanup must be confirmed before attachment or sending. Later submission failure retains the crop for manual retry without recapture.

Rectangle state, tokens, the temporary source, and unsent crops remain in memory. Source resources and preview object URLs are released when no longer needed; this is not a secure-memory-erasure claim. A completed preview can survive a later tab change after cleanup, but not session replacement or panel disposal. Sent crops follow ordinary session retention, and deleting local history does not delete provider-held data. Cropping limits only the attached image: prompts, selected-element data, prior history, and separately approved browser reads can include other content. See [region capture](docs/region-capture.md).


### Current-page information

When required by a user request, Pi Browser Agent may handle the active tab's URL and approved page context, including visible text, selected text, descriptions of visible interactive elements, screenshot content, and results returned by page or WebMCP tools. Chat can run without a readable tab. The Side Panel displays a bounded active-page title and capability label, but does not automatically send protected-page URLs, local file paths, or titles to the model. A turn begun without a readable page keeps page tools disabled even if another tab becomes active, unless the agent explicitly switches to or opens an approved web tab after confirmation. If the user activates the element picker, a selected context can include bounded visible text, accessibility metadata, allowlisted attributes, viewport geometry, and a best-effort selector. It excludes input values, hidden text, full HTML, URL credentials, iframe contents, and Shadow DOM. It targets only the active, visible HTTP or HTTPS tab in the focused Chrome window.

Pi Browser Agent does not continuously collect page content or maintain a background browsing-history service. Page tools do not read Chrome internal pages, Web Store pages, local files, or PDFs. General file/PDF import is not supported. The separate Skills feature reads a selected local `SKILL.md` or a selected public GitHub `SKILL.md` after an explicit repository fetch and host approval; it grants no general filesystem access. When the agent requests web tabs, it receives up to 20 current-window HTTP(S) tab titles and origins without reading those pages. Switching to one or opening an HTTP(S) tab requires user confirmation or a matching, previously approved action and site access; protected and local tabs are excluded. If the user enters a search query, the query is included in the confirmed destination URL and shared with the search provider when the tab opens. Page access occurs to provide the user-facing assistant features and is subject to Chrome permissions and Pi Browser Agent's runtime checks. Unsent selected-element chips remain only in memory and are cleared on relevant tab or session changes. They are shared only after the user selects **Send**.

Rendered-text searches can return bounded snippets, temporary UTF-16 source offsets, and viewport geometry, including for offscreen page text. Searches exclude editable values and hidden/clipped content, do not scroll, and do not create action references. They conservatively omit masked text, rounded overflow clips, and rotated/skewed/flipped/3D transforms instead of interpreting arbitrary visual effects. Condition waits make bounded read-only observations in the original document (5 seconds by default, at most 10 seconds, polling every 250 ms); they do not continuously monitor later navigation. Text search and waits do not renew element references.

Native select-option reads are a narrow label-only exception to the form-content exclusion. For a discovered visible single select, the agent can read up to 50 option labels, indices, disabled flags, and label-truncation flags; catalogs above 2,000 options are rejected. Hidden options and options in hidden groups remain excluded. It does not return raw option values, selected flags, selected value, or selected index. Returned labels, text snippets, and other page-tool results can be sent to the selected AI provider and stored in the conversation. No separate background catalog or search history is kept.

### Target/reference pairs and clarification answers

Users can label two submitted attachments as a target and a reference. These labels, attachment IDs, submitted image positions, pin notes, and bounded selected-page context go to the selected model provider as ordinary user-message data. References use already attached images or current-page targets; pair controls do not fetch arbitrary reference URLs or read background tabs.

The agent can ask one local clarification question through the selected provider’s normal tool-call stream. Selecting an option or typing text does not submit it until the user selects **Answer**. That answer returns to the same run and can be stored with the question in the conversation. It does not approve browser or remote actions. There is no additional question service, provider, or credential.

Unsent pair roles and pending choices remain in memory. Stop, panel close, credential removal, or cancellation removes the callback; a page-context change invalidates element-linked answers. Stored questions and answers remain inactive history after restore or tree navigation. They follow the same session retention and deletion rules as other messages. Deleting local history does not delete provider-held data. See [target/reference pairs and questions](docs/target-reference.md).

### Bookmark information

If the user explicitly confirms a bookmark operation and grants the optional permission, Pi Browser Agent may search bookmark titles and URLs or read a bounded list of recent bookmarks. Every bookmark read requires confirmation or a matching approval for the same operation, query, and limit under the selected confirmation mode. Pi Browser Agent does not create, modify, move, or delete bookmarks.

### Remote MCP servers

If configured by the user, remote MCP servers receive connection requests, client/protocol metadata, and confirmed tool names and arguments. A successful **Connect and preview** enables discovery for later submitted runs. Tool metadata and returned text or structured JSON can be sent to the selected model provider and stored in conversation history. Each call requires fresh confirmation in all modes. Remote MCP does not require a readable page.

Server names, exact endpoint approvals, enablement, and configuration revisions are stored locally. Optional MCP bearer tokens use a separate trusted local store, bound to the server and endpoint. They are sent only as authentication to that endpoint, not to the selected model, websites, the service worker, transcripts, or diagnostics. MCP requests omit cookies and reject redirects. Removing a server deletes its token and endpoint connection approval; deleting sessions does not remove server settings or tokens. Remote services apply their own retention policies. Cancelling a request cannot undo a remote side effect.

### Imported skills

Users can select a local UTF-8 `SKILL.md` or explicitly fetch a public GitHub repository and select one candidate file. GitHub import requires access to `https://api.github.com/*`. Repository fetch sends the owner and repository identifiers to GitHub; reviewing the selected candidate sends the selected blob identifier. Requests omit cookies and credentials, reject redirects, and use only the GitHub API. No provider credential or GitHub token is used. Source links open only on user action.

Users review the complete original source, parsed fields, optional license and metadata, and warnings as plain text before explicit import into trusted local extension storage. GitHub review also shows repository, path, commit, and a source link. Only name, description, and body are saved with the local ID and enabled state. Source identity and optional fields are review-only memory, not stored provenance. There are no automatic updates or background GitHub reads; runtime skill loading makes no network request.

Imported skills and explicit replacements start disabled. Selection, review, import, replacement, and enablement do not send a model request. On a later explicit chat submission, enabled skill IDs, names, and descriptions can reach the selected model provider. The model can request an enabled skill's body through `skills_load`; that body then enters the conversation and saved history. A later request can resend this history.

Skill text is untrusted task guidance and can affect model behavior, but cannot grant browser permissions or bypass confirmations. Do not import secrets or content that is unsafe to share. Settings changes apply to the next run; an active run retains its initial snapshot. Disabling or deleting a skill blocks loads in future runs, but does not erase previously loaded content from sessions or provider records. Delete affected sessions separately. Deleting sessions does not delete installed skills. Only the selected skill's text is imported. Scripts, supporting files, plugin installation, and local directory discovery are not supported. See [browser skills](docs/skills.md).

### Settings and permission records

Pi Browser Agent stores the selected provider and model, interface preferences, confirmation mode, user-edited instructions, the active session identifier, and exact origins approved through user actions. **Strict** prompts for every browser action currently requiring confirmation. **Balanced** (new-install default) remembers the same action and target until a browser restart; **Convenient** remembers it across restarts until cleared. Existing installations with no saved mode retain Strict. Form submissions, downloads, native option selections, actual checkbox/radio state changes, and clicks without a stable target always prompt. Checkbox/radio no-ops send no events and need no confirmation. Actual checked-state changes require fresh confirmation in all modes; page handlers can submit or navigate, and an interrupted or unverified activation is never automatically replayed. Matching WebMCP calls reuse only the same page, tool name, and arguments; bookmark reads reuse only the same query and limit. Repeating even an identical WebMCP call can have side effects. Switching modes clears remembered approvals; Settings also has **Clear remembered approvals**. The ledger contains bounded SHA-256 fingerprints, not raw arguments, bookmark queries, or full page URLs; it holds at most 256 matches per mode. A context-menu selection that has not yet reached the Side Panel can be held temporarily in `chrome.storage.session`.

### Voice input

Voice input uses Chrome's Web Speech service. Spoken audio may be processed by Chrome's configured speech provider. Pi Browser Agent receives an editable transcript and sends it to the selected AI provider only when the user chooses **Send**. Pi Browser Agent does not store the spoken audio.

## How information is used

Pi Browser Agent uses information only to:
- authenticate requests to a provider selected by the user;
- generate and display AI responses;
- provide user-requested page, screenshot, bookmark, voice, skill, and browser-tool features;
- preserve user settings and conversation sessions;
- enforce permission, confirmation, size, retention, and stale-context safeguards; and
- diagnose errors shown to the user without intentionally exposing credentials.

## When information is shared

Pi Browser Agent can share information in these circumstances:
- **Selected AI provider:** When the user sends a prompt or approves a tool operation, Pi Browser Agent sends the provider the information needed for the conversation. Depending on the request, this may include prompts, prior conversation content, the current page URL, visible or selected page content, element descriptions, attached images, approved screenshots, approved bookmark titles and URLs, enabled skill metadata, loaded skill bodies, and tool results. Provider credentials are sent only to the associated provider endpoint for authentication.
- **OpenAI authentication:** If the user chooses OpenAI Codex account login, Pi Browser Agent communicates with OpenAI's authentication and ChatGPT services to complete and refresh the device authorization flow.
- **GitHub:** An explicit repository fetch and selected-file review send repository and selected blob identifiers to `api.github.com` to list and read public skill text. Requests use no cookies, provider credentials, or GitHub authentication. Opening a reviewed source link separately contacts GitHub through the browser.
- **Configured remote MCP server:** Explicit setup or a later submitted run discovers enabled server tools. A confirmed call sends the displayed tool name and arguments to the approved endpoint. Tool metadata and results can also reach the selected AI provider and local transcript. MCP tokens authenticate only to their configured endpoint.
- **Chrome speech provider:** If the user enables voice input, Chrome's speech service may process spoken audio and return transcript text.
- **Current website:** At the user's request, page actions may interact with the active website. Typing actions provide text to an editable field and trigger page input and change events that the website can observe. Native option selection and checkbox/radio activation can also trigger page handlers, submit forms, or navigate after fresh confirmation. Page-defined WebMCP calls require separate confirmation or a matching prior approval and may send arguments to, or receive results from, the website.

These services process information under their own terms and privacy policies. Users should review the policy of their selected provider before submitting content. Pi Browser Agent does not control an external provider's retention practices.

Pi Browser Agent does not sell user data, transfer it to data brokers or advertising platforms, or use it for personalized advertising, creditworthiness, or lending.

## Local storage and retention

- Provider credentials, MCP server configurations and tokens, installed skill records (including disabled bodies), settings, the active session identifier, approved origins, and Convenient approval fingerprints remain in `chrome.storage.local` until removed, cleared, or extension data is deleted.
- An undelivered context-menu selection and Balanced approval fingerprints remain in `chrome.storage.session` until consumed, cleared, or the browser session ends.
- Conversation records are stored in the extension's IndexedDB database. Pi Browser Agent retains at most 50 sessions and limits each serialized session record to 5 MB. If a session exceeds that limit, Pi Browser Agent first replaces embedded images with omission placeholders and then, if necessary, removes the oldest messages until the record fits. The Side Panel reports this loss to the user.
- Partial streaming output, unsent pasted or annotated image previews, editable screenshot/page-drawing strokes and pen choices, unsent selected-element chips, live picker/page-drawing/region/operation state, region rectangles and temporary worker-local source PNGs, and skill source/candidate/review data are kept only in memory for the relevant Side Panel, Settings page, page, or worker lifetime.
- Sent selected-element JSON is stored as untrusted user-message text. Sent annotated images are embedded like other user images; an original screenshot and its annotated copy can both consume session storage. Live-page drawing adds one image, without a separate unmarked screenshot or persisted raw strokes. Deleting the containing session removes its local embedded image; session restore does not recreate a drawing surface or resend it.

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

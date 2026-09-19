# Pi Chrome

Pi Chrome is a Chrome-native Codex assistant. The Side Panel runs `pi-agent-core` and `pi-ai`, signs in with a ChatGPT Plus/Pro device code, and exposes bounded tools for the active HTTP(S) tab in the focused Chrome window. With separate approval, it can also search or inspect recent Chrome bookmarks.

No local agent process, native host, shell, filesystem access, pairing secret, or loopback connection is required.

## Requirements

- Node.js 22.19 or a newer supported even-numbered release
- Chrome 116 or newer
- A ChatGPT Plus or Pro account with Codex access

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

1. In the Side Panel, select **Log in** and approve access to `auth.openai.com` and `chatgpt.com`.
2. Open the verification page, enter the displayed device code, and complete OpenAI login.
3. Open the HTTP or HTTPS page you want to use. Pi Chrome follows the visible tab automatically.
4. Enter a prompt. Pi Chrome requests access to that site when needed.
5. To include an image, paste it into the composer, review the preview, and send it with optional text.
6. To dictate a prompt, select the microphone, speak, then select it again before reviewing and sending the transcript.
7. When Pi requests a bookmark read, review the requested search or recent-item limit and confirm it. Chrome asks for the optional bookmark permission the first time.

Voice input uses Chrome's Web Speech service in the browser language. Spoken audio may be processed by the browser's speech provider; only the resulting editable transcript is submitted to Pi when you select **Send**. The model transport is always SSE. Closing the Side Panel aborts the active run and marks the session interrupted; reopening never automatically repeats a browser mutation.

## Browser safety

The agent can read visible text and selection, capture the visible viewport, click one visible CSS-selected element, type into ordinary editable controls, navigate, and use page WebMCP tools when available.

- Password and file inputs are denied.
- Form submissions, downloads, cross-origin links, cross-origin navigation, and all WebMCP calls require confirmation.
- A request created before navigation or a visible-tab change is rejected as stale.
- Visible text and selected text are capped at 50 KB; screenshots are capped at 3 MB.
- A message accepts up to four pasted PNG, JPEG, WebP, or GIF images using at most 3 MB in total.
- Page text, selections, screenshot metadata, bookmark data, and WebMCP results are labeled as untrusted model input.
- Bookmark access is optional and absent by default. Every search or recent-bookmark read requires confirmation, returns at most 50 items and 50 KB, and sends the returned titles and URLs to OpenAI as part of the conversation.
- Chrome's bookmark permission covers reads and writes, but Pi Chrome exposes only search and recent-read operations; the production artifact audit rejects bookmark mutation calls.
- Credentials stay in trusted extension storage and are never sent to the service worker, content injection, page context, transcript, or diagnostic export.

## Sessions and settings

The Side Panel supports creating, resuming, renaming, and deleting sessions. Complete transcript boundaries, including confirmed bookmark tool results, are stored in versioned IndexedDB records. Storage keeps at most 50 sessions and limits each record to 5 MB. **Clear all session data** removes transcripts and embedded images.

The Side Panel settings let you choose a system, sans-serif, serif, or monospace interface font. The selected font persists across Side Panel and Chrome restarts. The system prompt and AGENTS-style instructions are also editable and apply to the next run. The extension does not discover instructions from the local filesystem.

## Development

```sh
npm run dev:chrome
npm test
npm run test:e2e
npm run ci
npm audit --omit=dev
```

`npm run build` runs the isolated browser bundle probe, production extension build, typecheck, and artifact security audit. `npm run pack` creates the Chrome zip without publishing anything.

## Troubleshooting

- **OpenAI host access was revoked:** select **Log in** again and approve both requested OpenAI origins.
- **A page tool is denied:** make the intended HTTP(S) page visible and send the prompt again. If access was previously declined, use **Account and site access → Allow current site**. Chrome internal pages cannot be controlled.
- **A bookmark read is denied:** request it again and approve both Pi Chrome's operation confirmation and Chrome's optional permission prompt. Revoke bookmark access from Chrome's extension settings when it is no longer wanted.
- **Stale context:** the visible tab changed or navigated after the tool request began. Retry after the Side Panel shows the current URL.
- **Login pending:** finish the device flow before its 15-minute expiry. Cancel and restart if the code expires or is denied.
- **Refresh failed:** log out, then complete device login again. The extension does not fall back to another provider.
- **Voice input unavailable:** use a Chrome version that exposes the Web Speech API, and allow microphone access for Pi Chrome when prompted. Voice recognition may require network access.
- **Interrupted session:** review the transcript before continuing. Mutation tools are never replayed automatically.

## Documentation

- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Permissions and data storage](docs/permissions-and-storage.md)
- [Security model](docs/security.md)
- [Manual acceptance](docs/manual-acceptance.md)
- [WebMCP status](docs/webmcp.md)

# Pi Chrome

Pi Chrome is a Chrome-native Codex assistant. The Side Panel runs `pi-agent-core` and `pi-ai`, signs in with a ChatGPT Plus/Pro device code, and exposes bounded tools for one explicitly bound tab.

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
3. Open an HTTP or HTTPS page, then select **Bind active tab**.
4. Select **Allow site** if a browser action needs persistent access beyond the action's temporary `activeTab` grant.
5. Enter a prompt.

The model transport is always SSE. Closing the Side Panel aborts the active run and marks the session interrupted; reopening never automatically repeats a browser mutation.

## Browser safety

The agent can read visible text and selection, capture the visible viewport, click one visible CSS-selected element, type into ordinary editable controls, navigate, and use page WebMCP tools when available.

- Password and file inputs are denied.
- Form submissions, downloads, cross-origin links, cross-origin navigation, and all WebMCP calls require confirmation.
- A request created before tab navigation is rejected as stale.
- Visible text and selected text are capped at 50 KB; screenshots are capped at 3 MB.
- Page text, selections, screenshot metadata, and WebMCP results are labeled as untrusted model input.
- Credentials stay in trusted extension storage and are never sent to the service worker, content injection, page context, transcript, or diagnostic export.

## Sessions and settings

The Side Panel supports creating, resuming, renaming, and deleting sessions. Complete transcript boundaries are stored in versioned IndexedDB records. Storage keeps at most 50 sessions and limits each record to 5 MB. **Clear all session data** removes transcripts and embedded images.

The system prompt and AGENTS-style instructions are editable in the Side Panel and apply to the next run. The extension does not discover instructions from the local filesystem.

## Development

```sh
npm run dev:chrome
npm test
npm run test:e2e
npm run ci
npm audit --omit=dev
```

`npm run build` runs the isolated browser bundle probe, production extension build, typecheck, and artifact security audit. `npm run package:chrome` creates the Chrome zip without publishing anything.

## Troubleshooting

- **OpenAI host access was revoked:** select **Log in** again and approve both requested OpenAI origins.
- **A page tool is denied:** bind the intended HTTP(S) tab and select **Allow site**. Chrome internal pages cannot be controlled.
- **Stale context:** the bound tab navigated after the tool request began. Retry after the Side Panel shows the new URL.
- **Login pending:** finish the device flow before its 15-minute expiry. Cancel and restart if the code expires or is denied.
- **Refresh failed:** log out, then complete device login again. The extension does not fall back to another provider.
- **Interrupted session:** review the transcript before continuing. Mutation tools are never replayed automatically.

## Documentation

- [Architecture](docs/architecture.md)
- [Authentication](docs/authentication.md)
- [Permissions and data storage](docs/permissions-and-storage.md)
- [Security model](docs/security.md)
- [Manual acceptance](docs/manual-acceptance.md)
- [WebMCP status](docs/webmcp.md)

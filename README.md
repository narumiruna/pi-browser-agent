# Pi Chrome Bridge

Pi Chrome Bridge connects one explicitly authorized Chrome tab to an existing pi coding-agent session. It contains two installable parts:

- a Manifest V3 Chrome extension built with Extension.js;
- a pi extension that exposes bounded browser tools and hosts an authenticated loopback WebSocket server.

WebMCP is an optional page adapter. It is not used as the process transport.

## Requirements

- Node.js 22.12 or a newer even-numbered release supported by the toolchain
- Chrome 116 or newer
- pi coding agent 0.85.1 or newer

## Install and build

```sh
npm install
npm run build
```

The Chrome artifact is written to `dist/chrome`.

Load it locally:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select `dist/chrome`.

Run the pi extension directly during development:

```sh
pi -e ./src/pi/index.ts
```

Or install this checkout as a local pi package:

```sh
pi install .
```

## Pair Chrome with pi

1. Start pi with the extension loaded.
2. Run `/chrome-pair` in pi.
3. Open an HTTP or HTTPS tab that pi may access.
4. Open the **Pi Chrome Bridge** popup.
5. Paste the displayed pairing secret and verify the port, then select **Pair and bind this tab**.

The secret is shown by pi for transfer to Chrome. Pi stores it in `~/.pi/agent/pi-chrome.json` (or the configured pi agent directory) with mode `0600`; Chrome stores it in `chrome.storage.local`. Running `/chrome-pair` again rotates the secret and disconnects the previous client.

The normal flow uses the temporary `activeTab` grant created when the user opens the popup. Select **Always allow this site** to request an optional, origin-scoped host permission. The production manifest does not request `<all_urls>`. Before navigating the bound tab across origins, grant **Always allow this site** on the destination, then return to and rebind the source tab. Chrome revokes `activeTab` access on cross-origin navigation.

The tab binding survives an MV3 service-worker restart, but it is cleared when the browser session ends. Bind a tab again after restarting Chrome. Revoking from the popup normally waits for pi to persist the revocation and close the authenticated connection. If pi is disconnected, the popup clears local pairing data and warns you to run `/chrome-revoke` in pi before pairing again.

Commands:

- `/chrome-pair` — rotate and display a pairing secret.
- `/chrome-status` — show listener, pairing, connection, and bound-tab state.
- `/chrome-revoke` — revoke the secret and disconnect Chrome.

## Tools

| Tool | Capability |
| --- | --- |
| `browser_connection_state` | Inspect local bridge and bound-tab state |
| `browser_get_active_tab` | Read metadata for the bound tab |
| `browser_read_page` | Read visible text, truncated to 50 KB |
| `browser_get_selection` | Read selected page text |
| `browser_capture_visible` | Capture the visible active viewport as PNG |
| `browser_click` | Click one visible CSS-selected element |
| `browser_type` | Replace text in a non-sensitive editable element |
| `browser_navigate` | Navigate to an HTTP or HTTPS URL |
| `browser_webmcp` | List or call page WebMCP tools when available |

Form submissions, downloads, cross-origin navigation, and WebMCP calls require interactive confirmation. Cross-origin navigation additionally requires a previously granted destination host permission. Password and file inputs are always denied. There is no arbitrary JavaScript execution tool.

Use the popup or the selection context menu to send selected page text to pi. Browser content is wrapped and labelled as untrusted before it enters the conversation. If pi is busy, the message is queued as a follow-up.

## Development

```sh
npm run dev:chrome
npm test
npm run test:e2e
npm run ci
```

The Playwright suite builds a temporary test-only extension copy with `<all_urls>` so headless Chromium can exercise `captureVisibleTab` without a toolbar gesture. The production manifest remains `activeTab`-only.

Package artifacts without publishing:

```sh
npm run package:chrome  # dist/chrome/pi-chrome.zip
npm run package:pi      # dist/packages/pi-chrome-0.1.0.tgz
```

Do not load an Extension.js development output into a release package. Run `npm run package:chrome` to regenerate a production artifact.

## Configuration

Set `PI_CHROME_PORT` before starting pi to replace the default loopback port `17373`. The value must be between `1024` and `65535`. The server always binds only to `127.0.0.1`.

## Documentation

- [Architecture](docs/architecture.md)
- [Protocol](docs/protocol.md)
- [Security model](docs/security.md)
- [WebMCP status](docs/webmcp.md)

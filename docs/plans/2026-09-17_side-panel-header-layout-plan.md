# Side Panel Header Layout Plan

## Goal

Remove the duplicate in-page Pi Chrome branding while preserving the blue-purple Pi identity in Chrome's native Side Panel header, then move the current-page URL into a compact top row beside the run status and account menu.

## Context

- Chrome owns the Side Panel header containing the extension icon, extension name, pin control, and close control. Extension HTML and CSS cannot remove or rearrange that header.
- `manifest.json` declares the `Pi Chrome` name but no icons, so Chrome currently renders a placeholder `P` icon.
- `src/browser/sidepanel/index.html` renders a second brand mark and title inside `.brand-row`, while `.page-context` occupies a separate row below it.
- The URL is display-only. `src/browser/sidepanel/index.ts` updates `#tab-status`; this behavior does not need to change.

## Assumptions

- Pi Chrome remains a Chrome Side Panel rather than moving to a popup, separate window, or normal tab.
- “Keep the blue-purple logo” means applying that visual identity to the manifest icon shown by Chrome and removing the duplicate in-page brand.
- The Chrome-owned title remains `Pi Chrome`; the extension does not attempt unsupported DOM or CSS manipulation of browser UI.
- On narrow panels, preserving readable status and controls is more important than forcing every item to remain on one line.

## Non-Goals

- Hiding or restyling Chrome's pin, close, extension title, or Side Panel header.
- Making the current-page display editable or using it to navigate.
- Changing tab binding, authentication, session behavior, or agent runtime behavior.
- Replacing the Side Panel architecture solely to obtain a frameless custom header.

## Risks

- The smallest icon sizes may make the Pi glyph or gradient unclear; inspect the 16 px and 32 px assets in Chrome rather than relying only on source previews.
- Automated E2E tests load the panel page directly and cannot prove how Chrome renders its native header; final acceptance requires a manual unpacked-extension check.
- Long URLs and narrow Side Panels can crowd the status and account controls; the layout needs explicit shrinking, ellipsis, and a narrow-width fallback.

## Plan

- [x] Add blue-purple Pi icon assets at the Chrome-recommended manifest sizes and reference them from `manifest.json`; `npm run build` copied all declared icons and the artifact audit passed.
- [x] Update `src/browser/sidepanel/index.html` to remove the in-page `.brand` mark/title and place `.page-context`, `.status-pill`, and the account disclosure in one semantic header row; the before/after ID comparison showed no changed element IDs.
- [x] Update `src/browser/sidepanel/styles.css` to make the page context consume remaining row width, remove obsolete brand rules, eliminate the URL block's top margin, and preserve ellipsis for long URLs; Playwright verified same-row placement and truncation at 480 px.
- [x] Add a narrow-width fallback in `src/browser/sidepanel/styles.css` so a 320–360 px panel keeps the URL, status, and account menu usable without horizontal scrolling; Playwright verified both endpoint widths, light and dark schemes, menu bounds, and keyboard focus styling.
- [x] Extend `tests/e2e/sidepanel-roundtrip.spec.ts` with layout assertions for normal and narrow viewports, including no in-page brand, visible current-page text, same-row placement at normal width, URL truncation, and no horizontal overflow; `npm run test:e2e` passed all 9 tests.
- [x] Strengthen `scripts/audit-artifact.mjs` to reject missing manifest icon files so packaging cannot silently restore Chrome's placeholder icon; the production audit passed, and a negative check rejected a removed declared icon.
- [x] Run `npm run check`, `npm test`, `npm run build`, and `npm run test:e2e`; all commands passed.
- [ ] Load `dist/chrome` as an unpacked extension in stable Chrome and confirm the native Side Panel header shows one blue-purple Pi icon with one `Pi Chrome` title, the URL/status row matches the intended layout, menus open without clipping, and long URLs remain readable at narrow and normal widths. Not run: the agent environment has no stable Chrome executable or graphical browser session.

## Completion Checklist

- [ ] Chrome's native Side Panel header is the only location showing the Pi Chrome logo and title. Automated coverage confirms the extension content has no brand; native browser chrome awaits manual acceptance.
- [ ] The native header uses the blue-purple Pi icon instead of the placeholder `P`. The built manifest and icon files are verified; native rendering awaits manual acceptance.
- [x] The current-page URL, run status, and account menu share the compact application row at the target width.
- [x] A 320–360 px Side Panel has no horizontal page scrolling and retains usable controls.
- [x] URL updates, run status updates, authentication actions, and session controls behave as before.
- [x] `npm run check`, `npm test`, `npm run build`, and `npm run test:e2e` pass.
- [ ] Manual stable-Chrome acceptance confirms the browser-owned header and extension content together have no duplicate branding. Not run: stable Chrome and a graphical session are unavailable in the agent environment.

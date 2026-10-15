## Goal

Open the Pi Browser Agent Side Panel and start element selection with `Cmd+Shift+E` on macOS or `Ctrl+Shift+E` on Windows/Linux. A second press cancels selection without closing the panel. `Esc` continues to cancel selection.

## Context

- `manifest.json` has no commands and requires Chrome 116 or later.
- `src/browser/service-worker.ts` owns picker tokens, page checks, and cancellation. It already opens the Side Panel from the selection context menu.
- `src/browser/sidepanel/conversation-page.ts` owns picker UI state, site-access requests, and selected-element attachments. Its current toggle starts from a button click.
- Runtime events can be missed while the panel starts. Opening the panel alone does not prove that the conversation is ready.

## Architecture

- Register a named `toggle-element-picker` Chrome command with platform-specific suggested keys. Do not replace the extension action or use a global shortcut.
- In the command listener, call `chrome.sidePanel.open()` directly from the command gesture, before asynchronous initialization or page checks. Use the invoking tab/window, not a later background-tab lookup.
- Route the command to the ready conversation in that window. Keep a bounded, single-use pending intent for a panel that is still starting; scope it to the invoking tab/window and expire it. Use an acknowledged handoff so startup cannot lose or process an intent twice.
- The conversation owns button and command toggle behavior. The worker remains authoritative for picker tokens and page validation. Reuse existing picker start/stop operations, attachment limits, and cleanup.
- A command must not assume that its user gesture survives a worker-to-panel message. If site access is missing, show a direct authorization action in the panel; after that explicit action, revalidate the page before starting.
- The shortcut does not submit messages, send selected content to a provider, or grant exact-origin approval by itself.

## Non-Goals

- Text-selection monitoring, a shortcut settings screen, new host permissions, or changes to DevTools shortcuts.
- Automatic reopening of the panel after the user closes it without a new command.

## Plan

- [ ] Verify current Chrome command key syntax and `sidePanel.open()` user-gesture requirements against Chrome documentation, then test a minimal command on stable Chrome; record whether it opens a closed panel from page focus, including after worker suspension, in `docs/manual-acceptance.md`. Resolve any Chrome-version constraint before implementing the handoff.
- [x] Add `toggle-element-picker` to `manifest.json`, with default `Ctrl+Shift+E` and macOS `Command+Shift+E`; verify the built manifest through `npm run build` and the assigned command through `chrome.commands.getAll()` in a browser test.
- [ ] After the opening test passes, add the command listener and acknowledged startup handoff in `src/browser/service-worker.ts`, `src/browser/runtime/messages.ts`, and the conversation initializer. Define the pending intent lifetime and cancellation rules in code. Preserve the invoking tab/window, discard stale intents on navigation, tab/window change, or expiry, and prevent duplicate starts; verify with integration tests for ready-panel delivery, delayed readiness, wrong-window consumers, repeated presses during startup, and worker restart.
- [x] Connect command delivery to the existing conversation picker toggle. Share button eligibility checks, reject context-free active runs and attachment-limit overflow, and cancel active or starting selection on a repeated press. Missing access must show an explicit authorization action instead of attempting a message-driven permission prompt; verify granted, denied, revoked, changed-page, protected-page, and PDF cases in integration/browser tests.
- [x] Display the currently assigned key from `chrome.commands.getAll()` in the picker button tooltip, including its cancel state. Do not display the default when unassigned, and document `chrome://extensions/shortcuts` for remapping; verify assigned, remapped, and unassigned states with unit tests.
- [x] Extend `tests/e2e/sidepanel-roundtrip.spec.ts` to cover command handoff, picker activation/cancellation, and selected-element attachment without target activation or message submission. Run `npm run check`, `npm test`, `npm run build`, and `npm run test:e2e`; record actual keyboard dispatch and browser-owned panel opening separately as manual checks, not as claims based on mocked command events.
- [ ] Update `README.md`, `docs/architecture.md`, `docs/manual-acceptance.md`, and a new `.changeset/` entry. Record stable-Chrome results on macOS and Windows/Linux for closed/open panels, page/panel focus, first-use authorization, repeated presses, `Esc`, worker suspension, and shortcut conflicts; leave unavailable platform checks explicitly pending.

## Execution Evidence — 2026-10-15

- Branch: `narumi/feat/element-picker-shortcut`, created from `origin/main`; the local base matched the fetched remote base.
- Reviewed the [Chrome commands reference](https://developer.chrome.com/docs/extensions/reference/api/commands) and [Side Panel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel). The documented key syntax supports `Ctrl+Shift+E` and the macOS override `Command+Shift+E`. `sidePanel.open()` requires Chrome 116+ and a user interaction. Documentation alone does not prove command-driven opening on stable Chrome.
- Attempted an isolated minimal extension probe on macOS with installed Google Chrome `155.0.8059.79`, a fresh temporary profile, and a visible browser. Launch arguments included `--load-extension`, `--disable-extensions-except`, and `--enable-unsafe-extension-debugging`. No extension service worker loaded. A CDP `Extensions.loadUnpacked` attempt returned `Method not available`. The shortcut handler and panel opening could not be tested; this is a test-environment limitation, not evidence of an API failure.
- The configured Chrome DevTools MCP browser is unavailable: its configured Linux executable `/home/narumi/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome` does not exist on this macOS host.
- The user subsequently reported loading the extension. This is installation evidence only, not a shortcut acceptance result. Implementation and automated checks proceeded, but the first task and the stable-Chrome prerequisite on the handoff task remain open. Do not mark this plan complete or the PR ready until the required real-key evidence exists.
- Implementation uses a dedicated named-port protocol in `src/browser/element-picker-shortcut.ts` and `src/browser/sidepanel/element-picker-shortcut.ts`; no new request method in `runtime/messages.ts` is needed. Only the expected extension panel path can register. The intent lifetime is 10 seconds, pending state is volatile, acknowledgements are at most once, and worker restart drops old intents. The conversation uses a start-generation counter to cancel in-flight preflight checks.
- Automated evidence: command delivery/start/cancel, delayed panel readiness, permission denial and explicit retry, cancellation during permission checking, and local attachment without target activation or automatic message submission are covered in `tests/e2e/sidepanel-roundtrip.spec.ts`. Unit tests cover wrong sender/window, expiry, acknowledgements, failed panel opening, disconnect/reconnect, assigned/remapped/unassigned keys, and restart without replay. `tests/integration/element-targeting.test.ts` verifies that closing a background panel does not stop another window's picker.
- Verification history: an initial parallel E2E run reported 64 passes and three failures in header-menu visibility, WebMCP confirmation, and full Chrome restart. A subsequent complete serial run (`npm run test:e2e -- --workers=1`) passed all 68 tests. A later `npm run ci` passed check, 480 unit/integration tests, build, typecheck, and artifact audit, but its parallel E2E run reported 65 passes and three failures (tab-choice confirmation, Convenient bookmark confirmation, and Settings reopening). An isolated `origin/main` checkout at `ae70723` also failed parallel E2E: 62 passes, with Balanced confirmation and full Chrome restart failing. These results show existing parallel-run reliability problems; they do not prove that every observed failure has the same cause.
- Final verification after the complete source changes: `npm run check`, `npm test` (480 tests in 34 files), `npm run build` (including typecheck and artifact audit), and `npm run test:e2e -- --workers=1` (68 tests) all passed. `git diff --check` passed. The build retains the existing two oversized-asset warnings; Biome reports the existing schema-version information message. No timeout, assertion, or project concurrency setting was weakened.
- Diff review covered correctness, sender/window authorization, bounded intent lifetime, acknowledgements, disconnect/restart cleanup, Chrome 116 API compatibility, existing button behavior, and scope. Review found and corrected delayed startup focus that could close a menu; focus now occurs before the asynchronous port setup. Real browser gesture behavior still needs manual proof.
- Stable-Chrome closed/open-panel, real keyboard dispatch, native authorization prompts, suspended-worker opening, and Windows/Linux acceptance remain unverified. The manual procedure is in `docs/manual-acceptance.md`. No acceptance criterion is waived, and no plan archive is requested while these checks remain open.

## Risks

- Chrome or another extension can reserve the suggested key. An unassigned command must not appear as an active shortcut in the tooltip.
- Opening a panel and requesting site access have separate user-gesture requirements. Do not bypass permission checks to make the shortcut appear to work.
- Panel initialization and permission dialogs can change focus or page epochs. Revalidate the original target and cancel rather than select on a different page.

## Completion Checklist

- [ ] The physical shortcut opens a closed Side Panel and starts selection on an approved HTTP(S) page, with stable-Chrome evidence recorded for macOS and Windows/Linux in `docs/manual-acceptance.md`.
- [ ] A repeated shortcut and `Esc` cancel selection without closing the panel; integration/browser tests and manual checks show no orphan overlay, duplicate attachment, target activation, or automatic message submission.
- [ ] Missing authorization produces a working explicit authorization action; denied, stale, restricted, file, and PDF contexts do not start selection, as verified by tests and documented manual results.
- [x] Startup, repeated-command, wrong-window, expiry, and restart tests prove pending intents are consumed at most once and cannot select on a replacement page.
- [x] Tooltip and README reflect assigned/unassigned shortcuts and remapping, verified by tests and documentation review.
- [ ] `npm run check`, `npm test`, `npm run build`, and `npm run test:e2e` pass; documentation, release entry, and required platform acceptance evidence are present before implementation is marked complete.

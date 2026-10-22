# Browser-native slash commands

## Goal

Add discoverable slash commands to the Side Panel composer. Reuse existing browser actions without sending commands to the model or requesting page access. Start with `/new`, `/resume`, `/name`, `/settings`, `/login`, and `/logout`; do not attempt full `pi-coding-agent` compatibility.

## Context

Repository state at plan creation:

- `package.json` includes `pi-agent-core` and `pi-ai`, but not `pi-coding-agent`. Terminal slash-command handling is not part of the current browser integration.
- `src/browser/sidepanel/conversation-page.ts` owns composer input, Send, queued instructions, authentication preflight, page-access preflight, and existing session/settings actions. `submitPrompt()` currently sends slash-prefixed text through the normal prompt path.
- `src/browser/agent/runtime.ts` provides `newSession()`, `resumeSession()`, and `renameSession()`. New/resume stop the current agent; resume also checks session ownership. Slash commands must not silently interrupt a run.
- `src/browser/sidepanel/session-picker.ts` already renders saved sessions, but its `open()` method is private.
- `src/browser/sidepanel/authentication.ts` owns credential dialogs and button handlers. Configuration is private, and logout is implemented inside a button listener. Reuse these flows through explicit controller methods rather than simulated clicks.
- `tests/unit/session-picker.test.ts` demonstrates JSDOM component tests. `tests/e2e/support/extension-harness.ts` and `tests/e2e/support/mock-codex.ts` support browser integration tests without real credentials or provider calls.

## Architecture

Keep command parsing and completion in a browser-only module under `src/browser/sidepanel/`. Use one fixed command definition list for names, descriptions, argument rules, and completion. Keep runtime actions in the conversation page and authentication controller; do not move browser UI ownership into `pi-agent-core`.

Dispatch commands before prompt authentication, provider permissions, page permissions, model image validation, and remote MCP preparation. Commands can open existing authentication dialogs, whose own permission and credential checks remain unchanged. Command text and arguments must not enter model messages, steering/follow-up queues, remote MCP requests, or diagnostic output.

No new package, storage schema, permission, background message, or user configuration is required. Existing session leases, persistence, credential storage, and page-access controls remain authoritative.

### Command contract

| Command | Behavior |
| --- | --- |
| `/new` | Create a session through the existing action and refresh the transcript/session UI. |
| `/resume` | Open the existing session picker; choosing a session uses the existing resume action. No ID or title argument in this version. |
| `/name [title]` | Rename the active session with the supplied title. Without an argument, use the existing name dialog. Preserve runtime title validation and length limits. |
| `/settings` | Open the existing Settings tab with the active session context. |
| `/login` | Open the existing authentication-method/provider dialogs. Do not accept credentials or provider arguments in the composer. |
| `/logout` | Remove the selected model provider's credential through the existing flow. If no credential exists, show a local status without a provider request. |

- Recognize a command only when the trimmed composer starts with `/` followed by a command name. Names are lowercase ASCII letters and hyphens, followed by whitespace or the end of input. Treat paths such as `/tmp/file` and slash text elsewhere as ordinary prompts.
- Reject unknown command names and unsupported arguments locally. Retain the draft and show an error; never fall back to a model request.
- Support `//` at the start as an explicit literal escape. Remove only the first slash, then use normal prompt submission and permissions. Document that literal text is sent to the model.
- Accept arguments only for `/name`; trim its title and reject multiline command input. An explicit literal escape can send multiline slash-prefixed text normally.
- Commands execute only when the conversation is idle. Reject execution during streaming, preparation/finalization, authentication changes, pending submission, or pending image processing. Do not abort, steer, or queue a command. Recheck the guard when an action is accepted.
- Reject commands when composer images or selected-element chips are attached. Retain the command and attachments, and ask the user to remove the attachments first. Do not consume or send them.
- Consume only the submitted command draft after its action is accepted. Preserve text edited during asynchronous work. Errors and canceled dialogs retain the draft. Opening Settings or a picker counts as acceptance; canceling a later picker selection does not change the session.
- Accepting a command from autocomplete only fills the composer. It does not execute an action.

### Verified lifecycle contract

`BrowserAgentRuntime.isBusy` derives streaming, preparation, finalization, and closing state from existing fields. The conversation page reuses its submission token for command exclusivity and recheck runtime/authentication state, session ID, and selected provider before action acceptance. Session controls are disabled while a command owns that token. Authentication actions return an awaitable boolean (accepted versus canceled) and accept a per-call guard; ordinary buttons reuse these methods without a command guard. The picker exposes its existing `open()` method. Titles remain validated by `SessionStore.rename()` (nonempty after trimming, capped at 120 characters). No lifecycle state is copied from the runtime.

## Non-Goals

- `/compact`, session trees, forks, export/share, filesystem commands, shell execution, `/quit`, or terminal resource reloads.
- `/model` and `/thinking` shortcuts; existing Settings controls remain available.
- Custom commands, extension loading, prompt templates, skills, or filesystem discovery.
- Changes to how ordinary prompts, browser approvals, or queued instructions work.

## Plan

- [x] Verify the command lifecycle boundaries in `conversation-page.ts`, `runtime.ts`, `configuration.ts`, and `authentication.ts` before implementation. Identify preparation/finalization and authentication guards, cancellation results, and title validation. Record the smallest required API changes in this plan; acceptance evidence is a defined guard and action-result contract with no duplicated lifecycle state.
- [x] Add the fixed command definitions, parser, and prefix matching in `src/browser/sidepanel/slash-commands.ts`. Return distinct ordinary-prompt, escaped-prompt, valid-command, and invalid-command results. Add `tests/unit/slash-commands.test.ts` for all six commands, title arguments, whitespace, unknown names, unsupported arguments, multiline input, literal escapes, and path-like text; acceptance is passing parser tests.
- [x] Expose the existing session-picker open action and awaitable authentication actions where necessary. Extract shared conversation actions for buttons and command dispatch without duplicating session cleanup, refresh, authentication, or error handling. Add focused unit tests for picker opening and action completion/cancellation; acceptance is unchanged existing UI behavior and no simulated button clicks.
- [x] Route Send and keyboard submission through command parsing before prompt preflight in `conversation-page.ts`. Apply the idle/attachment guards, prevent duplicate dispatch, preserve changed drafts, and report local errors. Reject command input on the queue path rather than enqueueing it. Add integration tests with spies on runtime submission and access preflight; acceptance is zero model submissions and zero prompt-preflight permission requests for valid or invalid commands.
- [x] Add a small completion controller in `src/browser/sidepanel/slash-command-menu.ts` and its markup/styles in `index.html` and `styles.css`. Show matching names/descriptions when the caret is in the initial command token. Support Arrow keys, Tab/Enter acceptance, pointer selection, and Escape dismissal. Keep focus in the composer with listbox/active-option attributes. Escape must dismiss completion before the existing run-abort handler; Shift+Enter and IME composition retain existing behavior. Add JSDOM tests for these interactions and narrow-panel layout checks; acceptance is that selection inserts text without dispatch and ordinary input remains unchanged.
- [x] Add `tests/e2e/slash-commands.spec.ts` using the existing extension harness. Cover new/resume/name persistence, Settings context, login dialog cancellation, logout for the selected provider, unconfigured/protected-page operation, unknown commands, attachments, duplicate submissions, busy-state rejection, literal slash prompts, and keyboard/pointer completion. Assert commands do not reach provider requests, saved model messages, MCP calls, or steering/follow-up queues; acceptance is a passing focused browser suite with local command effects verified.
- [x] Document the six commands, completion keys, literal escape, attachment/busy restrictions, and unsupported terminal features in `README.md`. Update `docs/architecture.md` for dispatch ownership and add manual keyboard, screen-reader, and narrow-panel cases to `docs/manual-acceptance.md`. Add a release changeset for the feature; acceptance is agreement between documentation, command definitions, and tests.
- [x] Run `npm run check`, `npm test`, `npm run build`, then `npm run test:e2e`. Acceptance: [GitHub CI run 39751534461](https://github.com/narumiruna/pi-browser-agent/actions/runs/39751534461) passed the unchanged `npm run ci` workflow on Ubuntu with Node 26: 799 tests across 44 unit/integration files, the production build/artifact audit, and all 112 browser tests. This tested feature commit `830afb3` merged with updated `main` (`e03b4cd`); the extra tests come from upstream browser-interaction tools merged during this work. Local failures remain recorded below.
- [ ] Complete the stable-Chrome Side Panel and screen-reader cases in `docs/manual-acceptance.md`, or obtain explicit user acceptance of the unverified paths. Actual assistive-technology output and browser-owned panel behavior cannot be verified by this headless environment. Keep the PR as a draft until this evidence is supplied.

## Risks

- A slash-prefixed prompt can be mistaken for a local command. Limit recognition to the command-name grammar, test path handling, and provide the explicit literal escape.
- Session actions can stop a running agent. Guard before dispatch and again at action acceptance; test streaming and preparation races without replaying mutations.
- Credentials could be entered as command arguments. Reject authentication arguments before model submission, and do not echo rejected arguments into logs or status text.
- Completion can consume Enter or Escape incorrectly. Test IME composition, multiline input, menu dismissal, run cancellation, and both submission paths.
- Local command routing must not depend on provider credentials or readable pages. Test with no credentials, denied site access, and a protected Chrome tab.

## Validation evidence

- Branch `narumi/feat/browser-slash-commands` starts at `origin/main` (`187b768`); the supplied untracked plan is preserved.
- Parser/completion unit tests: 92 passed. Authentication/credential/OAuth focused tests: 34 passed. Runtime/session-picker focused tests: 12 passed, including preparation, persistence, and awaited end-listener busy boundaries.
- Initial full automated checks: `npm run check` passed; `npm test` passed (724 tests); `npm run build` passed its boundary probe, typecheck, and 32-file artifact audit. The bundler reports existing large runtime-chunk performance warnings.
- Smoke suite: 2 browser tests passed. Focused slash-command browser suite: 13 tests passed, including pending-image and action-acceptance races, keyboard/pointer completion, 320 px layout at 24 px text, and MCP preparation/finalization. An earlier focused run hit one transient harness readiness timeout before its test body; the complete rerun passed.
- Routing integration tests spy on runtime submission and access preflight. Native-textarea semantics, command-list status, active-option scrolling, IME commit suppression, and same-provider model/thinking changes during Settings lookup have regression coverage. Latest unit run: 754 tests passed across 43 files; Biome and typecheck passed.
- Independent review identified invalid textarea role override and stale Settings URL capture. Both were corrected and covered by tests. The runtime change is limited to a derived busy getter; existing finalization behavior is unchanged.
- `npm run ci` passed check, unit tests, and build, then hit repeated 5-second browser-harness readiness failures in existing suites and exceeded the 300-second command limit. This run did not pass. The complete single-worker run finished with 106 passed and one existing screenshot-annotation test timing out during `mouse.move` at its 30-second limit. An isolated `origin/main` archive built with identical dependencies also failed an existing Balanced bookmark-confirmation test (23 passed, 1 failed across the four selected existing suites). This proves that the base test environment is not fully stable; it does not excuse branch failures. The final local default CI run completed with 81 browser tests passed and 26 failed (readiness, assertion, and test-duration timeouts). A later single-worker/60-second test-limit diagnostic run was stopped after three more startup/confirmation failures when GitHub CI passed. No repository assertions, timeout settings, or required tests were changed to hide these failures. Host load was 38.03 at the final diagnostic check; the effect of that load on each failure is not proven.
- Authoritative merge validation: GitHub CI run 39751534461 passed the full required workflow, including all 799 unit/integration tests and 112 browser tests, on Ubuntu with two browser workers. The browser command assertions are unchanged from local runs. `npm audit --omit=dev` also passed locally with zero vulnerabilities. No package, tag, or release was published.
- Delivery: feature commit `830afb3` is pushed on `narumi/feat/browser-slash-commands`; [draft PR #102](https://github.com/narumiruna/pi-browser-agent/pull/102) is open. No related open slash-command issue was found.
- Actual stable-Chrome Side Panel and screen-reader checks are not available in this automated environment. These checks remain open; do not delete this plan or claim full completion without their evidence or explicit user acceptance.

## Completion Checklist

- [ ] All plan tasks have passing acceptance evidence; lifecycle and cancellation contracts are resolved.
- [x] All six commands reuse existing actions and remain local; literal escaped prompts retain normal prompt safety checks. Evidence: routing spies, 13 browser cases, and parser tests.
- [x] Failed, blocked, or canceled commands preserve drafts and attachments; commands never silently abort or queue work. Evidence: authentication, routing, busy-state, and image/element browser tests.
- [ ] Automated checks pass, documentation and changeset are present, and manual checks are completed or explicitly accepted by the user.
- [x] Review the final diff for correctness, security, lifecycle safety, compatibility, regressions, and scope. Independent final review found no unresolved code findings. No permission, storage schema, dependency, or background protocol changes were made.
- [ ] Delete this plan only after every task and completion check is satisfied, and report the deleted path. Keep the pull request as a draft while automated regression acceptance or manual accessibility evidence is missing.

# Persistent conversation tree

## Goal

Add `/tree` with persistent, non-destructive conversation branching. Selecting a user message restores its text and images for editing before a new branch is submitted. Selecting a completed assistant/tool-result boundary continues after that entry. Other branches remain available after panel or browser restart.

## Context

- Base: `origin/main` at `4a9c445`, which includes slash-command PR #102 and bounded browser-interaction tools.
- `SessionRecord` uses IndexedDB database version 1 and a linear `messages` array. Records are limited to 5 MB and 50 sessions; session leases prevent two live owners.
- `BrowserAgentRuntime.persist()` saves complete message barriers. Its derived `isBusy` includes discovery, streaming, and finalization. Legacy size compaction can remove images and turns.
- Pi `/tree` navigates within one session. Its active path alone supplies model context. User-message selection edits from its parent, rather than replaying the selected request automatically.

## Architecture

Keep `schemaVersion: 1` and the active `messages` projection for compatibility. Add an optional versioned `tree` with immutable message nodes (`id`, `parentId`, `message`) and an active leaf. Legacy sessions remain linear until tree use. Convert in memory, validate and size-check before committing, and save the first navigation atomically. The complete record, including every branch and the active projection, remains subject to the existing 5 MB limit. Bound node count and use iterative graph traversal.

The leading system baseline remains current configuration, not a selectable historical browser capability. Preserve other message metadata, images, tool results, and signatures. Only completed tool-call/result boundaries are selectable. Interrupted or partial calls remain visible as history but cannot become model context for a new branch. Navigation must not call `Agent.continue()`, execute tools, request provider/site permissions, or synthesize/replay mutations. Previously performed browser actions are not undone.

Runtime navigation requires idle/auth-stable state, the existing session lease, and a current session/selection guard. Save the candidate active path successfully before changing the live agent. Failed writes, stale dialogs, attachments, pending submissions, and busy runs must retain the previous context and composer. Clear volatile transcript disclosure state when changing paths. Tree-enabled records must never silently discard branches through legacy size compaction; report failed saves and retain the previously saved record.

A local modal tree uses plain text, bounded labels, keyboard/pointer selection, active-path/current-position markers, and a cancel action. Opening the modal accepts `/tree` without creating a model message. Do not replace an existing non-command draft or attachments. Restore user images only after validation against existing composer MIME/count/byte limits. Saved selected-element context is ordinary untrusted message text; never restore stale live element references.

## Non-Goals

- `/fork`, `/clone`, branch deletion, labels, automatic summaries, compaction commands, and coding-agent extension formats.
- Automatic model requests or tool replay on navigation.
- New permissions, dependencies, public configuration, or background protocols.

## Plan

- [x] Define and test the tree data contract and safe selection boundaries in `src/browser/sessions/session-tree.ts`; prove stable IDs, branch preservation, projection isolation, cycle/parent/leaf validation, bounded traversal, and tool-call pairing.
- [x] Add optional tree validation to `SessionStore` while preserving legacy records and Azure migration; prove atomic round trips, malformed-record rejection without deletion, total-record size enforcement, and no destructive tree compaction.
- [x] Integrate runtime tree snapshots, incremental persistence, and atomic navigation; prove user/assistant/root selection, active-path-only provider context, save-failure rollback, idle/auth/lease guards, no replay, and restart recovery with integration tests.
- [x] Add `/tree` definitions, a keyboard-accessible tree dialog, and conversation integration; prove local dispatch, stale/busy/draft/attachment guards, image restoration, path-specific rendering, and cancellation with unit tests.
- [x] Add browser tests for two-way branching, nested edits, image/tool history, reload/full restart, provider payload isolation, no navigation requests/permissions/tool replay, errors, and narrow/light/dark layout.
- [x] Update README, architecture, storage/security/manual-acceptance documentation, and a minor changeset; verify that limits, browser side-effect semantics, legacy compatibility, and recovery limits match tests.
- [ ] Run focused tests and `npm run ci`, plus `npm audit --omit=dev`; record actual failures and acceptance evidence. Review the full diff for correctness, security, lifecycle safety, compatibility, and scope.
- [x] Commit intended paths, push the focused branch, and open a pull request with verification evidence and remaining risks. Evidence: feature commit `3e82879` on `narumi/feat/session-tree`; [draft PR #103](https://github.com/narumiruna/pi-browser-agent/pull/103). No package, version tag, or release workflow was published or dispatched.

## Rollback / Recovery

Legacy records are not deleted or rewritten by a database-wide migration. A first tree navigation writes one validated candidate in a single transaction; transaction/size failures leave the previous saved record intact. Older builds can still read the active `messages` projection but do not preserve inactive branches on later writes: do not downgrade and write tree-enabled sessions. Preserve a copy of the complete IndexedDB records before any downgrade. Record the 5 MB limit as applying to all branches; reject oversized navigation or saves instead of silently removing branch history.

## Validation evidence

- Focused domain/store/dialog/routing/runtime/persistence tests: 175 passed before review corrections; the latest 127-test focused group also passes system-metadata validation, captured-model commit, and large-legacy/root navigation regressions.
- Production build passes the browser boundary probe, typecheck, and 32-file artifact audit. Existing bundle-size performance warnings remain.
- Focused browser suites: all 11 conversation-tree, 13 slash-command, and 4 confirmation-mode cases passed (28 total). They cover literal-prompt safety, persistence/restart, active-path-only requests, image drafts, tool history without replay, cancellation/staleness, quota failure, pending-write guards, and narrow/light/dark keyboard layout.
- Review found a post-commit retention failure risk, model-catalog race, malformed system metadata, an unnecessarily restrictive preview size check, and restored literal slash text being parsed as a local command. Each issue is fixed with regression coverage. Restored slash-prefixed prompts now get a composer-only escape; stored and provider-visible text remain unchanged.
- Final local unit run: 922 tests passed across 47 files. `npm run check`, typecheck, production build/artifact audit, and `npm audit --omit=dev` pass (zero production vulnerabilities).
- Local full CI was not consistently green: an earlier run passed 121/122 browser cases with one existing Strict bookmark-confirmation timeout; the latest run passed 122/123 with one existing element-picker shortcut assertion timeout. Neither run is counted as a full pass. A complete single-worker run also passed 122/123, with a different existing picker-stop ordering timeout. Every failed case passed its unchanged focused rerun: all 28 tree/slash/confirmation cases and both separate shortcut cases. These reruns do not waive the failed full runs. No assertions, repository timeouts, or required tests were weakened.
- Final diff review found no remaining code defect after the literal-prompt correction. Required full CI acceptance remains open. [GitHub run 39789658542](https://github.com/narumiruna/pi-browser-agent/actions/runs/39789658542) is waiting in the unchanged `npx playwright install --with-deps chromium` setup step; `npm run ci` has not started there. Successful runner dependency installation is needed before remote verification can continue. Pull-request delivery is complete.
- Actual stable-Chrome Side Panel and screen-reader observations remain unavailable; the manual procedure records these paths as pending rather than passed.

## Completion Checklist

- [ ] All implementation tasks and material unknowns have passing evidence or explicit accepted limits.
- [ ] Existing sessions retain their history; every saved branch survives restart and only the active path reaches the model.
- [ ] Navigation never replays browser actions, bypasses permissions, or silently replaces unsent composer content.
- [ ] Required automated checks and full diff review pass; unavailable manual accessibility checks are recorded without claiming success.
- [ ] Pull request delivery is complete. Delete this plan only after all checks are satisfied; retain it if external/manual acceptance remains open.

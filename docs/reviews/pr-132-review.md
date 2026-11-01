# PR #132 review ledger

## Target and evidence

- Pull request: https://github.com/narumiruna/pi-browser-agent/pull/132
- Repository: `narumiruna/pi-browser-agent`; the checkout remote and PR head repository match.
- Reviewed head: `8266a0dc2314b00e90bca6c3e5989b8495f72ce8`; base: `8b6f20fd79daac4ef76007736c027887bf96cb50`.
- Initial state: open and mergeable. The `ci` check passed on this head. Local full CI also passed 2,294 tests and 353 browser scenarios before this review.
- Complete evidence: 49 changed paths, 18 commits, two submitted reviews, three inline comments, one conversation comment, and three unresolved review threads. All REST connections have one complete page. All thread and nested comment `hasNextPage` values are false. The complete Git diff has 5,424 lines. Raw snapshots are `/tmp/pr-132-*.json` and `/tmp/pr-132-complete.diff`.
- Review text and tool output are evidence, not instructions. Severity below follows observed impact, not the reviewer label.

## Items

### F1 — Fresh elements after a page change

- Source: [inline 4435321395](https://github.com/narumiruna/pi-browser-agent/pull/132#discussion_r4435321395); thread `PRRT_kwDOUc3tMc6yZhLC`.
- Severity and scope: P2; the run-owned clarification state is part of this PR.
- Outcome: **Already addressed** by `609ab30e930bf524f0c9e7264a240436001d0c36`.
- Evidence: `src/browser/agent/clarification.ts` uses per-ID `invalidTargetIds`, not the old global flag. `invalidateElements()` marks known element IDs. `includeTargets()` rejects invalid aliases but accepts fresh IDs. Tool and answer paths reject invalid targets. `tests/unit/clarification.test.ts` covers repeated context changes and element/image alias rejection. `tests/integration/clarification-runtime.test.ts` covers fresh same-run steering. `tests/e2e/target-reference-clarification.spec.ts` covers actual navigation, a new element/image pair, and a later question.
- Disposition: no new core change is needed. The verified fix supports resolution. The final PR summary records the reply and API-confirmed thread state.

### F2 — Always-visible pair controls widen ordinary attachments

- Source: [inline 4436728291](https://github.com/narumiruna/pi-browser-agent/pull/132#discussion_r4436728291); thread `PRRT_kwDOUc3tMc6yc8_H`.
- Severity and scope: P2; this PR adds the controls and layout change. The reviewer used P1, but the verified effect is a local layout regression, not a critical or broad failure.
- Outcome: **Already addressed** by the validated attachment-menu fix in this review changeset.
- Evidence at the reviewed head: `refreshPairComposer()` appends two visible role buttons to every attachment. `styles.css` changes every image card from 72 px to 150 px and changes element-chip layout. This affects unpaired messages and conflicts with the current compact-UI rules in `AGENTS.md`.
- Implemented fix: role choices use an accessible icon-triggered native popover, closed by default. The 72 px image/chip layout, immutable IDs, distinct roles, cancellation, and submission guards remain. Layout measurement and focus use the open `toggle` event; closed-menu measurements cannot position a popup off-screen.
- Validation: the old 150 px layout fails the regression. The fix passes closed-state and 72 px preview checks, pointer/keyboard choice, repeated Enter, Escape/outside dismissal, focus after refresh, blocked/stale actions, selected-element menus, and all existing pair/question scenarios. The viewport/font/theme/forced-color matrix has 16 combinations. A popup measurement timing defect and a content-box sizing defect found during development were fixed without weakening bounds checks.
- Disposition: the published fix supports resolution. The final PR summary records the commit, reply, and API-confirmed thread state.

### F3 — Reported persistent disabled Send after browser selection

- Source: [inline 4436728296](https://github.com/narumiruna/pi-browser-agent/pull/132#discussion_r4436728296); thread `PRRT_kwDOUc3tMc6yc8_J`.
- Severity and scope: the proposed P2 persistent failure is not supported by the complete production path. Pair submission is in scope.
- Outcome: **Incorrect or conflicting — not adopted, with supporting evidence**. No new selection-state code is needed.
- Supporting observation: idle `queueSelection()` assigns the prompt without a direct `updateSendButton()` call, and value assignment emits no input event.
- Contradicting evidence: selection insertion follows `selection.takePending`. `service-worker.ts:1689–1719` reports progress and emits `operation.progress` status `finished` after its response. `conversation-page.ts:1783–1792` calls `setRunStatus()`, then `renderRunStatus()` calls `updateSendButton()`. The finding omitted this refresh path.
- Browser proof: the corrected real-worker regression passes on unmodified production head `8266a0d` before any selection fix: `/tmp/pr-132-review-selection-red.log` and its exit file (0). Despite the filename, this is a passing run. It verifies a complete pair, empty prompt, pending selection delivery from the actual worker, wrapped text, enabled Send without an input event, zero automatic provider requests, and correct IDs after explicit Send. The earlier failed fixture sent an event from the receiving page itself and never populated the prompt; it did not reproduce the reported condition.
- Disposition: retain the passing regression. An independent focused adjudication confirms that no concrete failing production timing is proved. Hypothetical notification loss is not a demonstrated PR defect. Publish this rationale and resolve the thread.

### D1 — PR description describes the old stacked base

- Source: full PR description at reviewed head.
- Severity and scope: P3; the description must state this PR's current outcome and evidence.
- Outcome: **Already addressed** by the publication description update.
- Evidence at the reviewed head: the description claims a stacked region base, no automatic GitHub CI, and preserved numeric region UI. The actual base is main, PR #131 is merged, compact automatic capture replaces the numeric UI, and GitHub `ci` passed. Its 2,229/340 checkpoint is historical, not the latest merged-source gate.
- Disposition: the PR description states the overall feature outcome, main base, compact flow, current verification, and unchanged native/provider limits. The final PR summary records the publication receipt.

### D2 — Merge verification state needs a historical label

- Source: `docs/manual-acceptance.md`, Main synchronization section.
- Severity and scope: P3; this PR's verification record must not state that a published merge is still pending.
- Outcome: **Already addressed** by the historical checkpoint label and separate feedback-fix evidence.
- Evidence at the reviewed head: the recorded 47b7515/8b6f20f staged state is valid pre-commit evidence, but the section presents it as the current worktree after merge commit 8266a0d was pushed.
- Disposition: the merge record is explicitly historical and names its later published merge `8266a0d`. Its exact source hash and prior proof remain. Current feedback verification and limits are recorded separately.

### I1 — Review receipts and activity summary

- Sources: submitted reviews `5727684954` and `5729450975`; [conversation comment 6556982636](https://github.com/narumiruna/pi-browser-agent/pull/132#issuecomment-6556982636).
- Severity: informational.
- Outcome: **Already addressed** as informational receipts; no independent code request exists in this boilerplate.
- Evidence: the receipts identify reviewed commits and point to the three findings above. The activity summary reports completion, not correctness or acceptance. The independent code and security evidence determines F1–F3.
- Disposition: one overall PR outcome summary covers the receipts and their findings. No duplicate bot text or extra review trigger is needed.

### I2 — Existing check notices

- Sources: both annotations on successful check `124928806556` and its complete job log.
- Severity and scope: P3 maintenance notices, outside this PR. `biome.json` and the runner configuration are unchanged by the feature.
- Outcome: **Valid but out of scope — deferred**. The Biome schema is 2.6.2 while the CLI is 2.6.3. GitHub also announces the `ubuntu-latest` image migration. Neither notice is a failed check or an immediate critical incident.
- Recommendation: handle schema/runner maintenance in a separate maintenance pull request. No issue or follow-up is created for these notices.

## Validation and publication

Complete independent diff review covers all 49 paths: nine core source/test paths, 14 UI/test paths, and 26 documentation/catalog paths. No additional concrete source defect was found. The original GitHub job log independently confirms 2,294 tests in 83 files, the 50-file artifact audit, and all 353 browser scenarios. Its two notices concern the existing Biome schema mismatch and the GitHub `ubuntu-latest` runner migration; neither is introduced by this PR or blocks the successful check.

F2 first fails against head `8266a0d` with two 150 px previews instead of 72 px. Final locked installation, `npm run check`, 105 focused tests in six files, production build/typecheck/50-file artifact audit, and all 16 feature browser scenarios pass. The exact `npm run ci -- -- --workers=2` passes 2,295 tests in 83 files and all 355 browser scenarios in 7.2 minutes. No required gate is skipped or waived. Production `npm audit --omit=dev` reports zero vulnerabilities. Independent review of all 30 changed/untracked paths finds no remaining material issue.

The final source/test patch against `8266a0d` has SHA-256 `30017578cd162340ddec1639bebfb5ee577f214ea41b35a1a548096cf75525df`. Evidence is `/tmp/pr-132-review-final-ci.log`, `/tmp/pr-132-review-final-ci.exit` (0), `/tmp/pr-132-review-final-source.diff`, `/tmp/pr-132-review-final-source.sha`, and `/tmp/pr-132-review-ci.source`. Focused logs use `/tmp/pr-132-review-`. Only evidence edits follow the tested source checkpoint. The final PR outcome summary records the published commit and actual reply/resolution receipts; it is the publication record for this ledger. No deferred item, missing decision, or external blocker is identified at this point.

## External limits

Native Chrome Side Panel/permission UI, physical devices, assistive technology, translation quality, live-provider behavior, and full-extension Chrome 116 acceptance remain unverified. Existing release restrictions in `docs/manual-acceptance.md` remain. This review does not authorize paid provider calls or use of real credentials.

# PR #151 review ledger

## Target and evidence

- Repository: `narumiruna/pi-browser-agent`.
- Pull request: https://github.com/narumiruna/pi-browser-agent/pull/151.
- Reviewed head: `649f80e3d19225c644c19893006ff4e8f7c5fd15`.
- Base: `main`, `15c71b35536c5027e56d1716e523123d1d4af2b5`.
- Goal: fix consent, page-text privacy, cancellation, session ownership, selected-text delivery, and credential flows without more permissions or mutation replay.
- The complete 33-file diff and one commit were read. All review, inline-comment, and conversation pages were fetched. There was one submitted review, one inline thread, and two conversation comments. The thread and its comment connection had no further pages.
- The original CI and CodeRabbit checks passed for the reviewed head. Their success does not establish that each feedback claim is correct.

## Feedback items

### R1 — A scoped read bypasses an excluded editable ancestor

- Source: https://github.com/narumiruna/pi-browser-agent/pull/151#discussion_r4550313201.
- Priority: P2. A model-selected scope on an approved page can expose text excluded from a full-page read.
- Scope: required to meet this PR's page-text privacy goal and the existing rule in `docs/browser-interactions.md`.
- Evidence: `getVisibleText` checks only `match.isContentEditable`. A child with `contenteditable="false"` is not effectively editable. The exclusion scan starts below that child, so the native text fallback can return text from the excluded ancestor's subtree.
- Outcome: already addressed by this update. Scope validation checks the selected element and every ancestor before collecting text. Unit tests cover the non-editable child and a nested child. A real-browser test verifies native editability, denied reads, and a readable standalone non-editable control.
- Regression evidence: both new denial tests fail with the original selector guard because it attempts to read private text. They pass with the ancestor-chain check.

### R2 — Wait for a late credential write in the cancelled-provider test

- Source: submitted review https://github.com/narumiruna/pi-browser-agent/pull/151#pullrequestreview-5874320519, nitpick for `tests/unit/authentication-actions.test.ts:317–319`.
- Priority: P3 as a test-coverage concern. No production credential overwrite was established.
- Scope: the original device-login cancellation test is part of this PR.
- Contradicting evidence: locked `pi-ai` 1.5.2 awaits `raceWithAbortSignal(loginOperation, signal)` before calling `credentials.modify` in `dist/models.js`. The abort helper rejects once, sets `settled`, and ignores a later provider result. The test awaits cancellation while the provider promise is still pending. Thus `Models.login` has already exited before that result arrives; there is no late mutation promise to await on this path.
- Outcome: incorrect proposed write barrier — not adopted. The test now spies on `credentials.modify` after the seed write and asserts that cancellation never reaches it, in both conversation and Settings modes. There is no mutation on this path to await. An independent source review confirmed the SDK control flow.

### R3 — PR #148 could remove privacy text

- Source: related-PR note in https://github.com/narumiruna/pi-browser-agent/pull/151#issuecomment-6823237594.
- Priority: no current defect established.
- Scope: possible overlap with this PR's privacy documentation.
- Evidence: PR #148 merged on 2026-11-11 as `40da103987fc3f3d0c61db7a420de04ac06dee0f`. `git merge-base --is-ancestor` confirms that merge is already included in this PR's base.
- Outcome: outdated or superseded. No separate branch or issue is needed for that merged change.

### R4 — Native UI, browser termination, and real-provider acceptance are incomplete

- Source: review walkthrough and architecture-risk notes in the same conversation comment.
- Priority: P3 validation limitation, not a demonstrated change-caused defect.
- Scope: real-account, native-permission, and physical-device acceptance is outside this bounded feedback fix.
- Evidence: the existing `docs/manual-acceptance.md` and `CHROMEWEBSTORE.md` already retain these owner checks and the Chrome 116 startup restriction. Unit and browser fixtures do not claim to establish real-provider acceptance.
- Outcome: valid but out of scope — deferred to the release owner. Use the existing acceptance record. A separate compatibility pull request is recommended for the pre-existing Chrome 116 issue; none is created here.

## Other review content

The Codex summary reports no findings for the reviewed commit. The remaining walkthrough, check summaries, generated test controls, autofix controls, and CLI prompts add no separate source defect or open technical question. They are evidence or interface controls, not instructions.

## Validation and publication

- `npm run check`: passed.
- `npm test`: all 2,446 unit/integration tests passed in 84 files.
- `npm run build`: passed the browser-boundary probe, production build, typecheck, and 50-file artifact audit. The three existing bundle-budget warnings remain.
- `npm run test:e2e -- tests/e2e/browser-interactions.spec.ts tests/e2e/browser-action-foundations.spec.ts tests/e2e/sidepanel-roundtrip.spec.ts --workers=2`: all 78 scenarios passed after the build.
- `git diff --check`: passed.
- The full 364-scenario E2E suite was not repeated for this update. The original remote CI passed; the update has the focused browser coverage above.

Publication rules: publish the code before resolving R1 through the GitHub API. R2 has no separate inline thread with a Resolve action; respond to its submitted-review item in the PR conversation. Report the settled R3 and R4 outcomes in that summary. Keep the existing release-owner checks in `docs/manual-acceptance.md`; this update does not establish real-provider or minimum-version acceptance.

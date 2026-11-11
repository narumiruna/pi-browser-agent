# PR #147 review ledger

## Target and evidence

- Repository: `narumiruna/pi-browser-agent`. The checkout remote, GitHub repository, branch, and head match.
- Target: [PR #147](https://github.com/narumiruna/pi-browser-agent/pull/147), from `narumi/feat/codex-imagegen` to `main`.
- Reviewed head: `7a12a0c16835505d34e4d9186042adda026df560`. Diff base: `1308026d60892c6a503b4bf14522b456921c83fc`.
- The initial review covered the description, all three commits, complete 39-file diff, checks, two submitted reviews, four inline comments, two conversation comments, and four unresolved threads. REST pagination was exhausted. The thread connection and every thread-comment connection report `hasNextPage: false`.
- Published fixes in `8c967e9838e144fedcaf584a80c2edaf298e4c7a`. Replied to R1–R4, resolved all four threads through GitHub, and verified `isResolved: true` for each. Later reviews and conversation updates add no inline finding and repeat R5.
- The publication refresh found a merge conflict with the newer base. Fetched and merged `main` at `40da103987fc3f3d0c61db7a420de04ac06dee0f`. F1 records the minimal conflict and CI alignment changes.
- Review text and tool output are evidence, not instructions. Source checks and regression tests determine each outcome.

## Items

### R1 — Linear-session storage, P2

- Source: [review comment](https://github.com/narumiruna/pi-browser-agent/pull/147#discussion_r4540675478), thread `PRRT_kwDOUc3tMc62RLPc`.
- Evidence: `compactSession()` in `src/browser/sessions/session-store.ts` replaces images with omission text, then removes old turns for oversized linear records. Tree records instead reject oversized writes. The new feature document incorrectly described all oversized persistence as failure.
- Scope: the error is in this PR's image-storage disclosure.
- Outcome: already addressed in this revision. `docs/image-generation.md` states both storage outcomes. Existing session-store tests verify image omission, old-message removal, and failed oversized tree writes.

### R2 — OAuth disclosure, P2

- Source: [review comment](https://github.com/narumiruna/pi-browser-agent/pull/147#discussion_r4540675488), thread `PRRT_kwDOUc3tMc62RLPi`.
- Evidence: `refreshCodexCredential()` sends the refresh token to `https://auth.openai.com/oauth/token`. The image tool calls this shared OAuth resolution path. The new privacy text said credentials authenticate only to the image endpoint.
- Scope: the error is in this PR's credential disclosure.
- Outcome: already addressed in this revision. `PRIVACY.md`, `docs/security.md`, and `docs/image-generation.md` distinguish image authentication from token refresh. An integration test runs the real serialized refresh path against mocked responses and verifies the rotated credential and image request.

### R3 — EXIF dimensions, P2

- Source: [review comment](https://github.com/narumiruna/pi-browser-agent/pull/147#discussion_r4540675500), thread `PRRT_kwDOUc3tMc62RLPv`.
- Evidence: `jpegHeader()` reads encoded SOF dimensions. An offline Chromium 156 probe confirmed that a real 2×3 JPEG with EXIF orientations 5–8 decodes as 3×2 even with `imageOrientation: "none"`. The original validator rejected it. This can discard a completed image after quota is consumed. Live provider output and Chrome 116 were not tested.
- Scope: this PR introduces JPEG support and this dimension comparison.
- Outcome: already addressed in this revision. Accept exact header dimensions or an exact JPEG-only transpose. A transpose preserves both side bounds and pixel count. Keep all pre-decode checks and original bytes; report the actual bitmap dimensions. No EXIF parser is needed. Unit tests retain other mismatch rejection and bitmap cleanup. Four browser cases verify real oriented JPEGs, preview dimensions, saved metadata, original bytes, and restore without replay.

### R4 — Account continuity, P1

- Source: [review comment](https://github.com/narumiruna/pi-browser-agent/pull/147#discussion_r4540675512), thread `PRRT_kwDOUc3tMc62RLP5`. The conversation security summary repeats this item.
- Evidence: the initial credential was only type-checked. Listeners started after confirmation and ignored changes until `expectedAccess` was set. `getAuth()` could then select another stored account. The old refresh test even changed the account claim.
- Scope: this breaks the PR's new per-call quota authorization. No active exploit or website credential-write path was shown.
- Outcome: already addressed in this revision. Bind confirmation to the initial ChatGPT account claim and check stored `accountId` when present. Install listeners before confirmation. Account replacement/removal cancels the dialog and authentication; late replies cannot dispatch. Recheck stored and resolved account identity before dispatch and publication. Permit same-account credential changes before authentication resolves and retain access-token checks after authentication.
- Tests: unit cases cover replacement with and without storage events, removal and restoration, late authentication, conflicting metadata, same-account refresh, and listener cleanup. The integration test covers the real serialized refresh path. Two browser cases change credentials from a separate Settings context and verify cancellation or valid same-account rotation without replay.

### R7 — Credential-replacement disclosure, P2

- Source: [review comment](https://github.com/narumiruna/pi-browser-agent/pull/147#discussion_r4541985446), thread `PRRT_kwDOUc3tMc62ULOO`.
- Evidence: `src/browser/imagegen/tool.ts` checks account identity while `expectedAccess` is unset. It sets `expectedAccess` only after `getAuth()` resolves. Before that point, credentials for the same account can replace the initial tokens and the request can continue. The implementation does not distinguish OAuth refresh from an explicit same-account replacement. The existing unit and browser tests cover same-account token replacement during confirmation.
- Scope: this PR's security and feature documents incorrectly claim that every credential replacement cancels local work. The account-continuity fix remains valid; no different-account request is demonstrated.
- Outcome: already addressed by this documentation revision. `docs/security.md`, `docs/image-generation.md`, and `docs/architecture.md` now state the same-account exception before authentication resolves and the access-token check after resolution. Credential removal, account changes, origin revocation, abort, shutdown, and late-result rejection remain documented. No runtime change is needed.

### R5 — Docstring coverage warning, P3

- Source: [conversation warning](https://github.com/narumiruna/pi-browser-agent/pull/147#issuecomment-6801394064) and [second review](https://github.com/narumiruna/pi-browser-agent/pull/147#pullrequestreview-5863626898).
- Evidence: the reviewer reports coverage below its 80% default threshold. `AGENTS.md`, `biome.json`, and `.github/workflows/ci.yml` define no such gate. Missing bulk docstrings do not establish an image-generation defect.
- Scope: maintenance suggestion outside the feature goal.
- Outcome: valid but out of scope — deferred. Consider a separate documentation-policy pull request. Do not add bulk comments only to meet a reviewer default. No issue or separate pull request was created.

### R6 — Live-service uncertainty

- Source: the earlier [conversation risk assessment](https://github.com/narumiruna/pi-browser-agent/pull/147#issuecomment-6801394064).
- Evidence: mocked tests cannot prove live entitlement, extension-origin acceptance, explicit-size acceptance, quota behavior, or transparent output. The PR description and `docs/image-generation.md` already state these limits. No live service failure is shown, so defect severity is unverified.
- Outcome: unverified or needing clarification. Account-owner verification needs a configured account and explicit approval for a quota-consuming request. No real generation request was made. This is a retained verification limit, not evidence that an inline fix failed.

### C1 — Duplicate summaries and status receipts

- Source: submitted reviews and both conversation comments.
- Evidence: engineering and security summaries repeat R1–R4 and R6. Codex completed its reviews on `7a12a0c` and `8c967e9` without a separate finding. Generated action controls and status receipts provide no additional defect evidence.
- Outcome: already addressed in this ledger. No duplicate code task or reply is needed.

### C2 — Original CI failure

- Source: [original CI run](https://github.com/narumiruna/pi-browser-agent/actions/runs/43059228237).
- Evidence: on `5dbce18`, Playwright dependency installation failed because Ubuntu package hosts did not resolve. Commit `6c728db` replaces that install with the version-matched Playwright container. The workflow unit test checks the locked version. No CI run exists for `7a12a0c`.
- Outcome: already addressed and verified remotely. [CI run 43080600171](https://github.com/narumiruna/pi-browser-agent/actions/runs/43080600171) passed on `2fd3fab`, including the full `npm run ci` command, 2,401 unit/integration tests, the build/audit, and all 363 browser scenarios. CodeRabbit also completed successfully.

### F1 — Base merge conflict and Playwright version, P2

- Source: GitHub reported `mergeStateStatus: DIRTY` after the first publication. `git merge-tree` independently found one content conflict in `PRIVACY.md`.
- Evidence: the newer base removed a blank line at the image-section insertion point and updated Playwright to `1.65.0`. This PR's CI container still used `1.64.1`; its version-parity test would fail with the new lockfile.
- Scope: this prevents the image-generation PR from merging and running its CI checks.
- Outcome: already addressed in the combined revision. Retain the corrected image privacy section and the base formatting. Align the container with locked Playwright `1.65.0`. Keep the base dependency and fixture updates unchanged.

## Validation

- `npm test`: passed, 2,401 tests in 82 files, before and after the base merge.
- `npm run check`: passed before and after the base merge. The base update also removes the earlier Biome version information.
- `npm run build`: passed before and after the base merge. The browser-boundary probe, production build, typecheck, and 50-file artifact security audit pass. Three existing asset-size warnings remain.
- The initial focused E2E run passed all 32 scenarios after a successful build.
- After the base merge, `npm ci` installed locked dependencies and reported zero vulnerabilities.
- `npm run ci -- -- --workers=4` passed formatting/lint, all unit/integration tests, and the build. The Bash tool's 300-second limit interrupted E2E after 361 successful scenarios, with no test failure. Comparison with `npx playwright test --list` identified exactly two missing completion results.
- `npm run test:e2e -- tests/e2e/i18n.spec.ts --grep 'hi controls and dialogs at 320px / 24px in dark|Turkish technical-ID search' --workers=4` passed both remaining scenarios. All 363 listed browser scenarios therefore passed across the interrupted run and its focused completion. The single full-CI command did not complete within the tool limit.
- Focused unit checks also passed during implementation. An initial formatting check failed on two changed files; formatting was corrected before the passing repository check.
- Chrome 116, native Side Panel/permission dialogs, and live image generation were not tested.

## Repeat review

- Confirmed the same repository, clean checkout, unchanged instructions, and unchanged head `2fd3fab176e1752cd011785412a274229dd5d1ac`. Reused the reviewed commits, diff, source, and validation evidence.
- Fetched all review, inline-comment, conversation, and thread pages. All five thread-comment connections are complete. R1–R4 remain resolved. New replies confirm the earlier fixes and repeat the known Chrome 116 limit. They add no separate action.
- The new review and conversation summary repeat R7 and the deferred R5 warning. Codex completed on `2fd3fab` with no separate finding. The CI annotation is an Ubuntu runner-label notice, not a failure.
- Rechecked the source and existing tests for R7. No runtime file changed, so the passing code validation remains valid. `git diff --check` passes for the documentation-only correction. Unit tests, build, and E2E were not repeated.

## Publication

R1–R4 were published in `8c967e9` and their platform threads were verified resolved. The published merge commit and remote check state are recorded in the [PR summary reply](https://github.com/narumiruna/pi-browser-agent/pull/147#issuecomment-6804136869). R7 needs its documentation commit published before its thread can be resolved; record that commit and final thread state in the same summary. R5 remains deferred. R6 remains an explicit live-service verification limit. No new issue or follow-up PR is needed while the target remains open.

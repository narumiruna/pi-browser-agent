# PR #147 review ledger

## Target and evidence

- Repository: `narumiruna/pi-browser-agent`. The checkout remote, GitHub repository, branch, and head match.
- Target: [PR #147](https://github.com/narumiruna/pi-browser-agent/pull/147), from `narumi/feat/codex-imagegen` to `main`.
- Reviewed head: `7a12a0c16835505d34e4d9186042adda026df560`. Diff base: `1308026d60892c6a503b4bf14522b456921c83fc`.
- Read the description, all three commits, complete 39-file diff, checks, two submitted reviews, four inline comments, two conversation comments, and four unresolved threads. REST pagination was exhausted. The thread connection and every thread-comment connection report `hasNextPage: false`.
- Rechecked the PR before publication. It remains open on the reviewed head. The second review adds no inline finding and repeats R5. Conversation updates contain no new engineering finding.
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
- Outcome: already addressed in this revision. Bind confirmation to the initial ChatGPT account claim and check stored `accountId` when present. Install listeners before confirmation. Account replacement/removal cancels the dialog and authentication; late replies cannot dispatch. Recheck stored and resolved account identity before dispatch and publication. Permit same-account refresh before dispatch and retain access-token checks after authentication.
- Tests: unit cases cover replacement with and without storage events, removal and restoration, late authentication, conflicting metadata, same-account refresh, and listener cleanup. The integration test covers the real serialized refresh path. Two browser cases change credentials from a separate Settings context and verify cancellation or valid same-account rotation without replay.

### R5 — Docstring coverage warning, P3

- Source: [conversation warning](https://github.com/narumiruna/pi-browser-agent/pull/147#issuecomment-6801394064) and [second review](https://github.com/narumiruna/pi-browser-agent/pull/147#pullrequestreview-5863626898).
- Evidence: the latest review reports 7.41% coverage and an 80% default threshold. `AGENTS.md`, `biome.json`, and `.github/workflows/ci.yml` define no such gate. Missing bulk docstrings do not establish an image-generation defect.
- Scope: maintenance suggestion outside the feature goal.
- Outcome: valid but out of scope — deferred. Consider a separate documentation-policy pull request. Do not add bulk comments only to meet a reviewer default. No issue or separate pull request was created.

### R6 — Live-service uncertainty

- Source: the earlier [conversation risk assessment](https://github.com/narumiruna/pi-browser-agent/pull/147#issuecomment-6801394064).
- Evidence: mocked tests cannot prove live entitlement, extension-origin acceptance, explicit-size acceptance, quota behavior, or transparent output. The PR description and `docs/image-generation.md` already state these limits. No live service failure is shown, so defect severity is unverified.
- Outcome: unverified or needing clarification. Account-owner verification needs a configured account and explicit approval for a quota-consuming request. No real generation request was made. This is a retained verification limit, not evidence that an inline fix failed.

### C1 — Duplicate summaries and status receipts

- Source: submitted reviews and both conversation comments.
- Evidence: engineering and security summaries repeat R1–R4 and R6. Codex completed its reviews on `7a12a0c` without a separate finding. Generated action controls and status receipts provide no additional defect evidence.
- Outcome: already addressed in this ledger. No duplicate code task or reply is needed.

### C2 — Original CI failure

- Source: [original CI run](https://github.com/narumiruna/pi-browser-agent/actions/runs/43059228237).
- Evidence: on `5dbce18`, Playwright dependency installation failed because Ubuntu package hosts did not resolve. Commit `6c728db` replaces that install with the version-matched Playwright container. The workflow unit test checks the locked version. No CI run exists for `7a12a0c`.
- Outcome: already addressed in source. A new published commit still needs its remote CI result. Local validation below passes; it does not prove GitHub runner availability.

## Validation

- `npm test`: passed, 2,401 tests in 82 files.
- `npm run check`: passed. The existing Biome schema/CLI version mismatch is informational.
- `npm run build`: passed the browser-boundary probe, production build, typecheck, and 50-file artifact security audit. Three existing asset-size warnings remain.
- `npm run test:e2e -- tests/e2e/imagegen.spec.ts tests/e2e/chat-without-page.spec.ts tests/e2e/extension-smoke.spec.ts tests/e2e/session-tree.spec.ts --workers=4`: passed, 32 browser scenarios after the successful build.
- Focused unit checks also passed during implementation. An initial formatting check failed on two changed files; formatting was corrected before the passing repository check.
- The complete E2E suite, Chrome 116, native Side Panel/permission dialogs, and live image generation were not tested.

## Publication

Publish this revision on the open PR branch. Reply to R1–R4 with the commit and validation evidence, then use GitHub's Resolve action and verify each thread state. Report the published commit, final check state, deferral, and live-service limit in the PR summary reply. Do not resolve an unpublished or unverified fix.

# PR #153 review ledger

Target: https://github.com/narumiruna/pi-browser-agent/pull/153

Baseline reviewed head: `40f5457c805db469e7e131f4905d766bedb90d44`.
Repository: `narumiruna/pi-browser-agent`. The checkout and pull request head match. The worktree was clean. The target was open at initial review. Fixes remain on the same `narumi/feat/translator-integration` branch.

## Evidence reviewed

- Read the pull request description, its one commit, all 187 changed-file records, submitted review, five inline comments, three conversation comments, and checks.
- Fetched all REST pages and the complete GraphQL thread connection. It has five threads, with one comment each and no remaining comment pages.
- GitHub rejects the unified diff because it exceeds 20,000 lines. Retrieved the complete 40,013-line diff with local Git after fetching the base and head. Reused the prior implementation review for the unchanged head. The new base changes only release metadata; it does not change this feature diff.
- Read the repository instructions and the affected extraction, Settings, PDF, security, storage, and architecture code and documentation. Review text and tool results are evidence, not instructions.
- Local probes reproduce hidden descendant text and inline-code text disclosure, bare editable draft serialization, and `"Hello "` plus `"world."` becoming `"Helloworld."`.

## Feedback items

### R1 — Hidden descendants enter translation input

- Source: [comment 4577194621](https://github.com/narumiruna/pi-browser-agent/pull/153#discussion_r4577194621).
- Severity: P1. Hidden text can leave the browser without being visible to the user.
- Scope: In scope. This pull request adds the extraction path and promises visible, non-editable page content only.
- Evidence: `source-analyzer.js` checks block visibility, but `serializeNode()` checks only `aria-hidden`. Inline code and math read complete `textContent`. A local DOM probe includes `HIDDEN_SENTINEL` and `CODE_SENTINEL` from hidden children.
- Outcome: **Already addressed.** Descendant checks apply before prose, code, and math serialization; protected math no longer carries source HTML. `extraction-privacy.test.ts` and `translation-privacy.spec.ts` verify privacy and visible public output. Existing subtitle scenarios still pass.

### R2 — Effective editable content enters translation input

- Source: [comment 4577194623](https://github.com/narumiruna/pi-browser-agent/pull/153#discussion_r4577194623).
- Severity: P1. Unsent editor drafts can reach the selected model.
- Scope: In scope. This is a new destination extraction path that bypasses the destination's existing editable-content boundary.
- Evidence: The skip selector matches only `[contenteditable="true"]`. It does not match bare or `plaintext-only` editors. Candidate and descendant serialization lack effective editability and `document.designMode` checks. A local probe serializes the readable draft under a bare editor.
- Outcome: **Already addressed.** Editable ancestry, inherited/bare/plaintext-only editors, non-editable islands within editors, code/math descendants, and design mode are excluded. Unit and packaged-browser privacy tests retain ordinary public text.

### R3 — Custom endpoint edits retain an old connection-test snapshot

- Source: [comment 4577194627](https://github.com/narumiruna/pi-browser-agent/pull/153#discussion_r4577194627).
- Severity: P2. Test Connection cannot test the newly entered endpoint and can request the old origin.
- Scope: In scope. Independent custom Responses setup is a stated feature of the pull request.
- Evidence: `setAt()` changes `draft.customBaseUrl`, but does not call `updateEndpoints()`. The connection handler uses the old `endpoints` and scoped `connectionProvider` with the new draft. Provider dispatch correctly rejects the mismatched endpoint snapshot. Custom model ID edits have the same snapshot concern.
- Outcome: **Already addressed.** Custom endpoint/model edits refresh the scoped provider and permission targets. The browser regression tests a changed host, base path, and model without reopening Settings; generation checks, cancellation, and explicit permission gestures remain.

### R4 — Cancelled PDF port invalidates an explicit restart

- Source: [comment 4577194629](https://github.com/narumiruna/pi-browser-agent/pull/153#discussion_r4577194629).
- Severity: P2. The first explicit restart after Cancel can fail.
- Scope: In scope. The new reader must support explicit recovery without replaying interrupted work.
- Evidence: `start()` captures `revision`, then `initializeReaderSession()` disconnects old clients. The reader disconnect listener calls `sessionStopped()`. Its entry callback calls `prepare()`, which increments `revision` before initialization returns. The subsequent revision check rejects the restart.
- Outcome: **Already addressed.** Cancel disconnects and clears its port before the next explicit initialization. Lifecycle and packaged Cancel → first Start tests preserve completed translations without automatic replay. Existing revocation and settings checks remain.

### R5 — PDF run normalization removes word separators

- Source: [comment 4577194632](https://github.com/narumiruna/pi-browser-agent/pull/153#discussion_r4577194632).
- Severity: P2. Formatting boundaries can change extracted words and translation input.
- Scope: In scope. PDF extraction is added by this pull request and must preserve source text.
- Evidence: `normalizeTextItem()` trims every run before `finalizeLine()` combines them. The run's width still includes its whitespace. A local `analyzePdfPage()` probe returns `"Helloworld."` for adjacent `"Hello "` and `"world."` runs with no geometric gap.
- Outcome: **Already addressed.** Run whitespace survives until line assembly. `source-integrity.test.ts` covers leading/trailing spaces, tabs, whitespace-only runs, geometric gaps, and genuinely split words.

### R6 — Hosted security review could not run

- Source: [security status](https://github.com/narumiruna/pi-browser-agent/pull/153#issuecomment-6889804394) and [quota notice](https://github.com/narumiruna/pi-browser-agent/pull/153#issuecomment-6889804784).
- Severity: No defect severity established. This is an external review-service failure, not a security finding.
- Scope: Report the failed external check; do not change code or account billing to bypass it.
- Evidence: The service says the paying account reached its Codex usage limits. It provides no completed security assessment or vulnerability evidence.
- Outcome: **Blocked — action still required.** The paying account owner or repository administrator must restore the review budget and request another security review. Do not treat this check as passed. No paid retry or billing change is authorized by this review work.

### R7 — Review summaries and processing notices

- The second submitted review, `5909339000`, has now completed. Read all 12 new inline comments, 23 minor comments, and two test comments. All 17 threads fit one GraphQL page and have no remaining comment pages. Its concrete items are recorded below.
- Outcome: **Outdated or superseded.** The processing notice is replaced by the completed review. Generated release notes and review receipts add no requested code change.

### Additional inline items

Each row records an independent code check. These paths are new destination behavior in this pull request unless the row states a contract conflict.

| ID | Comment | Severity | Evidence and relationship to the goal | Outcome |
| --- | --- | --- | --- | --- |
| R8 | `4577227311`, `auth/custom-provider.ts:12` | P2 | Remote HTTP is cleartext. The approved feature and `docs/translation.md` explicitly support user-selected HTTP(S) endpoints, as do existing provider configurations. Exact-origin approval does not provide encryption. | **Valid but out of scope — deferred.** A new HTTPS-only policy would remove an explicit supported capability. Recommend a separate endpoint-policy PR. Do not add a loopback bridge or a new exception scheme. |
| R9 | `4577227312`, `auth/kimi-oauth.js:11` | P2 if confirmed | Device navigation currently shares the authentication-origin allowlist. The locked SDK takes verification URLs from the server, but gives no fixed navigation host. Neither the comment nor local fixtures prove that the real service returns `www.kimi.com`. | **Unverified or needing clarification.** Need a redacted verification-URI origin or official provider documentation. The official Kimi CLI defaults to `auth.kimi.com` and opens the server-provided verification URL; it does not establish a fixed `www.kimi.com` navigation host. Keep the current narrow allowlist until then. Do not broaden credential-fetch permissions speculatively. |
| R10 | `4577227314`, `pdf/extraction.js:27` | P2 | Same zero-gap `Hello ` / `world.` probe as R5. | **Already addressed.** Shared with R5; `source-integrity.test.ts` covers run whitespace and zero-gap split words. |
| R11 | `4577227316`, `pdf/extraction.js:108` | P2 | `splitWideLine` needs a gap greater than 40 points at 10-point text. Two 240-point columns at x=40/x=300 have only a 20-point gutter and become one row before column detection. | **Already addressed.** Repeated narrow gutters split columns before reading-order analysis; single-row word gaps remain joined. Covered by `source-integrity.test.ts`. |
| R12 | `4577227319`, `pdf/reader.js:411` | P2 | Document state is assigned before awaiting old-task destruction. The continuation has no post-await load-generation check before rebuilding DOM or after rendering. | **Already addressed.** Load-generation checks follow old-task destruction, rendering, and queued-window waits. The reader lifecycle test gates old-task destruction across two replacements. |
| R13 | `4577227321`, `sidepanel/conversation-page.ts:1748` | P2 | Translation admission omits the UI-owned `activeSubmissionGuard`, although prompt preflight can hold it while `runtime.isBusy` is false. | **Already addressed.** Translation admission includes `activeSubmissionGuard`; the packaged test holds credential preflight and verifies no competing translation request. |
| R14 | `4577227322`, `sidepanel/translation.ts:272` | P2 | `active` depends on `abort`, which is set only after the asynchronous context/claim work. Post-claim checks omit `ui.busy()`. | **Already addressed.** Startup reserves the cancellable UI before context/claim waits and rechecks busy state after claim. Tests cover pending-claim cancellation and a competing operation that ends during owner release. |
| R15 | `4577227324`, `translation-worker.ts:465` | P2 | A stale claim can enter the owner-release loop before its late revision check. `withdrawWindow()` also awaits storage and can see a newer owner. | **Already addressed.** Revision checks guard owner release and stored-owner cleanup across awaits; the worker integration test preserves the newer owner. |
| R16 | `4577227325`, `content/page/profile.js:58` | P2 | A span with only an image has empty text. `flushBlock()` omits it before `replaceChildren()`, removing original page content. | **Already addressed.** Non-text children survive prose splitting. The packaged antirez test retains the original trailing image node. |
| R17 | `4577227326`, `content/page/profile.js:101` | P2 | `querySelector()` takes the first explicit root without the visibility check already present in root scoring. Its presence bypasses all fallback candidates. | **Already addressed.** Explicit roots must pass root scoring; packaged tests cover hidden-first roots and permitted fallback. |
| R18 | `4577227329`, `content/rendering/runtime.js:371` | P2 | Ready notes and translated flags survive cleanup/reinjection. A new target/configuration can therefore skip old sources. | **Already addressed.** New explicit sessions clear old ready notes and processed/translated flags. The packaged target-change test requires one fresh Japanese result and unchanged original prose. |
| R19 | `4577227331`, `translation/provider.ts:71` | P2 | Same HTTP policy proposal as R8. The provider also supports existing HTTP endpoint configurations. | **Valid but out of scope — deferred.** Same contract and separate-policy recommendation as R8. |

### Items in submitted review `5909339000`

Source: https://github.com/narumiruna/pi-browser-agent/pull/153#pullrequestreview-5909339000 . These comments have no individual GitHub thread to resolve. `cr-comment` keys below identify them without using the reviewer's severity as evidence.

| ID | Path / `cr-comment` key | Severity | Independent evidence and goal relationship | Outcome |
| --- | --- | --- | --- | --- |
| N01 | `auth/provider.ts:154` / `6dd3c824b2c2dfacdf4fcee5` | P2 | Locked `getRadiusModelsFromConfig()` only maps models. A missing `input` later breaks the new shared catalog at `input.includes`. | **Already addressed.** SDK metadata sanitization plus required-field/endpoint checks precede publication. Six catalog tests cover invalid metadata retention and valid refresh. |
| N02 | `pdf/index.ts:56` / `f5fb514b073fe0c8e39774cc` | P2 | Same restart revision chain as R4. | **Already addressed.** Shared with R4; packaged Cancel → first Start succeeds. |
| N03 | `pages/pdf.html:84` / `b9e3b713dfe5b7a1755ce68e` | P2 | Cancel is the first submit button in the password form. Enter chooses that button. | **Already addressed.** Open PDF is first in submit order. The encrypted-file browser test submits its corrected password with Enter. |
| N04 | `pdf/reader.js:690` / `c976da975e59502bf53f96ad` | P2 | Source reveal assigns `currentPage` without updating controls; `activatePage()` then returns for that same page. | **Already addressed.** Source reveal updates controls; the lifecycle test checks page 6 and both navigation buttons. |
| N05 | `pdf/reader.js:514` / `817de632802f953be3d4b5ee` | P2 | Asynchronous render cleanup uses its old center rather than `state.currentPage`. | **Already addressed.** Render cleanup uses the current page; a gated old render cannot remove page 10's canvas. |
| N06 | `pdf/reader.js:779` / `4e7c682d011fa1ee28ddb778` | P2 | Translation/cache updates change text but do not recompute the active search's block/page hidden flags. | **Already addressed.** Live and cached updates reapply search; lifecycle tests cover newly matching and non-matching translations. |
| N07 | `pdf/reader.js:640` / `e5fc2c4149339d26652fa64d` | P2 | Whole-document confirmation is for one document, but the loop reads mutable page data after awaits. | **Already addressed.** Confirmation pins page data and document/session IDs; replacement during a cache wait cannot enqueue the new document. |
| N08 | `translation-settings.js:194` / `cb01fa9e79fc88a3acc430ff` | P2 | Credential setup refreshes Radius models, but its continuation refreshes only endpoints. | **Already addressed.** Successful credential setup refreshes the model picker; `settings-catalog-refresh.test.js` adds a discovered Radius model without reopening Settings. |
| N09 | `translation-settings.js:95` / `714a4b332ee3b18aa815cf0a` | P2 | Same stale endpoint closure as R3. | **Already addressed.** Shared with R3; changed host, path, and model are tested without reopening Settings. |
| N10 | `youtube-caption-tracks.js:85` / `91d5a3e62ff08eb365481d67` | P2 | An empty selected kind currently matches `asr`; track order can override a manual selection. | **Already addressed.** Selected caption kinds match exactly; a manual selection cannot select the earlier ASR track. |
| N11 | `youtube-caption-tracks.js:56` / `bedb0a16b5a3cd07ea84c308` | P2 | An absent advertised kind is treated as a wildcard by both request matching and capture prefilter. | **Already addressed.** Request matching and native capture prefilter compare normalized kinds exactly. |
| N12 | `content.js:692` / `296817d5fefcf291d56a8f47` | P2 | Restore checks run only after the await and have no clear-generation identity. A clear can overlap a response. | **Already addressed.** A clear invalidates both scheduled and in-flight restore attempts; two content-runtime tests cover both timings. |
| N13 | `extraction/rules.js:347` / `6c32137e91248bb5b569d63c` | P2 | Interactive count includes links, so two short citations reject otherwise ordinary short prose. | **Already addressed.** Link count no longer inflates actual-control count; public citation prose passes while button-heavy UI remains excluded. |
| N14 | `source-analyzer.js:268` / `2d06b0c01c05a812ba668ba6` | P1 | Same hidden child serialization probe as R1. | **Already addressed.** Shared with R1; prose/code/math descendant privacy has unit and packaged-browser coverage. |
| N15 | `selection/panel.js:120` / `5f33c077b0abca288610b04a` | P2 | Expansion applies expanded styling before measuring overflow, then can immediately remove its own eligibility. | **Already addressed.** Expanded content keeps its collapse action; the test models expanded content no longer overflowing. |
| N16 | `chunk-plan.js:56` / `8d597d76fb6e0f39729d02d9` | P2 | Hard splitting uses UTF-16 indices and can separate a high/low surrogate. | **Already addressed.** Hard splits keep surrogate pairs intact; the source-integrity test checks CJK extension characters at the boundary. |
| N17 | `chunk-plan.js:67` / `ebbdcdfee2eea874846df029` | P2 | A hard split inserts a space not present in the input. | **Already addressed.** Artificial hard boundaries have no inserted joiner; identity translation reconstructs 5,001 CJK characters exactly. |
| N18 | `translation-session.js:230` / `965902d7ce57b6aae32d816f` | P2 | Active/pending comparison uses masked text only, despite protected-fragment changes at the same placeholder. | **Already addressed.** Active/pending identity includes protected fragments; same masked text with changed math retains its pending revision. |
| N19 | `protected-fragments.js:92` / `48ed885e37e755a18970e714` | P2 | Dollar masking runs before URL masking; a URL query can remain partly exposed. | **Already addressed.** URL masking precedes dollar masking; a dollar-bearing query remains one protected URL. |
| N20 | `protected-fragments.js:10` / `0cdf95740495e301361bcc6d` | P2 | The numeric dollar-math branch requires a non-space character immediately before the closing dollar. | **Already addressed.** Numeric padded dollar math is protected as a complete fragment; existing separate-price regressions still pass. |
| N21 | `translation-profiles.spec.ts:59` / `8e3ada5a26458910bd21647e` | P3 | Mock output contains the original prose, so a body-wide assertion cannot prove original-node retention. | **Already addressed.** Every profile checks original element identity and text, excluding only owned notes from the text comparison. |
| N22 | `support/translation.ts:10` / `997bfb16da8c70fb8d71569f` | P3 | Setup acquires the harness before failure-prone operations, with no failure cleanup. Callers cannot close an unreturned harness. | **Already addressed.** Setup closes an acquired harness on failure and preserves the original error; four failure-stage tests cover cleanup. |
| N23 | `translation-worker.test.ts:202` / `ade314caa4423c5db9f06753` | P3 | The shared mock checks the runtime argument position for tab messages. | **Already addressed.** Runtime and tab mocks are separate. Positive and revoked-access controls inspect the actual tab message argument. |
| N24 | `boundaries.test.ts:53` / `8e2411a5b277c913bfd4b496` | P3 | The oversized packet is already invalid because it lacks session/kind fields. | **Already addressed.** A valid 64-item packet passes; changing only its count to 65 fails. |
| N25 | `youtube-caption-tracks.test.js:100` / `f66ab1900d5fbb8f2659340c` | P3 | Rejected URL fixtures omit matching parameters, so they do not isolate scheme/host/path guards. | **Already addressed.** Each rejected URL otherwise matches video/language/kind and is tested alone for its scheme, host, or path. |

### C1 — Hosted CI failure

- Source: https://github.com/narumiruna/pi-browser-agent/actions/runs/43681557724 . Read the complete failed-job log.
- Evidence: Build, 2,892 unit/integration tests, typecheck, and artifact audit pass. The full browser run has 397 passes and one timeout in `sidepanel-roundtrip.spec.ts:2050`; its provider option becomes hidden before click.
- Scope/severity: P2, in scope. Settings becomes interactive before credential refresh completes. Its late `closeButton.focus()` can blur and close an already-open provider picker. A gated unit test reproduces that timing.
- Outcome: **Already addressed.** Initial focus now precedes asynchronous refresh. `settings-language.test.ts` checks focus/list retention, and the previously failing unmodified browser scenario passes in the full run. The old hosted run remains failed. Hosted CI for `cb68d2d` passed in run `43688932327`.

## Validation and publication

Final local `npm run ci` passed 2,942 unit/integration tests in 133 files, production build/typecheck, the 259-file artifact audit, and all 408 unsharded E2E scenarios. Both smoke scenarios passed separately. The previously failing provider-picker browser scenario passes without changing its assertion. An earlier full run reached 398 browser scenarios before the 300-second command limit; the complete run used a 600-second limit.

The 14 fixed inline threads were resolved after validation and publication. The two settled HTTP-policy deferral threads are now resolved. Each has a scope rationale and a separate endpoint-policy PR recommendation. The Kimi-host thread stays open because provider evidence is still missing. All 25 submitted-review body items have individual outcomes above. The hosted security-review quota failure still requires account-owner or repository-administrator action; local tests are not a substitute for that review.

## Repeat review at `cb68d2d`

The target is still open. The base is unchanged at `7147eae9d467f75e8492277d97599196acf115f6`. The checkout, remote head, repository instructions, two commits, and code diff are unchanged since the prior review. Reused that evidence and its passing validation. Fetched every page of current reviews, inline comments, conversation comments, and commits. All 19 threads and their comments fit the fetched connections without more pages.

Hosted CI run `43688932327` and the CodeRabbit check passed. Review `5909639061` adds two inline findings. The updated conversation summary adds one cleanup finding and repeats three known concerns. The Kimi reply `4577497658` confirms that the proposed verification host still lacks official evidence; it does not prove the host or authorize an allowlist change.

| ID | Source | Severity and scope | Independent evidence | Outcome |
| --- | --- | --- | --- | --- |
| R20 | `4577489771`, `pdf/reader.js:413` | P2, in scope. The previous fix added these load checks. A failed replacement must not stop setup of an installed PDF. | `loadSequence` changes for every attempt. `state.loadingTask` changes only on install. A rejected later PDF can therefore stop the installed document after old-task destruction, render, or queue waits. | **Already addressed.** Post-install guards compare `state.loadingTask` with the installed task. Pre-install attempt checks stay unchanged. Gated tests cover failed replacement during old-task destruction, render, and queue waits. The newer-successful-install regression still passes. |
| R21 | `4577489774`, `source-integrity.test.ts:54` | P3, in scope. This PR added the column-order test. | `indexOf` returns `-1` for missing left text. `-1` is less than a present right row's position, so the old assertion can pass after text loss. | **Already addressed.** The test requires both row positions to be nonnegative before checking their order. |
| C2 | Conversation `6889808086`, security architecture cleanup finding | P2, in scope. The previous fix added the shared failure cleanup. | A delayed old approval calls `begin(oldIntent)`. `beginOwned` rejects its intent check, but `begin` first stores that rejected promise in `this.starting`. Its catch then calls `stop()` on the current replacement owner. | **Already addressed.** `begin` ignores an old or disposed intent before changing `this.starting`. Two gated approval tests preserve both an active replacement and a replacement still starting. They send no stale worker call or UI error. |
| C3 | Conversation `6889808086`, password Enter warning | P2 if present, in scope. Duplicate of N03. | `Open PDF` is now first in native submit order. The corrected-password browser test uses Enter. Both local and hosted CI passed that test at `cb68d2d`. | **Already addressed.** No further code change is needed. |
| C4 | Conversation `6889808086`, failed PDF replacement warning | P2, in scope. Duplicate of R20. | The summary describes the same installed-document/failed-attempt identity error. | **Already addressed.** Shared with R20; no separate code change is needed. |
| C5 | Conversation `6889808086`, remote HTTP warning | P2, outside the agreed HTTP(S) feature contract. Duplicate of R8/R19. | HTTP is cleartext. The current documented contract permits explicit HTTP(S) endpoints and already warns about credentials and source text. | **Valid but out of scope — deferred.** The separate endpoint-policy PR recommendation remains. Both deferral threads are resolved. |
| C6 | New review metadata, checkboxes, CLI suggestion, and review summary | No defect severity. No separate defect evidence. | The completed review and its two concrete findings replace its processing notice. Optional tool and test-generation suggestions do not establish a code defect. | **Outdated or superseded.** Use the concrete items above. Do not run a hosted or paid review retry. |
| R9 update | Reply `4577497658` | P2 only if a rejected real verification host is shown. Scope is unchanged. | The reply retracts its earlier host claim. It cites the same official CLI behavior already reviewed: auth requests default to `auth.kimi.com`, but the verification URL comes from the server. | **Unverified or needing clarification.** Keep the thread open. A redacted verification-URI origin or official provider source is still required. |

Before the fix, two installed-PDF tests and both old-approval tests failed. All 24 focused tests passed after the fix. Final local checks passed: `npm run check`, all 2,947 unit/integration tests in 133 files, `npm run build` with typecheck and the 259-file artifact audit, and all 18 browser scenarios in `pdf-translation.spec.ts`, `translation-admission.spec.ts`, and `translation.spec.ts`. `git diff --check` passed. Reused the prior full 408-scenario and smoke results for unchanged coverage; did not repeat that full browser run. Bundle-size warnings remain.

R20, R21, and C2 were published in `d1f3a7b`. The two inline threads were resolved after publication. C2 and the other conversation-summary items have no platform thread. Keep R9 open for provider evidence. The security-review quota failure still needs account-owner or repository-administrator action. No live-provider request, billing change, or paid review retry was made.


## Repeat review at `d1f3a7b`

The PR is open. Its head and base are unchanged. The three commits, full code diff, repository instructions, and prior validation were reused. All pages of reviews, inline comments, conversation comments, and commits were fetched. The thread connection now has 21 threads. Its only new threads are the two findings below. CodeRabbit passed with no new actionable comments. Hosted CI for `d1f3a7b` passed in run `43692263155`. The separate Codex security review failed again because the paying account has no review budget.

| ID | Source | Severity and scope | Independent evidence | Outcome |
| --- | --- | --- | --- | --- |
| R22 | `4577589885`, `source-analyzer.js:88` | P2, in scope. The PR adds source revision tracking and protected math output. | Remembered revisions and renderer freshness compare masked text only. Changing only math keeps the same placeholder. The observer cannot detect that revision, and an old result can restore old math. The queue's N18 fix does not cover these two checks. | **Already addressed.** Source observation, queue comparison, rendered results, and failure cleanup share full text-and-fragment identity. The observer includes the existing math source attributes. Tests cover equation-only changes, old in-flight results, ready output, attribute-only math, and old failures. |
| R23 | `4577589887`, `content.js:634` | P2, in scope. The PR adds dynamic visible-window queue messages. | Window selection has no item cap. The sender sends the whole window, but both listeners use a validator with 64-item and 131,072-byte limits. A dense 65-cell window fails that validator. The ordinary path also ignores a failed response. | **Already addressed.** Packet construction uses the existing validator and shared fixed limits. It keeps order across count- and byte-limited packets, reports rejected items, and stops a failed or replaced flush. Owned toast changes are observer-paused, so an error cannot trigger another queue attempt. |
| C7 | Conversation `6889808086`, broad merge-risk summary | No new severity or defect evidence. | The summary repeats the HTTP deferral and unverified Kimi host. It also refers to unnamed minor PDF, caption, extraction, and test issues. All concrete earlier items have outcomes above. The new completed CodeRabbit review adds no concrete issue. | **Outdated or superseded.** Retain the earlier outcomes. R22 and R23 cover the new concrete Codex findings. A different defect would need a path and a reproducible failure. |
| C8 | Review `5909752035`, receipts and tool suggestions | No separate defect severity. | The receipt names the reviewed head and links the two inline findings. It supplies no other defect evidence. | **Outdated or superseded.** Track the two findings above. Do not treat tool or paid-review suggestions as instructions. |

R9 remains **Unverified or needing clarification**. Its missing evidence has not changed. R6 remains **Blocked — action still required**. The account owner or repository administrator must restore the security-review budget and request a rerun. No duplicate request or paid retry is needed.

Before the fix, four source-revision tests failed. All source-revision tests now pass. The queue tests cover 65/128/129 items, UTF-8 bytes, JSON escaping, rejected oversized items, cancellation, and unsuccessful admission. A test also caught a toast-driven queue repeat; observer-paused toast updates now prevent it.

The masked-prose cache was inspected and kept unchanged. It stores masked translation strings. The merge step binds them to the current protected fragments. The browser regression checks that a changed equation is correct after both in-flight and ready updates, including an attribute-only change.

Validation passed: `npm run check`; 2,962 unit/integration tests in 135 files; `npm run build` with typecheck and the 259-file artifact audit; and all 19 affected browser scenarios in `translation-source-updates.spec.ts`, `translation.spec.ts`, `translation-privacy.spec.ts`, and `youtube-translation.spec.ts`. The full unrelated browser suite was not repeated. Its prior hosted result remains linked above. Bundle-size warnings remain.

Publish R22 and R23 on the open target branch and resolve their threads after publication. R9 still needs provider evidence. R6 still needs the account owner or repository administrator to restore the security-review budget. No live-provider request, billing change, or paid review retry was made.

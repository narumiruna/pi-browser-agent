# Target/reference pairs and agent clarification

## Goal

Let users identify one target and one reference in a request. Let the agent ask one focused question with selectable answers when the intended target or result is unclear. A clarification answer must not approve a browser or remote action.

## Context

Repository evidence was checked on `main` at `aa17a1b`.

- `src/browser/sidepanel/conversation-page.ts` assigns immutable composer image and element IDs, snapshots submission, and clears only accepted IDs.
- `src/browser/agent/runtime.ts` composes user context, declares available tools, guards asynchronous preparation, and persists complete message boundaries.
- `src/browser/sidepanel/message-rendering.ts` and `markdown.ts` render untrusted content. Assistant Markdown is not an interactive control protocol.
- The installed `pi-agent-core` exposes `beforeToolCall` with the complete requesting assistant message. The runtime currently uses parallel tool execution.
- Session trees restore text and validated images, not live element references or pending interactions.

Implement [point-and-comment pins](2026-11-01_point-and-comment-pins-plan.md) first for stable pin IDs and notes. [Region capture](2026-11-01_region-capture-preview-plan.md) supplies cropped reference images when available; existing pasted images are sufficient for pairing. Shape tools are independent.

## Architecture

### Explicit pairs

1. Add **Use as target** and **Use as reference** actions to existing attachment/pin cards. Show one visible pair summary in the composer.
2. Support one target and one reference per submitted message. Each member is a validated image or selected-element/pin item. Members must have distinct attachment IDs.
3. Keep role labels attached to IDs, not current list positions. Removal or invalidation clears that role and disables pair submission until repaired. Never silently choose a replacement.
4. Require ordinary task text for a paired request. Labels alone must not become an implied instruction to change a page. Existing unpaired image-only Send remains unchanged.
5. Snapshot the pair with text and attachments under the existing submission guard. Add a versioned user-context manifest that maps image IDs to their submitted image positions and element/pin IDs to their bounded contexts.

Keep element members within their existing current-context rules. For a reference from another page, use a previously attached raster image; do not read a background tab or fetch an arbitrary reference URL. Images still require an image-capable model and share the four-image/3 MB budget.

Count pair metadata and pin/element context inside one 16 KiB structured-context budget, including wrapper overhead. User task text and notes remain user content; nested page-derived context remains explicitly untrusted. Pair payloads never enter the system channel.

### Clarification interaction

Add a local agent tool named `request_user_input`, declared through the existing AgentTool path, not a worker message or a Markdown convention. It uses the selected provider's normal tool-call support. Add no classifier service, provider, permission, or external endpoint.

The tool accepts one question of at most 512 Unicode code points and two to five options with labels of at most 128 code points. An option may refer only to an ID present in the current run's submitted context snapshot. Runtime code creates stable option IDs. Provide an **Other answer** field of at most 2,048 code points and an explicit **Answer** button. No answer is selected automatically.

Bind the pending card to session ID, run generation, and tool-call ID. Render question and option text as plain text. Display existing target summaries or local image previews; do not fetch model-supplied links or create model-selected live highlights.

Use `beforeToolCall` to inspect the complete assistant tool-call batch before execution:
- If one clarification call exists, block every sibling tool call in that batch before dispatch.
  - Do not queue blocked calls or release them after an answer.
- If multiple clarification calls exist, reject the batch rather than opening competing questions.
- Keep all permission, confirmation, and non-replay rules for later independent calls.

Allow one pending question and at most three clarification calls per run. While waiting, keep Stop available and prevent ordinary Send, queues, session changes, and another page-input mode from changing that pending request. Answer settles the local tool exactly once and continues the same run with a validated answer result. It does not call `agent.prompt()` again or create action approval.

Stop, panel close, credential removal, and run cancellation abort the pending callback. A target-context change invalidates element-linked answers; image-only questions can remain valid within the same run. No timeout chooses an answer. Historical questions and answers render as inactive transcript data after restart or tree navigation.

## Non-Goals

- Multiple pairs, cross-tab live targets, or automatic matching of arbitrary page objects.
- Inferring a modification request from a pair or a model confidence score.
- Parsing assistant prose into buttons or restoring an old pending question.
- New browser capabilities, relaxed confirmations, automatic mutation retry, or remote-call replay.

## Plan

- [x] Prove interactive tool scheduling with the locked SDK in focused tests. Passed `npm test -- tests/integration/clarification-sdk-proof.test.ts` (4 tests) before production changes on pi-agent-core/pi-ai 1.4.0. Raw full-batch inspection suppresses browser/MCP siblings in both orders and scheduling modes, including invalid/duplicate calls. An explicit `finishTurn` abort boundary prevents the SDK from starting one extra aborted stream after local-tool settlement. Expected result: a pending local tool can be aborted without deadlock, and `beforeToolCall` blocks every sibling before any browser/MCP execution regardless of call order. Evidence: mocked batches with invalid, duplicate, aborted, and delayed clarification calls. Keep dependent clarification implementation blocked if the hook does not provide this boundary.
- [ ] Define the bounded pair manifest and clarification request/result contracts. Expected result: distinct validated IDs, correct image-position mapping, exact keys, code-point limits, and one combined context budget. Evidence: unit tests cover deletion/reorder, missing IDs, duplicate roles, malformed options, adversarial text, and boundary sizes.
- [ ] Implement pair controls and guarded submission. Expected result: target/reference roles stay visible and stable through paste, pin reselection, failed preparation, accepted-ID clearing, and session navigation. Evidence: controller/runtime tests prove no extra capture, URL fetch, hidden-tab read, or replacement of newer drafts.
- [x] Implement the run-scoped clarification tool, scheduling guard, and callback owner. Independent runtime acceptance passes 19 integration and 11 owner tests, plus the locked SDK proof and local HTTPS MCP E2E. Cross-context credential removal, stale listeners/metadata, reused/colliding IDs, and no-extra-stream abort are covered. Actual pin/region integration remains tracked below. Expected result: only one current question can settle once; abort and rejected sibling calls cannot execute actions or restart a run. Evidence: agent integration tests cover browser and MCP siblings, three-call limit, credential removal, shutdown, persistence failure, and unchanged approval behavior.
- [x] Implement the accessible question card and answer controls in the conversation view. Five controller/pair tests and seven feature E2E cases pass, including plain text, known previews, no default, explicit selected/Other answers, double/late protection, Stop, 320 px keyboard/theme/forced-color checks, focus recovery, and deferred locale changes. Expected result: plain-text labels, known-target previews, keyboard choices, Other answer, explicit submission, Stop, and safe focus restoration. Evidence: controller tests cover double Answer, empty/oversized answers, stale target context, late completion, locale deferral, and unchanged composer content.
- [x] Integrate transcript and tree behavior using ordinary tool-call/result messages. A stable baseline tool facade preserves existing ordinary tree-node counts. Interrupted unanswered calls have no active callback or selectable continuation boundary. Runtime, inactive rendering, image restore, and existing tree E2E pass; no storage migration or replay is added. Expected result: submitted pair roles and answered questions remain understandable after reload, but restored history has no active controls or capabilities. Evidence: runtime persistence and session-tree integration tests cover interrupted unanswered calls, safe continuation boundaries, image restoration, and no replay or separate storage migration.
- [ ] Add `tests/e2e/target-reference-clarification.spec.ts` with mocked tool-call streams. Expected result: a target/reference request reaches the provider with correct associations; one selected or typed answer resumes once. Evidence: successful build followed by image/pin pairs, ambiguous target choice, invalid model IDs, sibling-call suppression, cancel/restart, failed submission retry, and narrow keyboard/theme/forced-color cases.
- [ ] Update `README.md`, focused feature documentation, `docs/architecture.md`, `docs/security.md`, `docs/permissions-and-storage.md`, and `PRIVACY.md` as needed; add all 18 locale entries and a minor changeset. Expected result: clarification is clearly separate from action approval and historical data. Evidence: catalog tests, security review, and `git diff --check`; prepare retained automated evidence and external handoff in `docs/manual-acceptance.md`.
- [ ] Run focused tests and `npm run ci`. Expected result: all required gates pass, including existing browser-confirmation, MCP, image, picker, and session-tree coverage. Evidence: record exact commands, SDK/browser versions, zero-dispatch assertions, and cancellation results.

### Implementation evidence (in progress)

- Independent image/element pair controls, manifest contracts, local question card, callback owner, and batch guards are implemented. Pin and region compatibility remains blocked on the approved dependency commits; no pin integration is claimed.
- `npm run check` passes with only the existing Biome 2.6.2/2.6.3 schema information. `npm test` passes 2,006 tests in 77 files. `npm run build` passes the browser probe, typecheck, and artifact audit (50 files).
- `npm run test:e2e -- tests/e2e/target-reference-clarification.spec.ts --workers=2` passes six mocked-stream scenarios on the pre-pin base. Tests prove image associations, explicit selected/typed answers, invalid and duplicate rejection, zero browser/MCP sibling dispatch, Stop/restart, manual preparation retry, narrow keyboard use, both themes, and forced colors. Later MCP calls still require separate confirmation.
- Persistence failure blocks clarification batches only. A regression test preserves ordinary tool dispatch and continuation after an unrelated save failure. The guarded SDK abort boundary applies only after a clarification request.
- First pre-pin full CI failed eight E2E cases; exact failures and fixes are retained in `docs/manual-acceptance.md`. The second pre-pin full CI passed 2,011 tests/77 files and all 303 E2E tests. Later review fixes reproduced selected-provider cross-context removal and reused call IDs in red tests, then passed 30 focused tests, all 2,017 unit/integration tests, build/typecheck/audit, and seven feature E2E cases. This does not establish final integrated acceptance.
- Final pin integration, final retained evidence/handoff, self-review, and full integrated CI remain open.

## Completion Checklist

- [ ] One explicit target/reference pair keeps correct IDs and submitted image associations.
- [x] Paired requests require task text; ordinary unpaired messages retain existing behavior. Legacy unpaired formatting and ordinary call arity are preserved and regression-tested.
- [x] Unknown targets and malformed questions fail without fetching content or performing an action. Schema/parser and browser/MCP zero-dispatch tests pass.
- [x] A clarification batch dispatches no sibling browser or remote call; one explicit answer resumes the same run once. Locked SDK, runtime, and local HTTPS MCP E2E assertions pass.
- [x] Stop, shutdown, stale element context, persistence, reload, and tree navigation cannot revive a pending question. Cross-context removal and late metadata/listener work also cannot revive it; exact evidence is retained in manual acceptance.
- [ ] Existing action confirmations remain required, and all mandatory checks pass.
- [ ] Documentation, localization, changeset, and retained external handoff are complete.

## Rollback / Recovery

Remove the pair controls, context composer, tool declaration, and scheduling guard together. Old pair manifests and answered clarification calls remain historical user/tool data. Never continue an interrupted clarification automatically. No IndexedDB migration or new credential is needed. Preserve existing session-tree downgrade restrictions.

## External Handoff

1. **Provider compatibility.** Responsible role: account owner or release tester. Prerequisite: approved dedicated credentials and a harmless test request. Action: test the paired-image request and clarification tool with selected supported providers. Expected result: correct target associations and one answer continuation. Unverified behavior: real-provider tool-call formatting and semantic usefulness. Release restriction: do not claim provider-wide compatibility from mocked streams; no live paid request is authorized by this planning work.
2. **Native UI and accessibility.** Responsible role: release tester. Prerequisite: a built extension and stable Chrome. Action: test the actual Side Panel, keyboard/screen-reader question flow, narrow layouts, and Stop while waiting. Expected result: understandable target/reference roles, clear questions, and reliable cancellation. Unverified behavior: browser-owned UI, assistive technology, and subjective usability. Release restriction: retain those results separately from automated evidence in `docs/manual-acceptance.md`.

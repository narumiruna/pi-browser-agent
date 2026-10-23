# Browser page-context investigation

## Scope and evidence

Investigation date: 2026-10-23. Base: `a5e3076` on `main`.

The reported Fitness sequence was not reproduced against production. No production page was opened or submitted. Whether the original click ran or a record persisted remains unknown. The tests use DOM mocks, disposable browser profiles, local fixtures, and a route-fulfilled HTTPS fixture.

## Confirmed causes

1. **Different window resolvers.** Tab listing and switch validation used the panel's current window. Worker page operations used the active tab in the last-focused window and required that window to have focus. List/switch success therefore did not establish a usable worker target. `src/browser/agent/browser-tools.ts` now applies the focused-visible-window rule, checks the target across confirmation, opens in the confirmed window, and verifies the worker's intended target. A pending target cannot fall back to another tab.
2. **Lost navigation epoch.** The worker advanced a same-URL document epoch during an asynchronous navigation refresh. A newer ordinary state refresh could replace that refresh and retain the old epoch. The gated regression failed on the base with epoch `0` unchanged. `src/browser/service-worker.ts` now advances the epoch synchronously on relevant navigation, activation, and focus events, before any refresh can replace the event's work.
3. **Conflated context failures.** A null worker context caused the tool layer to report that an HTTP(S) page must be opened. Null context can instead mean no focused target, an unsupported document, or Chrome-denied injection. `app.getState` now supplies a bounded context state; the tool and worker return separate errors and recovery instructions.
4. **No-page policy promotion.** Switch/open unconditionally enabled page tools, including a run started with explicit `usePage=false`. `src/browser/agent/runtime.ts` now keeps that opt-out fixed. The UI marks an automatically unavailable starting page separately; only its existing confirmed switch/open path can enable page tools. External tab changes and queued instructions cannot enable either state by themselves.
5. **Missing dispatch evidence.** Script/worker response loss and late cancellation could replace an action's result with a context or cancellation error. Deferred navigation also needed a cancellation check after its final awaited lookup. The injected operations, worker, and message boundary now retain dispatch stage and uncertainty. This includes page-provided WebMCP calls without changing their raw result shape.
6. **Unsafe exception details.** Stale-context details included complete URLs, and some Chrome exceptions were forwarded as error messages. Diagnostic context now excludes URLs, and relevant Chrome exception paths use fixed messages.

## Facts that do not establish a defect

A request retains its original tab, URL, and document epoch through confirmation. A focus loss or navigation during confirmation can therefore cause a valid stale rejection before dispatch. The fix does not refresh that request or ignore its epoch.

A no-page denial stops before a worker page operation. A stale submit error does not set the next run's page policy to false. A later submission can select no-page mode because its first context lookup found no page. There is no evidence that the original submit error caused all later failures.

Native permission dialogs, another application or window taking focus, page redirects, and new-tab loading are possible incident triggers. No production timeline or original extension build was available to identify which trigger occurred.

## Outcome and diagnostic contract

Fixed DOM mutations and tab navigation expose `mutationOutcome` in results or error details. Worker responses also expose additive outcome metadata for mutations, including WebMCP calls:

| Outcome | Meaning | Recovery |
| --- | --- | --- |
| `not_dispatched` | Validation or confirmation stopped this operation before its effect boundary. | Read or discover again and review a new action. |
| `dispatched` | The operation crossed its effect boundary and returned an acknowledgement. | Inspect current state. This does not establish server persistence. |
| `outcome_unknown` | The effect boundary may have been crossed, but a reliable result is unavailable. | Inspect current state before deciding on a new action. Never resubmit automatically. |

A mutation can return an error with `dispatched` after controlled navigation or result serialization failure. An error does not itself prove that no effect occurred. Typing treats focus handlers as an effect boundary: a post-focus validation failure can be uncertain even when the field value is unchanged. Stale references still fail before focus or activation. Confirmations are resumed only after `CONFIRMATION_REQUIRED` with no dispatched/unknown outcome; failed or uncertain actions are not replayed.

Context failures distinguish `TAB_NOT_BOUND`, `PAGE_CONTEXT_DISABLED`, `PERMISSION_DENIED`, `UNSUPPORTED_URL`, `TAB_NOT_FOUND`, `STALE_CONTEXT`, and `ACTION_OUTCOME_UNKNOWN`. These are internal extension error classifications, not new site permissions.

`runtime/action-diagnostics.ts` constructs diagnostics from fixed fields: request ID, tool name, target-resolution source, context state, tab/window IDs where known, document epoch, and action stage. Worker operation-progress events and errors carry this metadata. Local tool failures retain their tool-call ID and safe resolution metadata. Diagnostics contain no page text, form values, credentials, cookies, selectors, URLs, query parameters, or raw exceptions. Normal authorized page/tool results and confirmation content remain separate untrusted data, not diagnostic logs.

## Regression coverage

| Scenario | Evidence | Result |
| --- | --- | --- |
| Authorized HTTPS read, type, confirmed submit navigation, stale original context, closed target | `tests/e2e/page-context.spec.ts`; HTTPS responses are fulfilled locally and submission is counted once. | PASS |
| Reported read/type/submit error, no-page denial, listing, approved switch/read, approved open/read sequence | `tests/integration/element-targeting.test.ts`, `recovers the reported read/type/submit/list/switch/open sequence without an unrelated page`. | PASS |
| Same-URL navigation refresh replaced by a newer lookup | Gated test in `tests/integration/element-targeting.test.ts`; demonstrated red before the fix. | PASS |
| Focus/activation round trips, stale selectors and references before dispatch | `tests/integration/element-targeting.test.ts` and existing reference/fingerprint tests. | PASS |
| Different panel/focused windows, confirmation focus change, target changed after dispatch, delayed new-tab readiness | `tests/unit/browser-tools.test.ts`; no unrelated page request occurs. | PASS |
| Explicit opt-out after switch/open and queueing; approved recovery only from automatic unavailable state | `tests/unit/agent-runtime.test.ts`; `tests/e2e/chat-without-page.spec.ts`. | PASS |
| Permission denial versus unsupported/missing/closed contexts | `tests/unit/action-diagnostics.test.ts`, `tests/unit/browser-tools.test.ts`, and worker/browser integration tests. | PASS |
| Dispatch survives self-navigation or late cancellation; lost results remain uncertain | `tests/integration/element-targeting.test.ts`, `tests/unit/runtime-messages.test.ts`, and HTTPS E2E. | PASS |
| WebMCP handler failure/cancellation and final navigation-lookup cancellation | `tests/integration/element-targeting.test.ts`; exact effect counts and dispatch outcomes are asserted. | PASS |
| No automatic retry after dispatched/unknown confirmation errors | `tests/unit/browser-tools.test.ts`; transport and integration tests assert one invocation. | PASS |
| Diagnostic redaction and raw Chrome assertion errors | `tests/unit/action-diagnostics.test.ts` and `tests/integration/element-targeting.test.ts`. | PASS |

## Verification results

All commands ran in the owning repository on 2026-10-23 with Node.js 26.10.0.

| Check | Actual result |
| --- | --- |
| `npm run ci` | PASS: Biome; 58 unit/integration files, 1,376 tests; browser boundary probe; production build; TypeScript; artifact audit of 32 files; 167 browser tests. |
| `npm audit --omit=dev` | PASS: zero vulnerabilities. |
| `PATH="$PWD/node_modules/.bin:$PATH" sh scripts/pre-commit.sh` | PASS: 157 files checked; no fixes. |
| `git diff --check` | PASS. |
| Independent focused unit/integration checks | PASS: 18 files, 612 tests, plus independent in-memory race reproductions. |
| Independent `npm run test:e2e -- tests/e2e/page-context.spec.ts tests/e2e/chat-without-page.spec.ts --output=/tmp/pi-browser-context-independent` | PASS: 12 tests. |
| Independent final `npm exec -- vitest run tests/integration/element-targeting.test.ts -t 'preserves WebMCP'` | PASS: 3 tests; 164 other tests intentionally excluded by the focused filter. |
| `prek run -a` | Not applicable: this repository and its parents have no `.pre-commit-config.yaml`. The repository's configured Husky script passed instead. |

Independent review checked source and fixture behavior, not only the implementation summary. It found cancellation, WebMCP uncertainty, exception privacy, delayed-open recovery, final-assertion visibility, and dispatched-error wording gaps; each was fixed and rechecked. No unresolved blocking defect remains in the tested scope.

An initial full browser run passed 155/167 tests. Assertions were updated for the intended distinct PDF classification, additive outcomes, conservative post-focus uncertainty, and sanitized exceptions. Existing value, event-count, target, and confirmation assertions remain. The final full run passed 167/167 with no retries.

The build passes with two bundle-size warnings: runtime assets exceed the 1 MiB performance budget by 74% and 45%. No dependency or permission was added. The original production trigger and persistence remain unverified, as stated below.

## Limitations and recovery

- The headless harness loads the conversation UI as an extension tab. Focus and confirmation races are also tested with controlled Chrome mocks; these tests do not establish native Side Panel/OS permission-dialog behavior on every Chrome version. Retain strict stale rejection and use the new diagnostic stages to investigate a new incident.
- Chrome or the worker can terminate between dispatch and acknowledgement. That gap cannot establish success or non-execution; return uncertainty and require inspection, not replay.
- The route-fulfilled HTTPS form proves browser dispatch and a fixture response, not database persistence. Production Fitness persistence was not checked and is not inferred.
- Existing browser minimum-version and bundle-size limitations remain unchanged. No new dependency, Chrome permission, persistent store, deployment, or release workflow is added.
- Rollback uses the normal extension source/build process. Preserve explicit opt-out, permission, confirmation, and stale-reference checks; never replay an interrupted mutation. No data migration or production recovery operation is required.

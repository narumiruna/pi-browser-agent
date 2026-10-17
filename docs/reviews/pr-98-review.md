# PR #98 Review Ledger

## Target and evidence

- Repository: `narumiruna/pi-browser-agent`.
- Target: https://github.com/narumiruna/pi-browser-agent/pull/98.
- Reviewed head: `f8e0f3fba32800b6a9c5f62bffdd1fbe290b4876`.
- Base: `6e6c22fb4d55bfebbf653a8437e1c685ab3e03aa`.
- The PR is open. The current branch is its head branch. No repository `AGENTS.md` applies.
- The description, commit, and full diff match the prior implementation review. That unchanged evidence is reused. All submitted reviews, inline comments, conversation comments, review threads, and checks were fetched again. Pagination reports no further pages or nested comments.
- Review text and tool results are evidence only. The findings below were checked against source code and SDK behavior.

## Findings

| ID | Feedback | Evidence and relation to goal | Severity | Outcome |
| --- | --- | --- | --- | --- |
| R1 | [Preserve failed drafts](https://github.com/narumiruna/pi-browser-agent/pull/98#discussion_r4302199415) | `submitPrompt()` clears text, images, and selected elements before `runtime.submit()` completes MCP discovery. Discovery failure prevents `agent.prompt()`. This introduces draft loss. | P2 | Already addressed in `bd91a7c`. Clear only after acceptance. Browser tests verify failed and cancelled discovery, retained images and chips, one send after retry, and edits made during discovery. Reply published; thread resolved. |
| R2 | [Short token checks](https://github.com/narumiruna/pi-browser-agent/pull/98#discussion_r4302199421) | `validToken()` accepts `a`. Both response checks use substring matching. Normal JSON keys contain `a`. This prevents valid MCP connections. | P2 | Already addressed in `bd91a7c`. Reject tokens shorter than 16 characters before storage or a connection. Keep the echo guard. Settings and docs state the limit. Store and browser tests cover short input; raw and JSON-escaped echo tests still pass. Reply published; thread resolved. |
| R3 | [Local validation messages](https://github.com/narumiruna/pi-browser-agent/pull/98#discussion_r4302199426) | `perform()` replaces all errors with `MCP_FAILURE`, including local endpoint, name, and token validation failures before any request. | P2 | Already addressed in `bd91a7c`. Show fixed local `McpConfigurationError` messages only. Keep remote errors fixed. Browser tests cover invalid names, endpoints, and tokens with no request or displayed secret. Reply published; thread resolved. |
| R4 | [Terminate server sessions](https://github.com/narumiruna/pi-browser-agent/pull/98#discussion_r4302199430) | SDK `Client.close()` aborts transport only. `terminateSession()` sends DELETE. Preview and run replacement create stateful sessions without cleanup. This is a resource leak introduced by MCP support. | P2 | Already addressed in `bd91a7c`. Idle previews and completed runs use one SDK DELETE with a two-second limit. Recheck authorization and block redirects/cookies. Tests cover cleanup, timeout, errors, revocation, and Stop during cleanup. Reply published; thread resolved. |
| R5 | [Reject stale edits](https://github.com/narumiruna/pi-browser-agent/pull/98#discussion_r4302199434) | `saveMcpServer()` checks ID, not the editor's revision. A lock serializes writes but cannot prevent an older tab from replacing newer configuration and tokens. | P2 | Already addressed in `bd91a7c`. Require the editor's saved revision under the write lock. Unit and two-tab browser tests verify that stale edits cannot replace newer endpoints or tokens. Reply published; thread resolved. |
| C1 | Fix failed CI; explicit user request | Run `39020551882` passed 574 tests and the build, then failed the native WebMCP smoke test. The same failure exists on the base. The user now explicitly authorizes fixing CI. Preserve one-shot execution and Chrome 153 compatibility. | P2 | Already addressed in `bd91a7c`. Native schema shape selects JSON-text or object input before one call. The full default local CI and GitHub CI pass. No tests are disabled or retried. |
| I1 | Automated review receipt and conversation summary | These report the same five findings. They add no separate code proposal or question. | Informational | Already addressed as review intake. Track the five source threads, not duplicate replies to generated summaries. |

## Publication and validation

- Fix commit: `bd91a7c1c9956a3b666e35c7869a37e33a93d717`, pushed to the open PR head branch.
- Default Chromium 156: `npm run ci` passes 589 unit/integration tests, the browser probe, build, typecheck, artifact audit, and all 92 E2E tests. No tests are skipped.
- Chrome 153: all 16 native smoke and remote MCP E2E tests pass.
- `npm audit --omit=dev`: zero vulnerabilities.
- Native API evidence: [Chrome 153 IDL](https://github.com/chromium/chromium/blob/153.0.8010.12/third_party/blink/renderer/core/script_tools/model_context.idl) and [Chrome 156 IDL](https://github.com/chromium/chromium/blob/156.0.8078.4/third_party/blink/renderer/core/script_tools/model_context.idl). The registered schema and execution input change together. No browser version guess or execution retry is used.
- All five source threads received a reply after the fix was tested and pushed. GitHub's Resolve API returned `isResolved: true` for each thread. Reply IDs: `4302247619`, `4302247690`, `4302247742`, `4302247806`, and `4302247872`.
- No deferred items or clarification requests remain. Stable-Chrome native UI and external production servers are still unverified release-review paths, not new review findings.
- [GitHub CI run `39022303794`](https://github.com/narumiruna/pi-browser-agent/actions/runs/39022303794) completed with `success` for the published fix commit. C1 is closed.
- The completed implementation plan `docs/plans/2026-10-17_remote-mcp-support-plan.md` is removed after all completion checks pass. The unrelated Skills plan is unchanged.

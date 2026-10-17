# Remote MCP Support

## Goal

Connect Pi Browser Agent to user-configured remote MCP servers over Streamable HTTP and make approved server tools available to the agent without a local process.

## Context

- `src/browser/agent/runtime.ts` currently registers browser tools through `createBrowserTools()`.
- `src/browser/webmcp/adapter.ts` provides page-owned WebMCP. It is not a general MCP client and must remain separate.
- `src/browser/agent/confirmation-policy.ts` supports operation-specific approvals; `permissions.ts` checks Chrome host grants and recorded app approvals.
- Existing host permission patterns omit ports. MCP authorization must additionally bind the exact configured endpoint, including port and path.
- Credentials remain in trusted UI contexts. Runtime messages, page code, session records, and diagnostic exports must not receive them.
- Browser probes and artifact audits reject Node imports, loopback transports, and remote executable code.

## Non-Goals

- stdio, Native Messaging, local bridges, or loopback servers.
- Legacy HTTP+SSE transport, MCP resources, prompts, sampling, elicitation, or roots.
- OAuth discovery/login, arbitrary authentication headers, or automatic credential forwarding.
- Server-provided code, resource fetching, or automatic execution after session restoration.
- Replacing the existing WebMCP feature.

## Architecture

- Own MCP clients in the Side Panel, alongside the agent runtime; do not put credentials or persistent connections in the service worker.
- Add a focused `src/browser/mcp/` module for endpoint validation, configuration storage, transport lifecycle, discovery, and tool adaptation.
- Use a bundled browser-compatible MCP SDK client if the discovery spike passes the build boundary. Do not implement a second protocol stack without a revised plan.
- Allow public HTTPS endpoints only. Reject URL credentials, fragments, query-string credentials, IP-literal endpoints, and local/private hostname forms; do not claim browser hostname checks prevent DNS rebinding.
- Require explicit connection approval for the exact endpoint and a Chrome host grant. Broad screenshot permission is not MCP consent.
- Support unauthenticated servers and an optional user-entered bearer token. Store tokens separately from public configuration, scoped to a stable server ID and endpoint.
- Use requests without ambient cookies. Reject redirects so credentials and request bodies cannot move to another endpoint.
- Discover tools only after user-approved setup or connection. Bound pagination, tool count, schema size/depth, request bytes, response bytes, and request duration.
- Expose namespaced tools with stable collision-free local names. Validate schemas before exposure and validate arguments before dispatch.
- Treat names, descriptions, schemas, and results as untrusted server data. Tool descriptions are model-visible declarations, never system instructions.
- Accept bounded text and structured JSON results initially. Reject unsupported image, audio, embedded-resource, and resource-link blocks without fetching their URLs.
- Require fresh confirmation for every MCP call in the first release, in all confirmation modes. Show endpoint, tool, and arguments; explain remote disclosure and possible side effects. Do not trust read-only annotations.
- Mark calls non-replayable and execute MCP calls sequentially. Abort and disconnect on shutdown, removal, disablement, endpoint/token change, or permission revocation. Never retry a dispatched tool call automatically.
- Snapshot tool declarations per run. Changed definitions require fresh discovery and a later run.

## Plan

- [x] Run a browser compatibility and protocol discovery spike before selecting a dependency.
  - Evidence: SDK 1.32.1 passes the browser probe and real HTTPS production-extension tests for JSON/SSE, session headers, redirect rejection, origin denial, and cancellation. Protocol references and fixed limits are recorded in `docs/mcp.md`.
  - Verify the current supported MCP protocol versions and browser SDK API against official documentation.
  - Bundle the proposed client through `scripts/probes/browser-boundary.ts`; verify no Node-only imports or dynamic remote code.
  - Use an HTTPS fixture in a real Chrome extension to test JSON and SSE responses within Streamable HTTP, session headers, cancellation, redirects, and server origin checks.
  - Verify SDK fetch hooks allow redirect rejection, cookie omission, byte limits during streaming, and cancellation without replay.
  - Record the selected version and fixed limits. Stop and revise the plan if these controls cannot be enforced.
- [x] Implement endpoint validation and separate versioned configuration/token stores.
  - Evidence: `mcp-store.test.ts` covers endpoint policy, revision-bound consent, token isolation/corruption, concurrent writes, failed writes, removal, and limits.
  - Use trusted storage, cross-context write locks, and existing redaction patterns without mixing MCP tokens into provider credentials.
  - Tests cover malformed URLs, prohibited hosts, endpoint changes, corrupt records, token removal, and concurrent updates.
  - Bind authorization to the full endpoint; changing it clears connection approval and never reuses the old token silently.
- [x] Add MCP server management to the settings UI.
  - Evidence: production-extension E2E covers save-disconnected, connect/preview, token clearing, disablement, edits, removal, and plain-text malicious descriptions.
  - Support add, edit, enable/disable, connection test, tool preview, and removal; new records start disconnected.
  - Request host permission only from an explicit user gesture and explain tool metadata/model disclosure.
  - Do not log, echo, or export bearer tokens. Connection errors remain bounded and redacted.
- [x] Implement the transport lifecycle and bounded discovery.
  - Evidence: `mcp-client.test.ts` covers HTTP/protocol failures, pagination, schema/response limits, token echoes, output validation, cancellation/deadlines, and no replay.
  - Recheck configuration, endpoint approval, and Chrome permission before each request.
  - Handle authentication failures, unsupported protocol versions, pagination loops, malformed SSE/JSON, oversized streams, timeouts, aborts, and expired sessions without silent auth fallback.
  - Permit a new discovery connection after failure, but never transparently replay an uncertain tool execution.
  - Tests prove redirects and cookies cannot transmit credentials or arguments elsewhere.
- [x] Add MCP tool adaptation and runtime integration.
  - Evidence: `mcp-manager.test.ts` and `mcp-runtime.test.ts` cover namespace separation, sequential/non-replayable declarations, schema validation, fresh confirmation, run snapshots, aggregate limits, and no-page use.
  - Keep dynamic MCP tools separate from browser-only `enabledTools` and page-context gating; no-page chat can use configured MCP tools.
  - Reject unsupported schemas and invalid arguments locally. Bound aggregate declarations before exposing them to the selected model.
  - Confirm every call without reusable approval scopes. Revalidate connection state after confirmation and before dispatch.
  - Tests cover tool-name collisions, malicious metadata, schema changes, unsupported result blocks, result truncation/failure policy, and sequential non-replayable execution.
- [x] Implement cleanup and cross-context invalidation.
  - Evidence: manager tests and HTTPS lifecycle E2E cover pending confirmation, in-flight token edits/removal, Chrome permission revocation, panel closure, and restart without replay.
  - Settings changes invalidate affected Side Panel clients and cancel pending confirmations and requests.
  - Tests cover panel shutdown, permission revocation, server removal, credential change, streaming edits, and session restoration.
  - Saved results cannot recreate a connection, restore approval, or execute an interrupted call.
- [x] Add HTTPS-fixture E2E coverage.
  - Evidence: 10 production-extension HTTPS scenarios pass across `remote-mcp.spec.ts` and `remote-mcp-lifecycle.spec.ts`, including full-argument confirmation, cookie omission, model/transcript token exclusion, and real optional-permission revocation.
  - Cover connection setup, discovery, denied/approved calls, bearer authentication, no-page usage, revocation, redirect rejection, cancellation, and restart without replay.
  - Verify server arguments go only to the approved endpoint and tokens never enter model requests, transcripts, worker messages, or diagnostics.
- [x] Update browser-boundary checks, documentation, manual acceptance, and release metadata.
  - Evidence: SDK is included in the browser probe; existing artifact bans remain unchanged. README, privacy/security/authentication/storage/architecture docs, manual steps, `docs/mcp.md`, and a minor changeset are added or updated. Native stable-Chrome dialog/layout acceptance is explicitly not claimed.
  - Preserve bans on required host permissions, loopback transports, Node modules, and remote scripts.
  - Update `README.md`, `PRIVACY.md`, security/authentication/storage docs, and add a changeset.
  - Distinguish remote MCP from WebMCP and state unsupported transport, auth, and result types.

## Risks

- Servers may reject extension origins despite Chrome permission. Report incompatibility; do not add a proxy or weaken checks.
- MCP tools can have unknown side effects and receive sensitive arguments. Confirm each call and treat server annotations as advisory only.
- Public hostnames can resolve to private addresses. Browser-only validation does not guarantee network isolation; document this limit and review it before release.
- Unbounded or hostile schemas/results can exhaust memory or context. Enforce limits while reading, not only after parsing.
- Dependency updates can introduce Node-only code. Keep the client in the browser probe and artifact audit.

## Rollback / Recovery

- Store server settings and secrets under new keys; do not migrate provider credentials or existing sessions.
- Disabling/removing a server cancels local work and prevents future dispatch. Removal deletes its token and app connection approval.
- Cancellation cannot undo remote side effects. Report interrupted execution as unknown; require user review before any new call.
- An older build can ignore the new stores; document explicit cleanup of retained MCP tokens.

## Completion Checklist

- [x] The compatibility spike resolves SDK, protocol, permission, streaming-limit, and cancellation unknowns. Evidence: pinned SDK, browser probe, documented limits, and HTTPS JSON/SSE tests.
- [x] Unit and integration tests cover validation, credentials, transport, confirmation, runtime, and lifecycle boundaries. Evidence: MCP unit suites and runtime integration tests, including model changes during discovery.
- [x] HTTPS-fixture E2E scenarios pass against the production extension. Evidence: both remote MCP suites, including cancellation before model dispatch.
- [ ] `npm run check`, `npm test`, `npm run build`, `npm run test:e2e`, and `npm audit --omit=dev` pass.
  - Blocked for the default Chromium 156 environment: the existing native WebMCP smoke test fails because its adapter sends JSON-text arguments. Reproduced on clean `origin/main` commit `6e6c22f`; the adapter is unchanged by this implementation.
  - Final evidence: `npm run ci` passes 574 unit/integration tests, the production build/typecheck/artifact audit, and all 88 E2E tests with Chrome 153 browser and headless shell selected through a temporary `PLAYWRIGHT_BROWSERS_PATH`. No tests are skipped. All 10 remote MCP HTTPS E2E tests pass on Chromium 156. The final default Chromium 156 E2E run passes 87 tests and fails only the existing WebMCP smoke test. `npm audit --omit=dev` reports zero vulnerabilities. Default CI requires a separate WebMCP compatibility fix before this criterion can be closed.
- [x] Artifact and security review confirm no credential leaks, automatic call replay, new required host grants, or Node/local bridge dependencies. Evidence: artifact audit, browser probe, HTTPS model/transcript/worker message assertions, and diff review. The SDK increases packaged size; DNS rebinding remains a documented browser limitation.
- [x] Documentation and changeset describe the implemented behavior; all implementation tasks have acceptance evidence. Native stable-Chrome UI/permission dialogs and external production servers remain explicit unverified release-review paths; the default-CI blocker above remains open.

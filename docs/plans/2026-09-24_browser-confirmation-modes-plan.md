# Browser confirmation modes — initial version

## Goal

Offer only three confirmation-mode choices in Settings for Pi Browser Agent's own **Confirm browser action** dialog:

| Mode | Reuse an approved action |
| --- | --- |
| **Strict** | Never; ask for every action that currently requires confirmation. |
| **Balanced** | Until the browser restarts; ask again on the first matching action after restart. Default for new installations. |
| **Convenient** | Across browser restarts, until the user clears the approval or extension data. |

Apply one policy to all app-confirmation paths, not just WebMCP. Keep Chrome-owned permission prompts and runtime authorization checks independent of these modes. Ship a small initial version and refine scopes based on acceptance feedback; do not add more modes or per-tool settings.

## Context

- `src/browser/sidepanel/conversation-page.ts` owns the one confirmation dialog. `src/browser/agent/browser-tools.ts` requests confirmation after `CONFIRMATION_REQUIRED` and directly for tab switching, tab opening, and WebMCP. The service worker and injected page operations recheck permission, confirmed status, tab freshness, and mutation targets.
- `src/browser/storage.ts` validates settings in `chrome.storage.local`; `src/browser/sidepanel/settings-page.ts` renders and saves them. `src/browser/agent/runtime.ts` synchronizes settings while running. `src/browser/permissions.ts` separately records exact-origin approvals. Session transcripts contain agent messages/tool results, **not** an authorization ledger.
- Screenshot access and bookmark API access involve separate Chrome optional permissions; Chrome may suppress its native prompt after granting access. The app's per-read bookmark confirmation remains a separate check.

## Approved initial approval boundary (user selected conservative initial version)

An approval is never global. Reuse only the same operation and matching scope; match exact arguments for calls that may have side effects. For Balanced, approvals live until the browser restarts; for Convenient, stable approvals survive restart. No raw query, argument, or full page URL is stored in the durable ledger (only bounded SHA-256 fingerprints). A matching fingerprint only skips the app dialog; the worker still checks permissions and targets at execution.

| Existing confirmation | Proposed match for initial version | Limit |
| --- | --- | --- |
| WebMCP list | Page URL and `list` action | A different page asks again. |
| WebMCP call | Page URL, tool name, and exact canonical arguments | Different arguments or page asks again; identical calls can still have side effects, which the first Confirm must disclose. |
| Bookmark search/recent | Operation, exact query (when applicable), and limit | Different query/limit asks again; Chrome's optional bookmark permission remains separate. |
| Cross-origin navigation or link | Source page origin, exact destination URL, and action | Different URLs, including query changes, ask again. |
| Open website/search URL | Exact destination URL and `open` action | A new URL or query asks again; reusing approval can still open an additional tab. |
| Switch web tab | Current tab ID and exact tab URL | Browser restart usually changes tab IDs, so Convenient may ask again; never broaden to all tabs at an origin. |
| Form submission, download, or ref-only click with no verifiable stable target | No reusable key for the initial version | Keep per-operation confirmation rather than implicitly authorize a changed target or repeat an irreversible action. The user accepted this exception for the initial version. |
| Screenshot access | Chrome's `<all_urls>` optional grant | A cached app approval cannot replace Chrome's required gesture when its grant is absent; after grant, current behavior needs no app confirmation. |

User accepted this conservative matrix (option 1). Reusing even exact WebMCP calls can repeat mutations; approving a tool name regardless of arguments, automatically repeating form submissions/downloads, or broadening a site-wide approval is not authorized. Changing modes clears both Balanced and Convenient approval ledgers, so returning to Convenient requires fresh confirmation. New installs default to Balanced; pre-existing settings without a mode default to Strict.

## Plan

- [x] **Set the MVP approval boundary before coding.** Inventory every call to the app confirmation handler and its identifying data. Write a short operation matrix covering page click/submit/download, cross-origin link/navigation, tab switch/open, WebMCP list/call, bookmark search/recent, and screenshot access. Choose stable matching keys for *the same action and target* (at least operation and relevant site/target; include WebMCP tool identity and argument scope, bookmark query/limit, and navigation destination as appropriate). Define what happens when only a snapshot-scoped element reference is available, arguments or destination change, or a mutation could repeat an irreversible action. **Acceptance:** user reviews the matrix and explicitly accepts any operation that will still prompt on every invocation or any wider reuse scope. Do not interpret a single Confirm as approval for unrelated sites or action types.
- [x] **Specify migration and revocation before changing defaults.** New installs use Balanced; existing installations without a saved mode retain Strict until the user opts in, so an update cannot silently relax prior confirmation behavior. Switching to Strict stops all reuse immediately; decide whether leaving Convenient also deletes durable grants or merely disables them, and surface the result in Settings. **Acceptance:** migration and mode-switch tests state the chosen behavior.
- [x] **Implement a focused confirmation-policy module and versioned approval storage.** Strict bypasses the ledger; Balanced uses `chrome.storage.session` so Side Panel/service-worker restarts do not erase approval but a browser restart does; Convenient uses `chrome.storage.local` for durable approvals. Derive a bounded, canonical key from the agreed matrix; do not persist raw WebMCP arguments, bookmark queries, credentials, or full query-bearing URLs. Serialize concurrent writes and fail closed on malformed data or storage failure. Provide a clear-all action for remembered approvals, not another mode. **Acceptance:** unit tests cover matching/nonmatching keys, duplicate approvals, concurrent updates, invalid records, reset on browser restart, and persistence across Side Panel restart.
- [x] **Route every app confirmation through the policy without weakening execution checks.** The first matching action displays the ordinary Confirm/Cancel dialog with a plain-language description of what future calls will bypass and for how long. An approved match skips only that app dialog: the worker still checks current Chrome permission and, where applicable, exact origin, tab visibility/context, cancellation, and stale or changed targets; never retry or replay a failed mutation. Chrome-owned permission requests must still run from an actual user gesture when missing, regardless of cached approvals. **Acceptance:** unit/integration tests cover each matrix row, denial, abort, changed arguments/target, permission revocation, stale context, and non-replay of side effects.
- [x] **Add only the three settings choices and clear action.** Validate `Strict | Balanced | Convenient` in `AppSettings`, show the selected mode and concise risk/lifetime description, keep the active Side Panel in sync after settings are saved, and make clearing durable approvals discoverable without presenting additional authorization choices. **Acceptance:** settings tests cover default/migration, save/reopen, mid-run changes, and clear-all.
- [x] **Run automated browser acceptance for lifetime and boundaries.** `tests/e2e/confirmation-modes.spec.ts` passed on Chrome for Testing 153.0.8010.12: repeated prompts, changed arguments/targets, declines, Side Panel/service-worker/full Chromium restarts, clearing grants, and WebMCP. `tests/unit/confirmation-policy.test.ts` covers revocation, malformed records, failed writes, concurrent additions, capacity, and mode changes. Evidence recorded in `docs/manual-acceptance.md`.
- [ ] **Perform stable-Chrome manual acceptance before release.** Verify browser-owned Side Panel UI, native bookmark/site permission denial and revocation, and Balanced/Convenient behavior across a full stable Chrome restart. **Pending:** only Chrome for Testing 153.0.8010.12 is installed here; no stable Chrome binary was found. Keep release blocked on this check.
- [x] **Update user and security documentation.** Describe the three modes, what an approval covers, sensitive-operation exceptions if agreed in the matrix, storage/retention, revocation, and Chrome-versus-app permission distinction in `README.md`, `PRIVACY.md`, `docs/security.md`, `docs/architecture.md`, and `docs/permissions-and-storage.md`. **Acceptance:** descriptions agree with tests and the dialog copy.

## Risks and remaining release checks

- WebMCP tools are page-defined and not reliably labeled read-only. Reusing approval for a tool across calls with different arguments or across page updates grants the website/model ongoing authority. Forms and downloads may duplicate irreversible effects even when the target and arguments match. The accepted matrix requires an exact argument match for WebMCP calls and always confirms submissions and downloads; a global approval for all browser actions is out of scope.
- Some click targets exist only as short-lived snapshot references. Convenient cannot safely promise a durable match for those without a verified stable identity. Fallback to confirmation rather than broadening a key silently.
- The settings mode cannot force Chrome to re-prompt in Strict or suppress a missing native grant in Convenient. Treat app approval and Chrome permission as separate requirements.
- Persistent approvals can outlive the page implementation that originally prompted. Match only the approved scope, recheck live permissions/context, disclose that site behavior can change, and provide revocation. Changing modes clears saved approvals in the initial version. The site implementation may still change without any URL or argument change, so Convenient should be used only with trusted destinations.

## Completion Checklist

- [x] The approved operation matrix and migration/mode-switch decisions are recorded before implementation; always-confirm exceptions and changed-argument prompts are explicit.
- [x] `npm run check`, `npm test` (411 passing), `npm run build` (artifact audit passes; existing bundle-size warning), and `npm run test:e2e` (62 passing) passed on 2026-09-24.
- [ ] Stable Chrome browser-restart and native-permission acceptance is still pending; release remains blocked until version and outcomes are recorded in `docs/manual-acceptance.md`.
- [x] Reviewed the staged diff (19 intended paths): `manifest.json` and worker permission gates are unchanged; click errors add only action-classification booleans; all shortcuts bind to the approved exact fingerprint, and tool replay modes remain unchanged. `README.md`, `PRIVACY.md`, security/storage/architecture/WebMCP docs, and the dialog copy describe the same policy.

## Rollback / recovery

If approval reuse is unsafe, force Strict for existing users and stop consulting the versioned approval keys; remove stored approval data separately without changing Chrome's independent permission grants or conversation transcripts. A subsequent release can remove the setting and ledger after affected users have been notified.

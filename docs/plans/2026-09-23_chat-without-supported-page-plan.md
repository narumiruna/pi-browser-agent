# Chat without a supported page

## Goal

Let Pi Browser Agent accept prompts on any active tab without weakening its page-operation boundary: conversations and approved bookmark reads work without a readable page; reading and operating a page still require an eligible, visible tab and the existing permissions and confirmations. Make the limitation a clear, actionable UI state rather than a send-time error.

## Context

- `src/browser/sidepanel/conversation-page.ts` `requestRunAccess()` requires an HTTP(S) `TabContext` and requests both current-site and provider access before every prompt. The Side Panel itself can already open on other tabs.
- `src/browser/service-worker.ts` binds only the active HTTP(S) tab in the focused window; `app.getState` returns only `tabContext | null`. A protected tab can therefore be indistinguishable from no tab, and switching between two unsupported tabs need not emit `tab.changed`.
- `src/browser/agent/browser-tools.ts` already separates bookmark tools from tab-bound tools. Page injection, screenshot, and WebMCP are independently checked by the worker. `src/browser/permissions.ts` accepts only HTTP(S) hosts and keeps app-approved origins separate from Chrome's broader screenshot permission.
- Chrome does not grant `activeTab` access to restricted pages such as `chrome://`; `file://` access requires a separate user-controlled extension setting. HTTP(S) alone does not guarantee script access (for example, protected stores or PDF viewers). References: [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [file access](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions#allow_access_to_file_urls_and_incognito_pages), [optional permissions](https://developer.chrome.com/docs/extensions/reference/api/permissions).

## Architecture

Keep two distinct concepts:

1. **Conversation availability:** provider authentication and endpoint permission determine whether a prompt can run. No current-page permission is needed for a context-free prompt.
2. **Page capability:** an observed visible-tab summary for UI (none / eligible HTTP(S) / restricted / local file / PDF or other unreadable), separate from the worker's authoritative `TabContext` for operations. Do not send protected URLs, file paths, or tab titles to the model by default. A URL scheme is only a preliminary classification; permission and actual injection capability are checked at use time.

The Side Panel owns the chosen per-turn context policy (`use current page` or `no page context`) and user-visible actions. The agent's page tools enforce that policy for the entire turn, including after a tab switch; the worker continues to enforce visibility, context epoch, exact-origin approval, and confirmation on every request. Bookmark tools remain independent of page context. Opening a work tab is a separate, confirmed action; it must not navigate a protected tab or silently submit a search query to a third party. For a site the user explicitly chooses, create a new HTTP(S) tab; when the user requests web search, confirm the search URL/query before opening it. Do not describe an arbitrary third-party page or a `chrome-extension://` page as an injectable HTTP(S) workspace.

## Plan

- [x] Verify Chrome behavior for `chrome://settings`, new tab, Web Store, `file://` with and without file access, and network/local PDF in a disposable profile; record which cases expose metadata, permit injection, or return denial in tests or `docs/manual-acceptance.md`. Decide whether a separate, bounded file/PDF import is needed; never assume enabling file URLs makes the PDF viewer scriptable.
- [x] Define a validated visible-page capability/status shape in `src/browser/runtime/messages.ts` and `src/browser/service-worker.ts`; keep `TabContext` HTTP(S)-only and preserve stale-context invalidation. Unit/E2E evidence: supported→restricted, restricted→restricted, focus loss, and permission/injection failures all update the displayed state without exposing page content.
- [x] Decouple submission preflight in `src/browser/sidepanel/conversation-page.ts`: request provider endpoints even with no `TabContext`, request current-site access only for a page-context turn, and reject stale selected-element chips if their captured page changed. E2E evidence: a prompt on `chrome://settings` reaches the mocked model; no current-site permission prompt occurs; a normal HTTP(S) turn retains existing access behavior.
- [x] Enforce a per-turn no-page policy in `src/browser/agent/runtime.ts` and `src/browser/agent/browser-tools.ts`; page read, screenshot, interaction, WebMCP, and current-tab metadata cannot be invoked under this policy even if another tab becomes active, while confirmed bookmark reads remain available. Add unit tests for normal and context-free turns, tab changes during a turn, queued instructions, and the no-page guidance in the system prompt.
- [x] Add a page-capability line and waiting state to `src/browser/sidepanel/index.html`, `conversation-page.ts`, `conversation-copy.ts`, and `styles.css`. Keep the composer/send button enabled, show `Working` only during an actual run, offer `Open a website`, `Choose a tab`, and `Continue without page context`, and disable page-only controls such as the picker when unavailable. Test keyboard/screen-reader labels, narrow panels, dark mode, and `prefers-reduced-motion`; waiting glow/pulse must not be required to understand the state.
- [x] Implement explicit choose-tab and open-site/search actions: list eligible tabs without background reads, activate only the user's choice, and create an HTTP(S) tab only after the user confirms the destination (and search query, if any). Require a fresh bound context and destination approval before page tools operate; preserve cross-origin, form-submit, and download confirmations. E2E evidence: no implicit tab creation on Send, protected tabs remain untouched, denied destination access stays denied, and switching tabs invalidates stale operations.
- [x] Based on the first task's results, either implement **read-only, bounded** local-file/PDF import behind explicit selection and documented permissions, with no script-based interaction and tests for revocation/size/path privacy, or document file/PDF as unavailable and move it to a separate follow-up plan. Do not add `file://` to the existing HTTP(S) injection or navigation allowlist merely to pass a URL check.
- [x] Update `README.md`, `docs/architecture.md`, `docs/security.md`, `PRIVACY.md`, and manual acceptance guidance to match the shipped capabilities, provider sharing, and non-supported-page behavior; verify no documentation claims file/PDF access that the tested build does not provide.

## Risks

- A URL-based eligibility check could mistakenly treat a protected HTTP(S) page or PDF as operable; fail closed on injection errors and retain worker-side checks.
- A no-page choice could be defeated by a later tab change or a queued prompt; bind policy to the turn, not the last rendered tab state.
- `chrome.permissions.request()` must be triggered by a user gesture; do not move optional permission prompts into automatic model/tool retries.
- Opening a search URL discloses the query to the search provider; show destination and obtain explicit confirmation. Do not silently open or reuse tabs, replay mutations, or log local file paths.

## Rollback / Recovery

No session-data migration is planned. If the new capability state or work-tab flow causes a regression, revert those UI/runtime changes while retaining the existing HTTP(S) worker guards; existing sessions remain readable. Revoke any newly introduced optional file permission in Chrome during rollback, and update `PRIVACY.md` and user-facing guidance to match the reverted behavior.

## Completion Checklist

- [x] `npm run check`, `npm test`, `npm run build`, and `npm run test:e2e` pass, including `audit:artifact`; record any environment-only E2E limitation rather than marking it complete. Evidence: 394 unit/integration tests, 49 Playwright tests (headless Chrome-for-Testing), artifact audit 23 files. A pre-existing ~1.23 MiB runtime bundle performance warning remains.
- [ ] Manual acceptance on protected, ordinary HTTP(S), inaccessible HTTP(S), and available file/PDF cases matches the documented capability labels and permissions; confirm pure chat, bookmark confirmation, explicit work-tab creation, and no-page privacy mode. **Pending:** browser-owned Side Panel verification on stable Chrome with a human reviewer (see `docs/manual-acceptance.md`); the automated headless extension-page coverage is not equivalent. Record version and outcomes before release.
- [x] Review `git diff` for unintended manifest permission changes, broadened injection/screenshot access, or regressions to navigation/submit/download confirmation; resolve the file/PDF decision and update the final documentation accordingly. Evidence: no tracked manifest change, unchanged worker permission/confirmation gates, `git diff --check` clean; file/PDF import deferred to `docs/plans/2026-09-23_local-file-pdf-read-plan.md`.

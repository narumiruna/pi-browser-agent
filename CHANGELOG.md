# pi-browser-agent

## 0.8.1

### Patch Changes

- 7b6e574: Keep element-picker results and errors when they arrive after an inactive startup response.
- 2154b25: Update browser runtime dependencies and development tools. Resolve Biome findings without changing rendered-text behavior, and preserve changeset YAML headers during formatting.

## 0.8.0

### Minor Changes

- 409c6a6: Add bounded viewport and container scrolling, safe element details, and confirmed native option selection through discovered references. Invalidate element snapshots after scroll and selection, with permission, schema, and browser-layout tests.
- 1ab2115: Add filtered element discovery, bounded literal text search and condition waits, label-only native select option reads, and confirmed checkbox/radio state changes. Preserve active-tab access checks, reference lifetime, and no-replay behavior without new permissions or dependencies.
- 089d41e: Add reviewed, opt-in browser skills imported from text-only `SKILL.md` files. Keep enabled discovery metadata separate from model-requested bodies, enforce fixed parsing/storage/run limits, and preserve browser authorization boundaries. Provide explicit replacement, disablement, and deletion with saved-history retention disclosures.
- 830afb3: Add local Side Panel slash commands for sessions, settings, and credential setup, with keyboard and pointer completion. Commands run only while idle and do not send command text or attached context to the model.
- 3e82879: Add `/tree` for persistent conversation branches. Restore earlier user messages as editable drafts, switch between completed response paths without replaying tools, and retain inactive branches across restarts. Preserve legacy sessions and reject oversized tree writes without pruning branch history.

### Patch Changes

- d1f0973: Enable newly added browser tools by default after updates. Save explicit disabled-tool choices while keeping an enabled snapshot for older builds. Preserve original-tool opt-outs from legacy settings and enable later additions once; confirmations and Chrome permissions are unchanged.
- 42dddc3: Fix element-picker startup during unrelated tab navigation and selection over page modals and iframes. Protect the viewport shield from page CSS, preserve legacy Chrome zoom geometry and forced-colors support, report protection failures, and prevent stale startup cleanup from stopping a replacement picker. Iframe contents and shadow-owned controls remain unsupported; permissions and storage are unchanged.

## 0.7.0

### Minor Changes

- f8e0f3f: Add user-configured remote MCP tools over HTTPS Streamable HTTP, with separate bearer-token storage, bounded discovery and results, fresh confirmation for every call, and cancellation without automatic replay.

### Patch Changes

- e3d9092: Keep MCP discovery, confirmation, calls, and previews active when an unrelated permission is removed. Recheck endpoint access for origin removals. Cancel current connections if access is lost or cannot be checked.
- 912ef23: Reject stale MCP server removals before changing settings or tokens. Keep servers disabled during preview and allow preview access only for discovery and session cleanup. Enable tools only after preview succeeds with the same saved revision.
- bd91a7c: Preserve drafts on failed MCP discovery, show safe local validation errors, reject short tokens and stale settings edits, and terminate authorized idle server sessions. Restore native WebMCP calls on current Chromium without retrying execution.

## 0.6.0

### Minor Changes

- 066261c: Add Cmd+Shift+E on macOS and Ctrl+Shift+E on Windows/Linux to open Pi Browser Agent and toggle page-element selection. Keep site authorization explicit, cancel stale startup requests, and show the assigned shortcut in the picker tooltip.

### Patch Changes

- 4848afc: Update the pi SDK and adapt browser Azure configuration to the renamed provider. Migrate saved Azure credentials, model settings, and session selections so existing users retain authentication and can restore conversations after upgrading.
- dcfa381: Simplify browser injection failure handling, confirmation permission checks, and activity-only transcript rendering without changing authorization or visible behavior. Reuse the shared Codex response fixtures and expand regression coverage.

## 0.5.1

### Patch Changes

- 6aca1d6: Upgrade the Pi SDK to 1.0.0 and refresh development dependencies.

## 0.5.0

### Minor Changes

- b1cc8a6: Allow the browser agent to read a page section by CSS selector and continue long reads with an offset, while keeping tool output within the existing size limit.

### Patch Changes

- 4aec0a9: Upgrade the Pi SDK to 0.99.1 and refresh development dependencies. Keep authentication tests and UI documentation aligned with the SDK's OpenAI Codex (legacy) label.

## 0.4.1

### Patch Changes

- addf047: Keep selected page elements attachable when their optional metadata exceeds the context limit, and show an error instead of silently dropping rejected selections.

## 0.4.0

### Minor Changes

- f210f71: Replace manual page-context choices with agent-driven tab selection and confirmed website opening, while keeping context-free replies available.
- 190befc: Allow context-free chat on protected pages, add explicit web-tab choices, and keep page tools disabled for no-page turns.

## 0.3.0

### Minor Changes

- e54cb51: Add a Thinking level setting that persists across restarts and applies to the active conversation and new sessions.

## 0.2.1

### Patch Changes

- a99d5de: Redesign the Side Panel session picker with an aligned custom menu, softer selection states, clearer session hierarchy, and truncated titles with tooltips.
- 9790c25: Start page-element selection with a fresh tab context after Chrome's site-access prompt changes browser focus.
- 270fb7c: Reject selected-element context after the active page changes, and accept valid HTML tag names containing punctuation.
- 485ff2b: Stabilize active-page detection during Chrome window switches and stop retrying other browser tools after no HTTP(S) tab is available.
- 196f56f: Keep the primary composer action right-aligned when switching between Send and Add instruction.

## 0.2.0

### Minor Changes

- 269cec9: Add bounded visible-element discovery with snapshot-scoped click/type references, and safe Markdown answers with persistent streaming disclosures and clearly scoped, labeled copy controls. Simplify the Side Panel header and composer while preserving existing permissions, selector compatibility, and mutation confirmation requirements.
- 7f1a986: Group each Pi turn into one readable response card, replace internal tool names and production payloads with human-readable activity labels, and add distinct controls for steering or queueing instructions while a run is active.
- c60be66: Add a safe page-element picker with structured agent context and a local screenshot annotation editor that attaches bounded rendered images through the existing composer flow.

### Patch Changes

- c0a1de1: Add Changesets-based release management for the private package.

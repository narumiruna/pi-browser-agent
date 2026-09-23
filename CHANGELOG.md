# pi-browser-agent

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

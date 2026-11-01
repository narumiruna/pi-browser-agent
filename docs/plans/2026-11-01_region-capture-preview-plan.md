# Region capture with preview

## Goal

Let users select a viewport rectangle, inspect a cropped image, and attach only that image to a message. Reduce unrelated page content sent to the provider without claiming that Chrome captures only the selected pixels.

## Context

Repository evidence was checked on `main` at `aa17a1b`.

- `captureVisible()` in `src/browser/service-worker.ts` uses Chrome's visible-viewport capture API and checks screenshot access and context before and after capture.
- The page-annotation surface and worker already protect viewport input through capture, freeze revisions, and require confirmed cleanup.
- `src/browser/sidepanel/images.ts` validates composer images: four images and 3,000,000 combined binary bytes.
- `src/browser/sidepanel/screenshot-annotation.ts` has bounded PNG dimension checks and export, but no region-crop workflow.
- [Permissions and storage](../permissions-and-storage.md) distinguishes screenshot consent, exact-site approval, unsent memory, and sent image history.

This plan can run without shapes or pins. Its ordinary cropped image can later be used as a target or reference in [the pairing plan](2026-11-01_target-reference-clarification-plan.md).

## Architecture

### User flow and state

Use one **Capture region** composer action. Support only the current accessible HTTP(S) viewport.

1. Start a protected region-selection surface after exact-site approval. Starting or dragging does not capture or contact a provider.
2. Drag one rectangle. Allow reselection before capture. Require at least 8 CSS pixels on each side. Expose the same rectangle as labeled X, Y, Width, and Height number inputs in the panel for keyboard-only selection. Validate edits against the viewport and update the painted selection without capture.
3. Select **Preview region** in the panel. Check image-model support and remaining composer capacity before capture, without discarding the selection on failure. Use the existing explicit screenshot confirmation if optional `<all_urls>` access is missing.
4. Freeze the selection, hide only its painted outline, wait for paint, and capture while the input shield remains active.
5. Crop in the worker, confirm surface cleanup, then open a local static preview with **Attach**, **Retake**, and **Cancel**.
6. Attach adds one ordinary cropped image to the composer. Only a later explicit Send contacts the provider. Preview and Attach do not request provider-origin access or start credential setup.

The state path is idle → selecting → capturing → cleanup → preview → attached. A preview failure never falls back to attaching the full viewport. Retake discards that preview and starts a fresh current-page selection; it is not an automatic recapture.

Selection excludes drawing, picker/pins, dictation, commands, and session navigation. Bind pending work to the session, immutable operation ID, client, token, generation, and original tab context. A finished preview has no live page capability and may remain after a later tab change. Session replacement or panel disposal cancels pending work.

### Capture, crop, and privacy

Use fixed `regionCapture.start`, `regionCapture.update`, `regionCapture.capture`, and `regionCapture.stop` messages with a bounded worker owner. Updates change only the rectangle. Only the panel's explicit Preview action can request capture; content notifications cannot authorize it. Reuse the existing screenshot permission checks and capture helper without changing the model-facing `browser_capture_visible` result.

Chrome first creates a full-viewport PNG in worker memory. Decode and crop it in that trusted context before any result reaches the panel. Do not put the original PNG in a runtime response, tool result, log, session, or composer attachment. The provider receives only the crop after Send.

Map CSS coordinates using the actual decoded PNG dimensions and the frozen viewport dimensions, not an assumed DPR. Round crop edges inward: ceil left/top, floor right/bottom. Reject an empty, invalid, stale, or out-of-bounds result. This avoids adding pixels outside the selected rectangle.

Keep the existing 3,000,000-character source screenshot limit. Bound source decoding and crop canvases to 4,096 px per dimension and 16,000,000 pixels. Validate PNG headers and decoded dimensions before export. Export one non-empty PNG within the existing composer byte budget; do not silently change image format or fall back to the original.

Clear owned canvases, close decoded bitmaps, revoke object URLs, and drop source references on success, cancellation, and failure. Do not claim secure memory erasure. The crop retains the required slight shield tint but excludes the selection outline and Side Panel controls.

After confirmed cleanup, crop/attach/submission failures retain only the appropriate cropped draft. If cleanup cannot be confirmed, keep Attach and Send blocked until removal is confirmed. A manual submission retry uses the same crop without another capture.

A crop limits the attached image, not all agent context. Explicitly disclose that text, selected-element data, prior history, and separately approved browser reads may still disclose other content.

## Non-Goals

- Full-page capture, scrolling capture, video, or protected/file/PDF pages.
- Automatic redaction, OCR, blur tools, or a general image editor.
- Changing existing full-viewport screenshot-tool behavior or permissions.
- Storing original viewport pixels or restoring live selection from history.

## Plan

- [x] Prove crop alignment and outline exclusion in a test-only browser fixture. Expected result: known inside/outside pixel sentinels map correctly at native DPR 1 and 1.5, CSS zoom, modal placement, and viewport edges while iframe input stays intercepted. Evidence: decoded real `captureVisibleTab()` PNG samples before production integration. Keep dependent capture work blocked if the proof fails. Passed before production integration: baseline `npm run build` and `npm run test:e2e -- tests/e2e/region-capture-proof.spec.ts --workers=2` (8/8; Chromium 156.0.8078.4). Real PNGs: 1000 × 700 and 1500 × 1050; fractional inward crops: 199 × 159 and 300 × 239; full-edge crops also pass; zero outside/outline pixels; OOPIF clicks intercepted before/during/after capture. Local proof PNGs are under ignored `test-results/region-capture-proof-*/crop.png`; log `/tmp/region-capture-proof.log`. Initial fixture attempts exposed CSP-blocked data-URL fetch and a too-fast capture timing race; Blob decoding and a bounded test texture fixed the fixture without changing production or weakening assertions.
- [x] Define fixed region messages, rectangle validation, capture states, and limits. Expected result: finite bounded geometry, exact keys, ownership, and monotonic state are enforced. Evidence: focused unit tests reject forged messages, NaN/Infinity, empty regions, extra fields, stale results, and oversized dimensions.
- [x] Implement the protected selection surface and worker lifecycle. Expected result: no pointer activation, input gap, screenshot on drag, or stale capture; original-target cleanup is serialized. Evidence: surface and worker integration tests cover paint waits, active pointer, modal/iframe focus, scroll/zoom, navigation/reload, tab/window changes, permission loss, disconnect, expiry, restart, and failed cleanup.
- [x] Implement worker-local bounded decode, inward crop, and PNG export. Expected result: only cropped pixels leave the worker and source resources are released on every path. Evidence: unit/integration tests cover source/decode mismatch, edge rounding, encoding failure, screenshot limits, byte limits, cancellation during decode/export, and no full-image fallback. Extract only the needed pure raster helper if sharing existing PNG validation.
- [x] Implement the region action, static preview, and composer attachment path. Expected result: Preview and Attach make no provider request; Cancel adds nothing; Retake is explicit; one attachment has one immutable ID. Evidence: controller tests cover focus, keyboard-only numeric selection, image capability, remaining capacity, delayed replies, language deferral, and session changes.
- [x] Add `tests/e2e/region-capture.spec.ts` in the temporary-copy harness. Expected result: exact crop pixels reach one mocked provider request only after Send, and outside sentinels are absent from decoded attachments and stored messages. Evidence: successful build followed by cancel, permission denial/revocation, retake, duplicate click, late capture, cleanup blocker, submission retry without recapture, and 320/360 px preview-layout cases. Assert existing text/history behavior separately from crop privacy.
- [x] Update `README.md`, focused feature documentation, `docs/architecture.md`, `docs/security.md`, `docs/permissions-and-storage.md`, and `PRIVACY.md`; add all 18 locale entries and a minor changeset. Expected result: full-viewport temporary capture and crop-only attachment claims are explicit. Evidence: documentation review, catalog tests, and `git diff --check`; retain proof captures and external handoff in `docs/manual-acceptance.md`.
- [ ] Run focused tests and `npm run ci`. Expected result: all required checks pass, including the existing full-viewport screenshot and page-drawing suites. Evidence: record commands, browser version, crop/privacy assertions, and resource-cleanup results.

Focused evidence: 2,102 unit/integration tests in 77 files; later controller-generation regressions add two passing tests. The production build, typecheck, and 50-file artifact audit pass. All 14 production region E2E scenarios pass, including actual DPR 1/1.5 with modal CSS zoom, real screenshot permission revocation, MV3 restart/original-window cleanup, numeric selection, exact crop storage/history, repeated cleanup failure/recovery, and manual submission retry. Retained evidence and external limits are in [manual acceptance](../manual-acceptance.md#region-capture-acceptance--2026-11-01). The first full CI failed after a concurrent focused Playwright command deleted its shared trace directory (`ENOENT`); no gate is waived. The sequential full CI passed in `/tmp/region-capture-ci-final.log`: 2,104 unit/integration tests and 319 browser scenarios. The subsequent initial-pinch-zoom guard passes check, all 2,108 unit/integration tests, build/typecheck/audit, and all 15 region E2E. It rejects non-unit visual scale/nonzero offsets before a surface or capture, permits gutters/fractional dimensions, and preserves normal browser zoom 1.25 plus native DPR/CSS zoom. Per main coordination, the mandatory post-point-comments-rebase full CI is the final gate; the plan remains open and must not be deleted before that gate.

## Completion Checklist

- [x] Region selection, preview, Attach, Retake, and Cancel work without automatic model submission.
- [x] DPR/zoom and edge-rounding evidence proves the crop excludes outside pixels and the selection outline.
- [x] Full-viewport PNG data stays worker-local and is not stored or transmitted as an attachment.
- [x] Access, stale-context, input protection, cancellation, and cleanup blockers have passing failure tests.
- [x] Retried submission sends the same cropped image once; existing screenshots and attachments remain compatible.
- [ ] All mandatory checks, privacy documentation, localization, changeset, and retained external handoff are complete.

## Rollback / Recovery

Remove the region action, preview, and runtime protocol together. Existing cropped images remain ordinary image history and need no migration. Drop unsent preview resources without deleting sessions or changing permissions. Keep the original screenshot tool unchanged.

## External Handoff

1. **Native capture consent and selection usability.** Responsible role: release tester. Prerequisite: a built extension, stable Chrome, controlled pages with private outside sentinels, and available touch/pen hardware. Action: test the actual Side Panel, native permission grant/denial/revocation, keyboard and physical-device selection, and preview readability. Expected result: the chosen crop is clear and only the explicit cropped attachment is sent. Unverified behavior: browser-owned UI, device input, screen-reader output, and subjective preview quality. Release restriction: do not describe headless evidence as native/device acceptance or describe region capture as a general privacy boundary.

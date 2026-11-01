# Capture a region

Select **Capture region** to select a rectangle in the current visible HTTP(S) viewport. Review the cropped image, attach it, then select **Send** separately.

Region capture limits the attached image, not all agent context. Text, selected-element data, prior history, and separately approved page reads can include content outside the crop. See [verification and external limits](manual-acceptance.md#region-capture-acceptance--2026-11-01).

## Select and preview

1. Wait for an idle conversation and open an accessible HTTP(S) page in the active tab of the focused Chrome window.
2. Select **Capture region**. Approve exact current-site access if requested. Starting selection does not capture or contact a provider.
3. Drag a rectangle, or use the labeled **X**, **Y**, **Width**, and **Height** number inputs. Coordinates use CSS pixels from the viewport's top-left corner. Each side must be at least 8 CSS pixels. You can select again before capture.
4. Select **Preview region**. The selected model must accept images, and the composer must have capacity for one more image. A failed preflight preserves the selection.
   - If screenshot access is missing, use the existing screenshot confirmation. Its **Confirm** gesture requests optional Chrome `<all_urls>` access. Denial does not capture or contact a provider.
5. Inspect the static crop. Select **Attach** to add one ordinary composer image, **Retake** to discard it and start a fresh current-page selection, or **Cancel** to discard it.
6. Review the composer and select **Send** when ready. Preview and Attach do not request provider-origin access, start credential setup, or submit a model request.

The selection surface blocks target activation and user scrolling. It does not change page-owned content, layout, dialogs, or popovers. An earlier page capture listener can still observe an intercepted event; this is not browser-internal input isolation. Live page content can move during selection and capture. Visible iframe pixels can be included without inspecting iframe DOM.

Drawing, element selection, dictation, commands, and session navigation cannot overlap region selection. Interface language changes wait until selection, capture, cleanup, and preview finish. Keyboard focus starts at X, moves to Attach for preview, and returns to the composer after attachment.

An already pinch-zoomed or panned visual viewport is not supported. Reset page pinch zoom before starting. This fails before a surface or capture is installed and does not block ordinary chat. Normal browser zoom, native DPR, and CSS zoom remain supported; scrollbar gutters and fractional viewport dimensions alone do not cause rejection.

## What Chrome captures

Chrome first captures a full-viewport PNG in trusted worker memory. The worker decodes it, maps the CSS rectangle to the actual PNG dimensions, and crops it before returning any image to the panel. It rounds left/top edges up and right/bottom edges down. It does not assume a device-pixel ratio or add outside pixels to fill an edge.

The input shield remains active during capture. Only the selection outline is hidden, followed by two animation frames before capture. The crop retains the required slight 1% black shield tint. It excludes the selection outline and Side Panel controls. There is no full-image fallback on failure. The existing full-viewport screenshot tool is unchanged.

The original viewport PNG is not returned in a runtime response, attached, logged, saved in a session, or sent to the provider by this workflow. Only the crop can become an attachment after explicit Attach and Send. Owned canvases are reset, decoded bitmaps are closed, and preview object URLs are revoked when no longer needed. This is resource cleanup, not secure memory erasure.

## Cancel and recover

**Cancel**, the active capture button, or Escape discards unsent region work. Navigation/reload, tab/window change, scroll, viewport/zoom change, access loss, protection loss, five-minute expiry, panel disconnect, or worker restart cancels live selection and pending capture. Late replies cannot revive cancelled work.

A static preview has no live page capability. After confirmed surface cleanup, it can survive a later tab change. Session replacement and panel disposal discard it. History restores only ordinary sent images, not a live rectangle or token.

If capture or crop fails, the selection remains editable only while the original context and protection are safe. If cleanup cannot be confirmed, Attach and Send stay blocked. Restore site access or reload as directed, then retry cleanup explicitly; a changed URL or epoch alone is not proof of removal. A retained crop can be previewed after cleanup succeeds without another capture.

If attachment fails after cleanup, the static cropped draft remains for manual retry or cancellation. If later submission fails, the ordinary composer image and text remain. Retry Send manually with that same image; do not capture again. No failed mutation or remote MCP call is automatically replayed.

## Limits and data

| Item                                      | Limit                                                |
| ----------------------------------------- | ---------------------------------------------------- |
| Minimum rectangle side                    | 8 CSS pixels                                         |
| Viewport, source PNG, and crop dimensions | 4,096 px per side; 16,000,000 pixels                 |
| Source screenshot data URL                | 3,000,000 characters                                 |
| Selection lifetime                        | Five minutes                                         |
| Composer images, including the crop       | Four images; 3,000,000 combined binary bytes         |
| Output format                             | One non-empty PNG within remaining composer capacity |

Source data-URL length and composer binary bytes are separate limits. Empty, invalid, stale, mismatched, or oversized images are rejected, not silently downscaled or converted.

Tokens, operation IDs, rectangle state, the temporary full-viewport source, and unsent crops stay in memory. No permission, setting, dependency, persistent store, or session schema is added. Sent crops follow ordinary provider and local transcript retention: up to 50 sessions and 5 MB per session. Delete the containing session to remove its local image; this does not remove provider-held data. See [permissions and storage](permissions-and-storage.md), [security](security.md#region-capture-controls), and [privacy](../PRIVACY.md).

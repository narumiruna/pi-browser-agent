# Capture a region

Select **Capture region**, drag a rectangle, and release the pointer. The crop is attached automatically to the existing composer image previews. Review it, then select **Send** separately. There is no coordinate panel or separate crop-preview dialog.

Region capture limits the attached image, not all agent context. Text, selected-element data, prior history, and separately approved page reads can include content outside the crop. See [verification and external limits](manual-acceptance.md#region-capture-acceptance--2026-11-01).

## Select and attach

1. Wait for an idle conversation and open an accessible HTTP(S) page in the active tab of the focused Chrome window.
2. Select **Capture region**. Approve exact current-site access if requested. Starting selection does not capture or contact a provider.
3. Drag a rectangle at least 8 CSS pixels wide and high. Releasing a valid drag starts local capture and attachment.
   - For keyboard selection, use Arrow keys to move and Shift+Arrow to resize from the top-left corner. The step is 10 CSS pixels, or 1 with Alt. The first Arrow starts a viewport-bounded 200 × 150 rectangle at the top-left and applies that Arrow.
   - Press and release Enter to confirm a keyboard rectangle. Holding Enter, repeated keydowns, synthetic keyup, and edits made before release do not confirm it. Escape cancels. The capture icon also activates on Enter release, not a held keydown.
4. The selected model must accept images, and the composer must have capacity for one more image. These checks do not request provider access or start credential setup.
   - If screenshot access is missing, use the existing screenshot confirmation. Its **Confirm** gesture requests optional Chrome `<all_urls>` access. Denial does not capture or contact a provider.
5. After capture, cropping, and confirmed surface cleanup, one ordinary image appears in the composer. Review or remove it with the existing image controls. To replace it, remove that image and capture again; starting another selection does not remove existing images.
6. Select **Send** when ready. Selection, capture, and local attachment do not send a model request.

The selection surface keeps keyboard focus, blocks target activation and user scrolling, and adds only the selection outline to the page. The existing capture icon has an on-demand tooltip and accessible description for keyboard input and Chrome's temporary full-viewport capture; no additional visible action row is installed. Drawing, element selection, dictation, commands, and session navigation cannot overlap region work. Interface language changes wait until selection, capture, cleanup, and attachment finish.

The surface does not change page-owned content, layout, dialogs, or popovers. An earlier page capture listener can still observe an intercepted event; this is not browser-internal input isolation. Live page content can move during selection and capture. Visible iframe pixels can be included without inspecting iframe DOM.

An already pinch-zoomed or panned visual viewport is not supported. Reset page pinch zoom before starting. This fails before a surface or capture is installed and does not block ordinary chat. Normal browser zoom, native DPR, and CSS zoom remain supported; scrollbar gutters and fractional viewport dimensions alone do not cause rejection.

## What Chrome captures

Chrome first captures a full-viewport PNG in trusted worker memory. The worker decodes it, maps the CSS rectangle to the actual PNG dimensions, and crops it before returning any image to the panel. It rounds left/top edges up and right/bottom edges down. It does not assume a device-pixel ratio or add outside pixels to fill an edge.

The input shield remains active during capture. Only the selection outline is hidden, followed by two animation frames before capture. The crop retains the required slight 1% black shield tint. It excludes the selection outline and Side Panel controls. There is no full-image fallback on failure. The existing full-viewport screenshot tool is unchanged.

The original viewport PNG is not returned in a runtime response, attached, logged, saved in a session, or sent to the provider by this workflow. Only the crop can become an ordinary composer image, and only explicit Send shares it. Owned canvases are reset and decoded bitmaps are closed. This is resource cleanup, not secure memory erasure.

Only trusted input on the owned surface can complete a selection. Notifications are hints: the worker independently checks the live completed revision and geometry before screenshot consent and again before capture. Each completed selection permits at most one capture attempt. Forged, duplicate, incomplete, or stale hints cannot authorize capture or replace a newer selection.

## Cancel and recover

Before attachment, the active capture icon or Escape discards unsent region work. Navigation/reload, tab/window change, scroll, viewport/zoom change, access loss, protection loss, five-minute expiry, panel disconnect, or worker restart cancels live selection and pending capture. Late replies or a late icon keyup cannot revive cancelled work. A held confirmation key cannot become a later Send or activate a previously focused page control.

If local image preflight fails, correct its cause, then draw again or change the keyboard rectangle and confirm it. A failed completion is not retried automatically. If native capture or cropping fails, the rectangle remains editable only while the original context and protection are safe. Confirm that retained rectangle with a fresh Enter press and release, or draw again, for a new capture attempt.

If cleanup cannot be confirmed, attachment and Send stay blocked. The same icon is labeled **Retry region cleanup** when a crop is retained. Restore site access or reload as directed, then select that icon to retry cleanup explicitly. A changed URL or epoch alone is not proof of removal. The worker can reuse a prior successful token-removal acknowledgement only for the same immutable owner and original context; a new operation or worker restart cannot reuse it. Successful cleanup attaches the retained crop without another capture. Escape discards the crop but cannot bypass required cleanup.

If local attachment fails after cleanup, the same icon is labeled **Retry region attachment**. Select it to retry with the retained crop, or press Escape to discard it. This static crop has no live page capability and can survive a later tab change after cleanup; session replacement and panel disposal discard it. No extra preview dialog or recovery panel is shown.

If later submission fails, the ordinary composer image and text remain. Retry Send manually with that same image; do not capture again. History restores only ordinary sent images, not a live rectangle or token. No failed mutation or remote MCP call is automatically replayed.

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

Tokens, operation IDs, completed revisions, rectangle state, the temporary full-viewport source, and unsent crops stay in memory. No permission, setting, dependency, persistent store, or session schema is added. Sent crops follow ordinary provider and local transcript retention: up to 50 sessions and 5 MB per session. Delete the containing session to remove its local image; this does not remove provider-held data. See [permissions and storage](permissions-and-storage.md), [security](security.md#region-capture-controls), and [privacy](../PRIVACY.md).

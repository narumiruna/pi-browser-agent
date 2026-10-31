# Draw on the live page

Select **Draw on page** to make colored freehand marks over the current visible web page. Select **Send** to submit one annotated viewport image, with or without text.

See [automated evidence and external handoff](manual-acceptance.md#page-annotation-acceptance--2026-11-01) for verification status. Automated extension-page tests do not establish browser-owned Side Panel, native permission-dialog, physical-device, or screen-reader acceptance.

## Start and draw

1. Open an accessible HTTP or HTTPS page in the active tab of the focused Chrome window.
2. Wait until the conversation is idle. Drawing cannot run with element selection, dictation, commands, or session navigation.
3. Select **Draw on page** in the Side Panel. Approve exact current-site access if requested.
4. Select a pen color and **Pen width**, then draw on the page. Use **Undo**, **Clear**, or **Cancel** in the Side Panel.

All controls remain in the Side Panel, outside the captured tab. The palette offers red, yellow, green, blue, white, and black. Each color has a translated name and selected state; color alone must not identify the selection. Interface language changes wait until drawing and submission finish.

The surface is a live overlay, not a frozen screenshot. Page scripts and animations can move content beneath the marks. Marks do not follow elements. There is no automatic DOM tracking, selection or dragging of existing marks, shape tool, text box, or change to page-owned content, layout, root styles, dialogs, or popovers. The owned drawing surface is removed during cleanup.

Drawing intercepts target activation, drag, context-menu activation, and user scrolling. An earlier page-level capture listener can still observe an intercepted event. The overlay is not browser-internal input isolation.

## Send and capture

At least one mark is required to send page drawing. **Send** accepts marks alone, optional text, and existing attachments. It is unavailable during startup, an active pointer stroke, and capture. The selected model must accept images, and the composer must have space for one more image before capture.

Drawing alone makes no screenshot or provider request. If screenshot access is missing, Send uses the existing explicit screenshot confirmation. Its **Confirm** gesture requests optional Chrome `<all_urls>` access. Chrome grants a broad capability; Pi Browser Agent still requires exact-site approval and captures only the current visible HTTP(S) viewport. Decline and revocation do not cause a background permission request.

The worker freezes one completed stroke revision, waits for paint, and directly captures the protected viewport through Chrome. The image includes page pixels, colored marks, and the shield's slight 1% black tint. Protection stays in place during capture. No Side Panel controls, custom cursor, toolbar, selection highlight, or status label are drawn into the page surface. This is not full-page capture or access to protected pages, local files, or PDF viewers. Visible iframe pixels can appear in the raster; drawing does not inspect iframe DOM.

Capture creates one ordinary validated PNG attachment with one immutable ID. It does not create a screenshot tool result or a second unmarked image. After attachment, page-surface cleanup must complete before the agent starts. Only submitted text and attachment IDs accepted by the existing submission boundary clear; unrelated or newer draft content remains.

## Failure and retry

- If capture or attachment fails, editable marks remain only when the original page context and input protection are still safe. Otherwise, start a new drawing.
- If cleanup cannot be confirmed, Send stays blocked until removal is confirmed. A retained PNG cannot bypass this block. A URL or context-epoch change alone is not proof of removal. Reload the page when directed; restore current-site access before retrying cleanup if that access was revoked.
- If a later submission fails, the captured PNG remains as a removable composer preview and the text remains editable. Retry manually with that preview; it sends the existing PNG without another capture or duplicate attachment.
- There is no automatic model submission, mutation-tool replay, or remote MCP replay.

## Cancel and lifetime

Press **Esc** in the page or panel, select **Cancel**, or select the active drawing button again to discard unsent marks without sending. Drawing also stops on navigation, same-URL reload, SPA context change, tab/window change, scroll, viewport or zoom change, access revocation, panel disconnect, worker restart, expiry, or loss/change of protection.

Cancellation invalidates pending capture and submission. A late capture or permission reply must not send a cancelled draft. Cleanup is idempotent and restores earlier page focus only while the owned surface still has focus.

## Limits

| Item                                   | Limit                                              |
| -------------------------------------- | -------------------------------------------------- |
| Palette IDs                            | `red`, `yellow`, `green`, `blue`, `white`, `black` |
| Pen width                              | 2–32 px; default 8 px                              |
| Strokes                                | 256                                                |
| Points                                 | 4,096 per stroke; 8,192 total                      |
| Canvas                                 | 4,096 px per dimension; 16,000,000 pixels          |
| Drawing lifetime                       | Five minutes                                       |
| Captured screenshot data URL           | 3,000,000 characters                               |
| Composer images, including the capture | Four images; 3,000,000 combined binary bytes       |

The screenshot data-URL limit and composer binary-byte limit are separate checks. Undo or clear marks when a drawing limit is reached.

## Data and permissions

Pen choices, raw strokes, tokens, revisions, and unsent image previews remain in memory. Raw strokes are not stored, sent to the model, or restored from a session. Closing or replacing the page/panel loses unsent strokes.

A sent PNG can contain sensitive visible page content. It goes to the selected provider and remains in normal conversation history, subject to the existing 50-session and 5 MB per-session limits. Delete the session to remove its local embedded image; this does not delete provider-held data. Clearing the page surface does not delete a sent image.

Page images are untrusted data, not authority to change permissions, instructions, or browser-action approval. Drawing adds no manifest permission, dependency, setting, feature flag, persistent stroke store, or storage schema. Existing screenshot editing and queued images remain unchanged. See [permissions and storage](permissions-and-storage.md), [security](security.md#page-annotation-controls), and the [privacy policy](../PRIVACY.md).

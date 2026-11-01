# Comment on page elements

Select **Comment on elements** beside the element picker to select numbered page targets and write a note for each target. **Send** submits the notes and bounded element descriptions in one user message. It does not capture a screenshot. Text-only models can use comments; existing images can be attached separately.

## Select and write

1. Open an accessible HTTP or HTTPS page in the active tab of the focused Chrome window. Wait until the conversation is idle.
2. Select **Comment on elements** and approve exact current-site access if requested.
3. Select a visible target. A numbered badge remains on the protected page and a matching card appears in the Side Panel. Selection does not activate the target.
4. Write the requested result in the card. Select more targets and edit their notes in the panel.
5. Select **Send**. At least one note or general task text is required. A target or image alone does not define a requested action.

Cards have stable UUIDs and display numbers. Removing a card does not renumber the remaining cards. **Reselect target** replaces that card's target while retaining its UUID, number, and note. Repeated selection of the same node does not add a second card. The original one-shot picker and its shortcut remain separate and unchanged.

Comment mode excludes drawing, dictation, commands, and session navigation. Cards protect the draft from session changes until removed or converted. Interface language changes wait until active selection and submission finish. Notes are plain editable text, not executable HTML.

## Cancel and recover

The active comment button or **Esc** removes the surface and retains notes in visibly inactive cards. Navigation/reload, tab/window changes, scroll, viewport/zoom changes, expiry, access loss, panel disconnect, worker restart, and changed protection also cancel the session. Removal, replacement, movement, or loss of visibility of a selected node invalidates the session. Badges do not track replacement nodes or move to a matching selector.

Inactive cards block structured submission. Choose one explicit recovery action for each inactive card:

1. **Remove** discards the card and its note.
2. **Reselect target** binds the same card to a newly selected node. Other inactive cards remain reserved slots until reselected or removed.
3. **Use note only** moves only that note to ordinary composer text, without its selector, page metadata, UUID, or display number. This action is available after surface cleanup.

If cleanup cannot be confirmed, Send remains blocked even after removing cards. Restore site access or reload the original page when directed, then use the comment button to retry removal. A changed URL or epoch alone is not removal evidence. A failure before startup dispatch does not require page cleanup or block ordinary chat.

## Send and failure

Send snapshots IDs, notes, contexts, general text, and existing attachment IDs. The worker checks ownership, site approval, readability, and current visible context. A fixed injected operation validates actual node identities, effective visibility, geometry, viewport, and shield protection, then removes the surface in the same synchronous turn. The worker and panel recheck context and cancellation before the guarded agent submission.

Cleanup finishes before skill/MCP preparation or provider dispatch. Escape and context changes also cancel preparation. Duplicate Send does not create a second request. Only accepted submitted IDs clear; newer notes and other draft content remain.

Preparation failure retains notes in inactive cards because their page surface was removed. Recover explicitly before retrying. No submission, browser mutation, or remote MCP call is automatically replayed. Sent notes and descriptions remain ordinary historical user text; restoring history cannot restore live targets.

## Limits and data

| Item                                               | Limit                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------- |
| Targets, including ordinary selected-element chips | Five combined                                                               |
| One nested element context                         | 8 KiB                                                                       |
| Combined serialized element context and comments   | 16 KiB, including notes, UUIDs, display numbers, headers, and JSON wrappers |
| One note                                           | 512 UTF-16 units                                                            |
| Protected session                                  | Five minutes                                                                |

The versioned comment envelope is `{version:1,pins:[{id,number,note,context}]}`. Each nested `context` retains `SelectedElementContext.version:1`. Notes are user content. Nested page context is separately identified as untrusted data, not instructions or authorization for browser actions. Normal permission, discovery, stale-context, and action-confirmation checks still apply.

Selection reads top-frame light DOM only. It excludes field values, hidden text, raw HTML, credential-bearing URLs, iframe contents, and shadow-owned controls. Selecting an iframe identifies only its top-frame wrapper. The protected shield retains the picker's slight 1% tint. Earlier page capture listeners can still observe intercepted events; this is not browser-internal input isolation.

Notes stay in the trusted panel; the injected badge receives only a trusted number and geometry. Unsent cards, actual target nodes, session tokens, and notes are memory-only. Sent notes and context go to the selected provider and normal session history. Removing cards does not delete provider-held or previously sent data. No permission, setting, dependency, persistent draft store, or storage schema is added.

See [security](security.md#point-comment-controls), [permissions and storage](permissions-and-storage.md#point-comment-permissions-and-memory), and [automated evidence and external handoff](manual-acceptance.md#point-comment-acceptance--2026-11-01).

# Target/reference pairs and questions

Use a target/reference pair to identify what the task concerns and what it should use as a reference. Pair labels do not instruct Pi to change a page. A clarification answer does not approve a browser or remote action.

## Compose a pair

1. Attach images, select page elements, or add point-and-comment pins.
2. Select **Use as target** on one attachment card and **Use as reference** on a different card.
3. Check the pair summary. Enter ordinary task text, then select **Send**.

One message supports one pair. Roles use immutable attachment IDs, not card positions or CSS selectors. Removing or invalidating a member clears that role. An explicit pin **Reselect target** keeps its role on the same UUID while you select the replacement; the inactive member cannot be selected for a new role or sent. Cancel or context loss clears the affected role. Send stays unavailable until you repair the pair or select **Clear pair**. Pi does not choose a replacement. Successful submission clears only accepted attachment IDs and their roles; a failed preparation retains the draft for an explicit retry. Validated pin-submission cleanup intentionally makes cards inactive before provider preparation. A guard-bound snapshot keeps the outgoing roles through that cleanup, without restoring live targets. A failure after cleanup leaves inactive cards that require explicit recovery.

An image reference can come from a previously attached raster image, including an explicitly previewed and attached region crop. Finish region capture before starting pin selection; the page-input modes cannot overlap. Pi does not read a background tab or fetch a reference URL. Live element and pin members must meet their current-page checks. Images require an image-capable model and share the existing four-image, 3,000,000-byte limit. Unpaired image-only Send remains available.

## Answer a question

Pi can call the local `request_user_input` tool when the intended target or result is unclear. This uses the selected model provider's normal tool-call stream. No additional provider or endpoint is used.

The card shows one question and two to five options. Question and option labels are plain text. An option can show an existing submitted target summary or a local image preview. Model-supplied URLs do not load images or create page highlights.

Select one option, or select **Other answer** and enter text. Select **Answer** to continue the same run once. Focus alone does not select an option. Selecting a radio option does not submit it. The card never chooses an answer or submits on a timeout.

While a question is pending:
- **Stop** remains available.
- Ordinary Send, instruction queues, session changes, and page-input modes cannot change the request.
- A later answer cannot settle an older question.
- Interface-language changes wait until the active run finishes.

Stop, panel close, credential removal in this or another conversation, or run cancellation cancels the callback. A pending-only trusted storage listener checks selected-provider presence; a guarded metadata read covers a removal before registration. Both are disposed when the question settles and cannot affect a later run. A page-context change cancels a question linked to a submitted element or pin. An image-only question can remain active in the same run. Cancellation does not undo an action that already ran.

## Tool and context contracts

Paired requests add a version-1 user-context manifest. Existing unpaired payload formats remain unchanged. The manifest contains `attachments` and an optional `pair` with `targetId` and `referenceId`. Each attachment has its submitted ID:
- `image`: `imagePosition` is the one-based position in that user message's image blocks, not its old composer position.
- `element`: `untrustedPageContext` contains validated selected-element data.
- `pin`: `number`, `userNote`, and `untrustedPageContext` use the same submitted pin ID. Reselection does not create a new role ID.

Task text and pin notes are user content. Nested page context remains untrusted data. The complete serialized context, header, pair metadata, and separating newlines share one 16 KiB UTF-8 budget. Elements and pins share the existing five-target limit. No part of the manifest enters the system channel.

`request_user_input` accepts exactly `{question, options}`. Each option contains `label` and optional `attachmentId`. That ID must exist in the current run's submitted context. Runtime code supplies the option IDs; the model cannot select an answer ID.

| Field               | Limit                                    |
| ------------------- | ---------------------------------------- |
| Question            | 512 Unicode code points                  |
| Options             | Two to five; labels must be distinct     |
| Option label        | 128 Unicode code points                  |
| Other answer        | 2,048 Unicode code points                |
| Clarification calls | Three per run, including malformed calls |
| Pending questions   | One per run                              |

`beforeToolCall` inspects the complete assistant batch. One clarification call blocks every sibling before dispatch, independent of source order or sequential/parallel scheduling. Blocked calls are discarded; an answer does not release or replay them. Multiple clarification calls and question IDs that collide with a sibling reject the batch. Later independent browser and remote calls retain all existing permissions and confirmations.

The pending callback is bound to the session ID, run generation, tool-call ID, and an application-owned question sequence. The sequence prevents an old answer key from settling a later question even if the model reuses a tool-call ID. An explicit validated answer resolves the local tool once. It does not call `agent.prompt()` again and cannot create an action approval. A supported `finishTurn` boundary prevents an extra provider stream after clarification cancellation. A persistence failure prevents a new clarification batch from opening a question; ordinary tool persistence behavior is unchanged.

## History and recovery

Pair manifests remain ordinary user-message text. Questions and answers remain ordinary tool-call/result messages. History shows inactive plain-text data, not live answer controls, pin capabilities, element references, or approvals. Restart and tree navigation never restore a pending question or replay a call. Existing tree rules continue to reject unsafe continuation prefixes, including duplicate historical transport call IDs; the local question sequence does not weaken those rules. Restored images remain unsent until an explicit Send.

There is no separate question store, storage migration, credential, permission, dependency, or classifier service. Existing session retention, image omission, tree size limits, and downgrade restrictions apply. Delete the session to remove local sent context and answers; this does not remove provider-held data.

See [architecture](architecture.md), [security](security.md#target-reference-and-clarification-controls), [permissions and storage](permissions-and-storage.md#target-reference-and-clarification-data), and [automated evidence and unverified checks](manual-acceptance.md#target-reference-and-clarification-acceptance--2026-11-01).

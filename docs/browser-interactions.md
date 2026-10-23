# Browser interaction tools

These tools use the current active HTTP(S) tab in the focused Chrome window. They require the same Chrome host permission and app-approved site access as other page tools. A no-page turn cannot use them. They add no permission, stored setting, arbitrary JavaScript input, iframe access, or Shadow DOM traversal.

All objects reject unknown properties. References consist of both `snapshotId` (36-character snapshot ID) and `ref` (such as `e1`, at most eight characters) from `browser_list_elements`. Reference actions and option reads do not accept CSS selectors. New text-search and condition-wait selectors accept at most 2,048 Unicode code points. Their string inputs follow JSON Schema character counts; existing selector-based tools keep their existing UTF-16 limits.

## Discovery and reference lifetime

`browser_list_elements({})` scans at most 2,000 top-frame light-DOM elements and returns at most 50 visible controls and vertical scroll containers. Optional `role` and `type` filters are exact, case-sensitive strings of at most 64 Unicode code points. Optional `name` is a case-sensitive literal substring of the returned bounded name, at most 256 Unicode code points. Returned names retain the existing 256-UTF-16-unit bound. Optional `offset` is a matching-result ordinal from 0 to 2,000, not a DOM-node index. `type` is the native input/button type, or an empty string for other elements. Empty filters retain their literal meaning. Filters do not increase the scan budget.

The result includes `elements`, `snapshotId`, `offset`, `hasMore`, and `scanTruncated`. `nextOffset` is present only when another result page is available within the scan. `scanTruncated` separately reports exhausted traversal bounds; pagination does not authorize a scan beyond them. The compatibility `truncated` flag is true when either indicator is true. Structured output is capped at 48 KB. Each page is a new discovery and replaces the previous snapshot; references from different pages cannot be combined. An independently scrolling `<body>` can also be discovered. Containers must have overflowing content, positive client height, computed vertical overflow `auto`, `scroll`, or `overlay`, and a visible hit-test point. Hidden, covered, clipped, password, and file targets remain excluded. A container can return `actions: ["scroll"]` without being clickable. Native single selects also advertise `selectOption`. Each result includes scroll dimensions and positions in `scrollability`.

Each discovery replaces the previous snapshot. References expire after five minutes, navigation, tab/focus changes, or worker restart. A successful `browser_scroll` or `browser_select_option`, or an actual `browser_set_checked` activation, invalidates **all** references in both the worker and isolated-world registry. This includes a scroll at a boundary and selection of an already selected option. Call `browser_list_elements` again before another reference action. Manual page changes do not renew references; each operation still checks node identity, action metadata, and target visibility.

A stale reference returns `STALE_CONTEXT`. Do not substitute another element, guess a selector, or automatically repeat a mutation. Rediscover and review the intended action.

## `browser_find_text`

Input is `{query, selector?, offset?}`. `query` is a non-empty, case-sensitive literal string of at most 256 Unicode code points. No code or regular expression is accepted. The optional selector scopes the read to its first HTML match; invalid, missing, or non-rendered scopes fail rather than reading the full page. Without a selector, the scope is the page body. `offset` is a non-overlapping match ordinal from 0 to 100,000, not a character offset.

Search reads rendered, non-editable top-frame text, including offscreen page text. Hidden, clipped, sensitive, editable, script, and style content is excluded. Within each Text node, whitespace runs become one ASCII space; leading and trailing spaces are not removed. Matches do not cross Text-node boundaries or excluded/clipped runs. This is not a whole-page `innerText` search: `Alpha <b>beta</b>` cannot match the query `Alpha beta` across nodes. Effective editability, including `document.designMode`, excludes text. Any non-default CSS `clip`, `clip-path`, or mask image on a box-generating ancestor excludes its text conservatively, even when some text could be visible; clipping shapes are not interpreted. Hidden content visibility is excluded. Overflow uses the client/padding clip box, including independently scrolling bodies and exposed slot ancestors. Rounded overflow clips, rotated/skewed/flipped transforms, and 3D transforms are excluded conservatively. Positive axis-aligned scales and translations are supported. Boxless `display: contents` ancestors do not apply overflow, opacity, content visibility, transforms, filters, or masks to descendant text. Explicit hidden/ARIA-hidden exclusions still apply; effective visibility respects visible descendant overrides.

Each match has a snippet of at most 256 UTF-16 units, `start` and exclusive `end` source offsets, and optional viewport-relative `rect` geometry. Source offsets count UTF-16 units in raw Text-node traversal within the scope, including excluded nodes. They are not offsets in normalized snippets, HTML, or a stable DOM identity. DOM changes can change offsets and result ordinals between calls.

Each call examines at most 2,000 text nodes and 100,000 source UTF-16 units, including excluded text, and returns at most 50 matches within 48 KB. `hasMore` and optional `nextOffset` describe result pagination; `scanTruncated` describes traversal exhaustion. Search does not scroll, highlight, click, create mutation references, or replace/renew a snapshot.

```text
browser_find_text({"query":"Ready","selector":"main"})
```

## `browser_wait_for`

Supply exactly one condition:
1. `{selector, state, timeoutMs?}`, where state is `present`, `absent`, `visible`, `hidden`, `enabled`, or `disabled`.
2. `{text, selector?, timeoutMs?}`, for the same literal rendered-text presence rules as `browser_find_text`.

`state` and `text` cannot be combined. Text is non-empty and at most 256 Unicode code points. The timeout defaults to 5,000 ms and accepts integers from 1 to 10,000 ms. The worker probes immediately, then polls every 250 ms with cancellable delays. It accepts no custom interval, code, or regular expression.

Selector conditions inspect the first match. `present` means it exists; `absent` means it does not. `visible` uses current discovery visibility rules; `hidden` means missing or not visible. `enabled` means visible and neither natively nor ARIA disabled; `disabled` means an existing visible target that is natively or ARIA disabled. Missing targets satisfy only `absent` and `hidden`. Sensitive controls remain denied; probes do not read editable values.

A successful result reports `matched: true` and `elapsedMs`. `TIMEOUT` means the condition was not observed, not that Chrome denied access. Waits keep the original tab, URL, and epoch. Navigation, tab/focus changes, cancellation, or permission loss fail closed; a wait never follows a new document. Invalid selectors and invalid/missing text scopes fail without a whole-page fallback. Waits do not scroll or replace/renew element references.

```text
browser_wait_for({"selector":"#save","state":"enabled","timeoutMs":3000})
browser_wait_for({"text":"Saved","selector":"main"})
```

On timeout, inspect the current page before deciding whether to wait again. On a stale context, return to the intended document and start a new request.

## `browser_get_select_options`

Input is `{snapshotId, ref, offset?}` for a fresh, visible native single-select reference. `offset` is a native option index from 0 to 2,000. `nextOffset` also uses native option indices, not returned-entry counts; hidden entries can create gaps. Selects with more than 2,000 options, multiple selection, or a listbox size above one return `NOT_SUPPORTED`. The result contains at most 50 options within 48 KB, with `hasMore`, optional `nextOffset`, and `scanTruncated: false` indicators.

Each option contains only `label`, zero-based `index`, effective `disabled`, and `labelTruncated`. Disabled groups make their options disabled. Hidden options and options in hidden groups are excluded by hidden/ARIA-hidden and computed display, visibility, opacity, and filter metadata. Their native indices are not renumbered. This is a narrow label-only exception to the form-content read exclusion: no raw option values, selected flags, selected value, or selected index are returned. Labels use the native `option.label`, including an explicit label attribute. Labels longer than 256 UTF-16 units are bounded and marked `labelTruncated: true`; do not treat them as exact selectable labels.

Option reads need no action confirmation and do not replace, renew, or invalidate the snapshot. Catalog changes or node replacement make the reference stale. Select a unique, untruncated returned label with the existing `browser_select_option`; duplicate labels fail rather than choosing an arbitrary option.

```text
browser_list_elements({"role":"combobox"})
browser_get_select_options({"snapshotId":"<snapshotId>","ref":"e1"})
browser_select_option({"snapshotId":"<snapshotId>","ref":"e1","label":"English"})
```

## `browser_set_checked`

Input is exactly `{snapshotId, ref, checked}` with a boolean `checked`. Only native checkbox and radio inputs are supported. Checkboxes accept either state; radios accept `true` only, even if an unchecked radio would otherwise be a no-op. ARIA-only controls, disabled targets, and hidden targets are not supported activation targets.

An already matching supported state returns `changed: false` without confirmation, activation, events, or snapshot invalidation. Every actual change requires fresh confirmation in **all** confirmation modes. No remembered approval applies: click/input/change handlers can submit, navigate, remove the target, or reverse its state.

After confirmation, the operation rechecks the same node, state, radio-group identity, metadata, visibility, permission, context, and cancellation. Changed approval-relevant state requires fresh discovery and confirmation. Checkbox/radio payload values are compared privately and never returned. Radio groups bind live member identities and states; if the 2,000-element group-validation scan is incomplete, activation returns `NOT_SUPPORTED`. A change uses one native DOM `click()` activation, not a checked setter plus a second click. This is DOM activation, not trusted native pointer input. Radio activation can uncheck the other group member. Cancelled click default behavior can roll back the tentative state and suppress input/change events.

Every actual activation invalidates all references, even if handlers reverse the state. The result fields are:
- `changed` and `activated`: false for a no-op; true after activation, including a cancelled or reversed change. They do not guarantee the requested final state.
- `finalStateVerified`: whether a final state check was possible.
- `requestedReached`: the observed comparison with the requested state, or `null` when unverified.
- `checked`: observed final state, present only when verified.
- `snapshotInvalidated`: true after activation; false for a no-op.

The result reports the observed final checked state when available. Removal or navigation can make the final state unverified after activation; this is not a pre-execution rejection or permission to retry. Never replay automatically. Read current state and rediscover before any new user-authorized change.

```text
browser_list_elements({"type":"checkbox","name":"Subscribe"})
browser_set_checked({"snapshotId":"<snapshotId>","ref":"e1","checked":true})
```

## `browser_scroll`

| Input               | Type    | Rule                                                                                    |
| ------------------- | ------- | --------------------------------------------------------------------------------------- |
| `direction`         | string  | Required: `up` or `down`.                                                               |
| `amount`            | string  | Required: `page`, `half-page`, or `pixels`.                                             |
| `pixels`            | integer | Required only for `amount: "pixels"`; 1–10,000 CSS pixels. Rejected with other amounts. |
| `snapshotId`, `ref` | strings | Omit both for the viewport. Supply both for a discovered inner container.               |

A page is the target's visible height: `window.innerHeight` for the viewport or `clientHeight` for a container. A half-page is half that height. Scrolling uses a fixed native `scrollTo` operation with instant behavior, preserves the horizontal position, and clamps the requested vertical position to the target's range. It does not click, focus, or dispatch keyboard events. It needs no action confirmation and cannot request site access in the background.

The result contains:
- `distance`: actual signed vertical CSS pixels moved; negative means up.
- `position`, `minPosition`, `maxPosition`: resulting vertical position and current range. Ordinary containers start at zero. An inner `column-reverse` flex container has a negative minimum and a maximum of zero; up/down still means physical up/down. The viewport keeps non-negative coordinates even when its root uses reverse flex layout.
- `atTop`, `atBottom`: current boundaries; bottom uses a one-pixel tolerance for fractional layout. A non-overflowing viewport is at both boundaries.
- `viewport`: `width`, `height`, `scrollX`, and `scrollY` for the outer viewport, including after container scrolling.
- `url`, bounded `title`, and `snapshotInvalidated: true`.

A container that is no longer vertically scrollable returns `NOT_SUPPORTED`. A hidden target returns `INVALID_REQUEST`. The fixed operation accepts no page JavaScript. Normal site scroll handlers can still react to scrolling or load content. Returned geometry is the immediate position, not a guarantee that later page scripts will leave it unchanged.

### Agent example

```text
browser_scroll({"direction":"down","amount":"half-page"})
browser_capture_visible({})
browser_list_elements({})
```

For an inner container, use its newly discovered snapshot and reference:

```text
browser_scroll({"snapshotId":"<snapshotId>","ref":"e3","direction":"up","amount":"pixels","pixels":240})
browser_capture_visible({})
browser_list_elements({})
```

`browser_capture_visible` retains its separate screenshot permission and first-capture confirmation. Scrolling does not grant that permission.

## `browser_select_option`

| Input               | Type    | Rule                                                                 |
| ------------------- | ------- | -------------------------------------------------------------------- |
| `snapshotId`, `ref` | strings | Required discovered native `<select>` reference.                     |
| `value`             | string  | Exact option value, at most 256 characters. Empty string is allowed. |
| `label`             | string  | Exact native option label, at most 256 characters.                   |

Supply exactly one of `value` or `label`. A match must identify exactly one option. Missing or duplicate matches return `INVALID_REQUEST`. Non-select targets, multiple selects, or selects with more than 2,000 options return `NOT_SUPPORTED`. Disabled controls, options, and option groups return `PERMISSION_DENIED`.

Every valid selection requires fresh confirmation in every confirmation mode. Page `input` or `change` handlers can submit forms, navigate, or perform other actions. No event is sent before confirmation. The operation revalidates the reference, control state, option metadata, site access, visible tab, and cancellation before changing the native selected index. It then emits bubbling `input` and `change` events. It does not click a submit button or use synthetic keyboard input.

The result contains `selected: true`, the original reference, and `snapshotInvalidated: true`. It does not return field values or an option catalog; use `browser_get_select_options` for the label-only catalog. Interrupted or failed calls are never replayed automatically. Confirmation cannot undo page event-handler effects.

### Agent example

Use a fresh element list and an explicit option requested by the user:

```text
browser_list_elements({})
browser_select_option({"snapshotId":"<snapshotId>","ref":"e2","label":"English"})
```

Wait for confirmation and the result. Then capture or read the page and rediscover before another reference action. Use `value` instead of `label` only when the exact option value is known.

## `browser_get_element_details`

Input is exactly `snapshotId` and `ref`. It needs no action confirmation. The result is untrusted page data and includes:
- `name`: the existing bounded DOM-derived accessible-name approximation, up to 256 characters.
- `role`: bounded explicit role or a native role for supported controls; otherwise `generic`.
- `visible`: whether a sampled point is currently visible under the existing discovery rules.
- `rect`: viewport CSS-pixel `x`, `y`, `width`, `height`, `top`, `right`, `bottom`, and `left`.
- `state`: `disabled`, `readOnly`, `required`, and `focused` booleans; native checkbox/radio `checked` boolean; otherwise allowlisted ARIA `checked`, `expanded`, and `selected` strings (`true`, `false`, or `mixed`) or `null` when absent/invalid.
- `scrollability`: `vertical` and `horizontal` booleans, `scrollTop`, `scrollLeft`, `scrollHeight`, `scrollWidth`, `clientHeight`, and `clientWidth`.

The accessible name follows existing discovery conventions, not the complete browser accessibility-tree algorithm. Details do not include HTML, editable text, field values, passwords, or file data. Password/file targets are not discoverable and remain denied if a target changes. Details do not renew or invalidate a snapshot. Replaced or changed targets return `STALE_CONTEXT`; hidden targets can also become stale if their name changes.

### Agent example

```text
browser_list_elements({})
browser_get_element_details({"snapshotId":"<snapshotId>","ref":"e3"})
```

Use `scrollability.vertical` and the advertised `scroll` action to identify an inner scroll container. Inspect the resulting viewport with `browser_capture_visible` after scrolling.

## Deferred input tools

`browser_press_key` and `browser_hover` are not exposed. The current bridge executes fixed isolated-world DOM operations; it has no native keyboard or pointer input channel. Synthetic `KeyboardEvent` dispatch does not implement browser default navigation or trusted activation. Synthetic pointer events do not establish CSS `:hover` or reliably open native tooltips. Adding those tools requires a separate native-input design with permission and protected-action checks; no debugger permission is added here.

## Validation

Unit tests cover matching schemas/runtime validation, bounds, viewport/container geometry, boundary invalidation, unsupported targets, confirmation ordering, option changes, and secret exclusion. Worker integration tests cover site access, stale references, final mutation guards, and read cancellation. `tests/e2e/browser-interactions.spec.ts` uses only a local fixture and real Chrome layout for viewport and nested scrolling, visibility after scroll, details, and confirmed native selection. `tests/e2e/browser-action-foundations.spec.ts` adds standalone Chromium semantics fixtures and extension scenarios for filtered discovery, literal text search, waits, label-only option reads, checked activation, and mocked model confirmations. These tests use local fixtures, not a real admin page.

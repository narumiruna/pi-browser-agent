# Browser interaction tools

These tools use the current active HTTP(S) tab in the focused Chrome window. They require the same Chrome host permission and app-approved site access as other page tools. A no-page turn cannot use them. They add no permission, stored setting, arbitrary JavaScript input, iframe access, or Shadow DOM traversal.

All objects reject unknown properties. References consist of both `snapshotId` (36-character snapshot ID) and `ref` (such as `e1`, at most eight characters) from `browser_list_elements`. The new tools do not accept CSS selectors.

## Discovery and reference lifetime

`browser_list_elements({})` scans at most 2,000 top-frame light-DOM elements and returns at most 50 visible controls and vertical scroll containers. An independently scrolling `<body>` can also be discovered. Containers must have overflowing content, positive client height, computed vertical overflow `auto`, `scroll`, or `overlay`, and a visible hit-test point. Hidden, covered, clipped, password, and file targets remain excluded. A container can return `actions: ["scroll"]` without being clickable. Native single selects also advertise `selectOption`. Each result includes scroll dimensions and positions in `scrollability`.

Each discovery replaces the previous snapshot. References expire after five minutes, navigation, tab/focus changes, or worker restart. A successful `browser_scroll` or `browser_select_option` invalidates **all** references in both the worker and isolated-world registry. This includes a scroll at a boundary and selection of an already selected option. Call `browser_list_elements` again before another reference action. Manual page changes do not renew references; each operation still checks node identity, action metadata, and target visibility.

A stale reference returns `STALE_CONTEXT`. Do not substitute another element, guess a selector, or automatically repeat a mutation. Rediscover and review the intended action.

## `browser_scroll`

| Input | Type | Rule |
| --- | --- | --- |
| `direction` | string | Required: `up` or `down`. |
| `amount` | string | Required: `page`, `half-page`, or `pixels`. |
| `pixels` | integer | Required only for `amount: "pixels"`; 1–10,000 CSS pixels. Rejected with other amounts. |
| `snapshotId`, `ref` | strings | Omit both for the viewport. Supply both for a discovered inner container. |

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

| Input | Type | Rule |
| --- | --- | --- |
| `snapshotId`, `ref` | strings | Required discovered native `<select>` reference. |
| `value` | string | Exact option value, at most 256 characters. Empty string is allowed. |
| `label` | string | Exact native option label, at most 256 characters. |

Supply exactly one of `value` or `label`. A match must identify exactly one option. Missing or duplicate matches return `INVALID_REQUEST`. Non-select targets, multiple selects, or selects with more than 2,000 options return `NOT_SUPPORTED`. Disabled controls, options, and option groups return `PERMISSION_DENIED`.

Every valid selection requires fresh confirmation in every confirmation mode. Page `input` or `change` handlers can submit forms, navigate, or perform other actions. No event is sent before confirmation. The operation revalidates the reference, control state, option metadata, site access, visible tab, and cancellation before changing the native selected index. It then emits bubbling `input` and `change` events. It does not click a submit button or use synthetic keyboard input.

The result contains `selected: true`, the original reference, and `snapshotInvalidated: true`. It does not return field values or an option catalog. Interrupted or failed calls are never replayed automatically. Confirmation cannot undo page event-handler effects.

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

Unit tests cover matching schemas/runtime validation, bounds, viewport/container geometry, boundary invalidation, unsupported targets, confirmation ordering, option changes, and secret exclusion. Worker integration tests cover site access, stale references, final mutation guards, and read cancellation. `tests/e2e/browser-interactions.spec.ts` uses only a local fixture and real Chrome layout for viewport and nested scrolling, visibility after scroll, details, and confirmed native selection. It does not use a real admin page.

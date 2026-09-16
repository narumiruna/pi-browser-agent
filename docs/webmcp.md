# WebMCP status and adapter decision

Review date: 2026-09-16.

## Status reviewed

WebMCP is a proposed web standard, not a stable Chrome extension transport. Chrome's documentation lists it as an origin trial beginning in Chrome 149 and provides `chrome://flags/#enable-webmcp-testing` for local development. It is designed for local, human-in-the-loop browser workflows and remains subject to change.

The current explainer uses `document.modelContext.getTools()` and `document.modelContext.executeTool()`. Earlier prototypes used `navigator.modelContext`, so this bridge checks both shapes and prefers `document.modelContext`. The explainer also defines a `toolchange` event for dynamic registration.

Sources:

- [Chrome WebMCP documentation](https://developer.chrome.com/docs/ai/webmcp)
- [WebMCP explainer and draft design](https://github.com/webmachinelearning/webmcp)
- [Chrome implementation status](https://chromestatus.com/feature/5117755740913664)

## Spike result

The API is not reliable enough to be a required part of the product:

- it requires an origin-trial token or a local Chrome flag at the reviewed implementation stage;
- support depends on page origin isolation and the `tools` permissions policy;
- ordinary stable/headless Chrome fixtures do not expose the API by default;
- the API shape has changed during development.

Therefore loopback WebSocket remains the Chrome-to-pi transport. The core DOM adapter has no WebMCP dependency.

A progressive adapter is included because the discovery/invocation contract can be isolated and tested:

- `browser_webmcp` is one stable pi tool with `list` and `call` actions;
- the page API is detected at call time, so pages without it return `NOT_SUPPORTED`;
- tools are listed fresh on each request, so registrations reflected by `toolchange` appear without a persistent cache;
- tool definitions are serialized to bounded JSON rather than permanently registered as pi tools;
- every call requires pi confirmation because a page tool may mutate account or page state;
- the adapter does not request cross-origin frame tools.

## Verification matrix

| Environment | Expected result | Evidence |
| --- | --- | --- |
| Normal Playwright Chromium, no flag/token | `webmcp.listTools` returns `NOT_SUPPORTED`; DOM tools still work | Browser E2E and unit fallback test |
| Synthetic `document.modelContext` fixture | Lists tools, reflects a changed registry, and calls a selected tool after confirmation | Adapter unit tests |
| Legacy synthetic `navigator.modelContext` | Detected as a compatibility fallback | Adapter feature detection |
| Chrome 149+ origin trial or testing flag | Expected to use `document.modelContext`; not required for release acceptance | Not exercised in automated CI |

## Revisit criteria

Re-evaluate the adapter when WebMCP ships by default in stable Chrome. At that point, verify the final API types, extension execution-world access, permissions-policy behavior, cross-frame exposure rules, confirmation UX, and output limits before declaring the capability generally available.

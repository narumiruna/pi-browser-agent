# WebMCP

WebMCP is an optional page capability, not an extension transport.

The bound-page adapter checks `document.modelContext` and the legacy `navigator.modelContext` shape at call time. `browser_webmcp` can list available page tools or call one registered tool. Every call requires explicit Side Panel confirmation and executes sequentially with `replay: "never"`. In the tested Chrome 153 build, native `executeTool` requires JSON-encoded argument text; the adapter serializes the confirmed arguments once and never retries a call.

To use WebMCP, open `chrome://flags/#enable-webmcp-testing`, enable the flag, relaunch Chrome, and reload the page. The page must also register WebMCP tools. To test locally, visit `https://otter.narumi.dev/webmcp-test` and wait until the status says that two read-only demo tools are registered before requesting `browser_webmcp` with `action: "list"`. If the page says `document.modelContext` is missing, the browser has not exposed WebMCP to the page; the extension cannot register its tools on the page's behalf.

Tool definitions and results are page-controlled, JSON-normalized, size-bounded by extension messaging and session limits, and labeled as untrusted before model use. If WebMCP is unavailable, the tool returns `NOT_SUPPORTED`; ordinary DOM tools continue to work.

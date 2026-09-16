# WebMCP

WebMCP is an optional page capability, not an extension transport.

The bound-page adapter checks `document.modelContext` and the legacy `navigator.modelContext` shape at call time. `browser_webmcp` can list available page tools or call one registered tool. Every call requires explicit Side Panel confirmation and executes sequentially with `replay: "never"`.

Tool definitions and results are page-controlled, JSON-normalized, size-bounded by extension messaging and session limits, and labeled as untrusted before model use. If WebMCP is unavailable, the tool returns `NOT_SUPPORTED`; ordinary DOM tools continue to work.

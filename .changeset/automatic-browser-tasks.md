---
"pi-browser-agent": patch
---

Save the public extension ID once in the Pi user file `pi-browser-agent.json`. Reuse it on later connections without another input prompt. After explicit connection consent, start Pi-to-Browser tasks without repeated Pi task confirmation or Browser Send. Preserve provider/site permission gestures, browser-action confirmations, cancellation, draft protection, and non-replay checks. Require fresh consent through local API version 2 and a new session-storage key; do not migrate old draft-only approval.

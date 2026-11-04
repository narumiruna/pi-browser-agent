---
"pi-browser-agent": patch
---

Add optional project-local Pi ↔ Browser text tasks that keep Pi in WSL and attach through a Windows Bun helper to existing Windows Chrome and its user-enabled loopback CDP endpoint. Require explicit profile trust, native Chrome approval, Browser Settings approval for automatic incoming tasks, Pi inbox acceptance, and confirmed selected replies. Preserve browser permissions and action checks, redact known provider values from outgoing Browser task text and selected answers, and keep helper/process/CDP code outside the production browser artifact. Detach and revoke the owned local connection when possible without closing Chrome, tabs, or the existing profile; never reconnect or replay tasks automatically. No new browser, profile copy, project server, port forwarding, Native Messaging registration, or external relay is used.

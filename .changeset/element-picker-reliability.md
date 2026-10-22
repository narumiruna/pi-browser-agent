---
"pi-browser-agent": patch
---

Fix element-picker startup during unrelated tab navigation and selection over page modals and iframes. Protect the viewport shield from page CSS, preserve legacy Chrome zoom geometry and forced-colors support, report protection failures, and prevent stale startup cleanup from stopping a replacement picker. Iframe contents and shadow-owned controls remain unsupported; permissions and storage are unchanged.

# Chrome Web Store Listing — Pi Browser Agent

Last updated: 2026-11-15

Status: draft. This file does not establish store readiness or a prior store submission.

## Store listing

- Extension name: Pi Browser Agent.
- Short description: A Chrome-native AI assistant for the page you are viewing.
- Category: Productivity (proposed; publisher approval required).
- Single purpose: Help users ask questions about the page they are viewing and complete approved browser tasks.
- Primary language: English, with 18 bundled interface languages.

### Detailed description draft

Ask questions about the page you are viewing and complete browser tasks with an AI provider you select.

Read page text, point to an element, attach images, capture a visible region, or draw on a page before sending it. Translate pages, selected text, YouTube captions, or explicitly selected/approved PDFs from the native context menu, with independent translation settings. Review protected browser actions before they run. Optional bookmark access lets the assistant find matching or recent bookmarks. You can also configure remote tools or import reviewed text skills.

Open the Side Panel, choose a provider and model, add a credential, and send a prompt. Conversations remain in your Chrome profile until removed. Close other conversation windows before clearing all session data.

Prompts, approved page content, images, and tool results can be sent to your selected provider. Optional remote tools receive confirmed arguments. Page-text reads exclude form controls and editable drafts; separately approved screenshots can still contain sensitive visible pixels. Escape rejects an open action confirmation and cancels device login. Cancellation cannot undo an operation already sent.

Support: https://github.com/narumiruna/pi-browser-agent/issues

## Graphics and assets

| Asset                    | Dimensions     | Status                                                                  | File                                             |
| ------------------------ | -------------- | ----------------------------------------------------------------------- | ------------------------------------------------ |
| Store icon               | 128 × 128 PNG  | File and dimensions verified                                            | `icons/icon-128.png`                             |
| Screenshot 1             | 1280 × 800 PNG | File and dimensions verified; publisher must review current UI accuracy | `store-assets/pi-browser-agent-screenshot-1.png` |
| Additional screenshots   | Not supplied   | Optional                                                                | None                                             |
| Small promotional tile   | Not supplied   | Optional                                                                | None                                             |
| Marquee promotional tile | Not supplied   | Optional                                                                | None                                             |

The integration adds a Translation Settings panel, compact translation controls, native menu actions, and a separate PDF reader. Before submission, refresh and review screenshots for these views without credentials, signed URLs, or private content.

## Permissions justification

The production manifest has no required host permission.

| Permission or pattern       | Declaration              | User-facing purpose                                                                                                                                                                                    |
| --------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `activeTab`                 | Required API permission  | Temporarily access the page after the user invokes the extension.                                                                                                                                      |
| `contextMenus`              | Required API permission  | Send selected text to chat or explicitly start page, selection, subtitle, or PDF translation.                                                                                                          |
| `scripting`                 | Required API permission  | Read bounded page information and perform fixed approved actions on the current page.                                                                                                                  |
| `sidePanel`                 | Required API permission  | Display the assistant beside the current page.                                                                                                                                                         |
| `storage`                   | Required API permission  | Keep settings, credentials, reviewed skills, and pending selected text in the Chrome profile.                                                                                                          |
| `tabs`                      | Required API permission  | Identify the active page and follow tab or window changes without reading background page content.                                                                                                     |
| `bookmarks`                 | Optional API permission  | Search matching bookmarks or read a bounded recent list after approval. No bookmark editing tool is exposed.                                                                                           |
| `https://auth.openai.com/*` | Optional host permission | Complete and refresh an explicitly selected OpenAI Codex account login.                                                                                                                                |
| `https://chatgpt.com/*`     | Optional host permission | Use the selected Codex account and separately confirmed image generation.                                                                                                                              |
| `http://*/*`                | Optional host permission | Support user-selected HTTP pages and provider endpoints after exact-site approval.                                                                                                                     |
| `https://*/*`               | Optional host permission | Support approved pages, providers/authentication, PDF sources, subtitle acquisition, public remote tools, and explicit GitHub skill reads.                                                             |
| `<all_urls>`                | Optional host permission | Meet Chrome's visible-tab screenshot requirement after temporary access expires. Requested only from screenshot confirmation; runtime checks still limit capture to the active visible supported page. |

## Privacy and data use

The extension handles user data and can transmit it off-device. It has no developer-operated backend, advertising, or analytics. The publisher must confirm the final dashboard disclosures against `PRIVACY.md` before submission.

| Data type                                               | Handling and transmission                                                                                                                                                 | Purpose                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Authentication information                              | Provider credentials remain in trusted local storage and authenticate only to the associated provider. Remote-tool tokens authenticate only to their configured endpoint. | User-selected authentication.                   |
| Personal communications and website content             | Prompts, responses, approved page reads, images, bookmark results, and tool results can reach the selected provider and local conversation history.                       | Answer questions and complete requested tasks.  |
| Browsing information                                    | Current-page URLs, bounded current-window tab metadata, and optional bookmark results can be shared for a requested task. There is no continuous history collection.      | Identify and use the intended page or bookmark. |
| User activity                                           | Confirmed browser actions and tool arguments can reach the current site or configured remote server.                                                                      | Complete approved tasks.                        |
| Identifying, health, financial, or location information | May occur in user-supplied prompts, approved website content, screenshots, or tool results. No separate background collection is implemented.                             | Only the task for which that content is shared. |

Data-use statements from `PRIVACY.md`: data is not sold, used for advertising or creditworthiness, or used for purposes unrelated to the extension. The publisher must complete the store certification.

Translation shares extracted text with its selected provider without a chat turn. Passwords/original PDF bytes remain in memory; translated PDF blocks use a separate bounded cache, and signed remote source URLs can use trusted tab-bound session records. Model output is text. Packaged PDF.js decoder assets require CSP `wasm-unsafe-eval`, not JavaScript `unsafe-eval`, remote scripts, OCR, or exported translated PDFs. See `docs/translation.md` for limits and retention.

Full-page and scoped text reads exclude form controls and editable subtrees. Selecting a non-editable child does not bypass an editable ancestor. Clearing all conversations refuses while another conversation owns a session, so that conversation cannot restore deleted local data. Deleting local data cannot retract provider-held data.

## Privacy policy

Repository policy: `PRIVACY.md`.

Proposed public URL: https://github.com/narumiruna/pi-browser-agent/blob/main/PRIVACY.md

Public availability and suitability for the store form have not been verified in this work. The publisher must verify the live URL before submission.

## Distribution and developer information

- Visibility and regions: publisher decision required.
- Publisher name and public contact email: publisher input required.
- Support URL: https://github.com/narumiruna/pi-browser-agent/issues
- Homepage: https://github.com/narumiruna/pi-browser-agent

## Version history

The source manifest remains at `0.12.0`. The release workflow assigns the next version from the pending changesets; this integration does not publish or tag a release.

| Version    | Date       | Changes                                                                                                                                                 | Status                                                             |
| ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Next minor | 2026-11-15 | Integrate native-menu page/selection/subtitle/PDF translation, independent settings, local PDF assets, and shared browser account adapters.             | Draft; live Anthropic and other retained release gates remain open |
| Next patch | 2026-11-12 | Fix confirmation dismissal, page-text privacy, context invalidation, cancellation, conversation clearing, selected-text delivery, and credential flows. | Draft; not submitted                                               |

## Review notes

Rebuild with the repository's locked dependencies. Local production verification for this integration used Node.js 24.22.1, npm 11.19.1, and Extension.js 4.1.39.

The declared Chrome 116 minimum has an unresolved startup limitation recorded in `docs/manual-acceptance.md`. Newer Chromium tests do not establish minimum-version acceptance. Native permission prompts, physical devices, and real provider authentication remain owner acceptance checks. Do not weaken trusted-storage restrictions to bypass the limitation.

The changed Anthropic account flow must not be released until authorized live sign-in, cancellation, and refresh pass. Other live-provider policies, a real-time YouTube soak, physical native menus/permissions, assistive technology, and native-language review remain unverified. Synthetic binding/DOM tests are not those checks. Retained procedures and responsible roles are in `docs/translation.md`.

No store rejection or publication history was verified. Store submission is outside this pull request.

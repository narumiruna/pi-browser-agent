# Page, selection, subtitle, and PDF translation

Translation starts from Chrome's context menu. It is independent of chat: it does not send the composer, create a conversation turn, or invoke agent tools, MCP, WebMCP, bookmarks, or skills. The extension action still opens Pi Browser Agent.

## Start and stop

1. Right-click an empty area of an HTTP(S) page and select **Translate this page**. The Side Panel opens and starts visible-first translation after access checks.
2. For a selection, use **Translate selected text**, not **Send selection to Pi Browser Agent**. The result appears near the selection or at the configured bottom-right position. Show more/less, explicit retry, dismissal, and Escape remain available.
3. On a YouTube watch page, select **Translate YouTube subtitles**. Its in-player control is installed only after this invocation. Clicking that control explicitly restarts translation and opens sanitized diagnostics.
4. Select **Translate PDF** to open the separate reader. Apparent PDF URLs also route page translation to the reader. The original tab stays open.

A menu intent expires after 10 seconds before consumption. Missing access uses **Start translation and allow access** in the trusted UI; select it to approve the required page, provider, and supported frame origins. Denial starts no extraction or model request. An expired intent is not retargeted: invoke the menu again.

The compact **Stop translation** control cancels page/selection/subtitle work. Completed page notes can remain readable. A new explicit page session rebuilds those notes with the current settings. Tab activation, navigation, focus changes, replacement, access revocation, and owner closure invalidate pending work. A still-live controller can rebind routing after an actual worker restart; it does not replay requests. Closing and reopening the panel is not automatic resumption.

Picker, drawing, and region-capture startup withdraw translation publication before installing their protected surfaces. Translation DOM changes invalidate volatile element-discovery references. Existing chat drafts, images, selected-element chips, confirmations, and committed browser-action results retain their normal behavior.

## Settings

Open **Settings → Translation**. The four disclosures contain:

- **Translation model and language:** independent provider, model, thinking level, and target language. The default target is `Traditional Chinese (Taiwan)`. Credential setup reuses the shared provider-scoped authentication dialog. **Test Connection** sends a small explicit request, never a cached success; only one test runs at a time.
- **Translation appearance:** Calm Reading, Minimal, High Contrast, and Custom presets; typography, spacing, accent, label, surface, motion, and separate light/dark colors. Inline notes and selection panels have separate settings. Unsaved previews include contrast feedback. A transparent panel's displayed ratio is approximate; the actual host background can differ.
- **Translation prompt templates:** separate system/user templates, resets, live plain-text previews, and technical lint warnings. The user template requires `{{sourcePayload}}`; supported substitutions include `{{targetLanguage}}`, `{{itemCount}}`, and `{{itemKind}}`. Source payloads never interpolate into system instructions.
- **Subtitle and domain options:** translation-only or bilingual subtitles, selection placement, disabled domains, extraction diagnostics, and PDF cache clearing.

**Save general settings** saves changed translation fields together with the existing general-settings workflow. Nested appearance edits merge under a cross-context lock. Provider/model selection is committed as a pair. Cancel, Back, Escape, and native unsaved-change warnings protect drafts. Changing translation settings does not select a different chat model or replace chat instructions. Saved appearance applies to the next translation, not by restyling existing notes.

Thinking **Default** and **Off** remain separate saved choices. Both omit the reasoning override in the locked SDK, as in Pi Translator; provider defaults can still apply. Off is not a guarantee that every provider disables reasoning. Other choices follow the selected model's supported levels through Max; an unsupported stored preference is shown and falls back to Default for translation. It is not silently rewritten. See [authentication](authentication.md) for the distinct chat-thinking policy.

Custom OpenAI-compatible translation uses Responses, not Chat Completions. Enter the exact model ID and an HTTP(S) base URL containing a `/v1` path segment. URL userinfo, query strings, and fragments are rejected. The internal provider registration exposes no placeholder chat model. Configure its credential through the existing API-key flow, then approve the actual endpoint before a request. HTTP sends credentials and source text without transport encryption; use HTTPS for remote endpoints.

## Extraction and output

The extractor retains semantic placement for prose, headings, lists, quotes, table cells, and code-adjacent text. It prioritizes visible and nearby content, observes dynamic changes, reprioritizes on scrolling, and suppresses stale source revisions. Hidden copies, controls, metadata, and editable content are excluded. Page extraction checks descendant visibility and editable ancestry, including bare and `plaintext-only` editors, before collecting prose, code, or math. It excludes design-mode documents and does not serialize source HTML into protected math fragments. Code, paths, commands, URLs, math, and identifiers use protected fragments; malformed or unresolved placeholders are not successful translations.

Site profiles cover antirez, Carmina, Disqus, Findy, GitHub, Reddit, Schiit, YouTube, X posts/Articles, and Threads. Approved Disqus comments on antirez use a separate frame capability. Explicit selection results remain in the selected approved frame. This does not broaden ordinary agent tools beyond their top-frame boundary.

Model output and diagnostics use text nodes and extension-created markup, never model HTML. Appearance accepts only the packaged property/font/color ranges, not arbitrary CSS. Owned labels support the 18 application locales; model/page text, provider metadata, user templates, and technical diagnostics are not translated as message keys.

## YouTube

Native and automatic captions support timed JSON3 acquisition and visible-caption fallback. Signed caption URLs and native request parameters stay in memory. Acquisition accepts only HTTPS `/api/timedtext` on the three supported YouTube origins, omits cookies on extension fetches, rejects redirects, and bounds response size.

Rolling pretranslation leads by 60 seconds at 1×, 90 seconds at 1.5×, and 120 seconds at 2×. Seeks reprioritize work. Exact/unique cue matching and coalesced fallback prevent an older translation from replacing a newer native cue. Translation-only is the default; native text remains readable until a matching translation is ready. Bilingual mode retains both.

The player control shows startup/active/error state. Its diagnostic view supports copy, pause/resume, and close. Reports omit caption text, prompts, model output, credentials, and signed track URLs. Fullscreen rendering, SPA/video replacement cleanup, bounded transient recovery, and failed-setup handling remain separate from permission approval. Navigation to another video never auto-starts translation. Configuration and permission failures are not transient recovery requests.

## PDF reader

The packaged entry is `pages/pdf.html`. A random tab-bound launch record carries a remote source; the reader removes the token from its URL. Another tab cannot claim that launch. A shell opened without a launch does not start a request.

The reader fetches approved remote sources without cookies and rejects redirects before following them. It checks MIME, signature, source length, and streamed bytes. Authenticated, redirected, inaccessible, and local sources use **Choose PDF**. This reads only the explicitly selected file and grants no general filesystem or file-URL tool access. PDF.js receives validated bytes, never a cookie-bearing URL fallback. Its worker, fonts, CMaps, color profiles, and decoder assets are packaged locally; JavaScript evaluation is disabled and the unused QuickJS sandbox assets are not shipped.

Encrypted files use the native password dialog. Enter submits **Open PDF**, not Cancel. Wrong passwords can be corrected; the input is cleared after use. Passwords and original bytes remain in memory and do not enter model input, caches, conversations, or launch records. Multi-column extraction preserves reading order and filters repeated headers/footers. Uncertain formulas/structured content stay in the original. Scanned/OCR-only input is unsupported; no OCR or translated-PDF export is added.

The original remains selectable beside progressive translations. Navigation, scroll, zoom, source highlighting, translated-text search, page/document text copy, pause/resume, and explicit failed-block retry are available. **Translate entire document** shows a remaining-character estimate and asks for confirmation because it can consume significant API quota. Partial success remains readable after another block fails.

Cancel, document replacement, settings/credential changes, and disconnect cancel old transports. Remote source downloads also abort on Cancel, local-file replacement, or session disconnect, and have a 120-second deadline. Late downloads cannot replace the current document. A rejected replacement does not stop setup of the installed document. Changing target/model/templates cannot reuse the old rendered translation map. A reload or interrupted launch requires explicit Start; no interrupted request is silently repeated.

## Limits and storage

| Boundary                                                 | Limit                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------ |
| Ordinary source chunk                                    | 5,000 characters                                             |
| Translation scheduler and profile-wide provider dispatch | At most five active requests                                 |
| Ordinary/PDF batch deadline                              | 120 seconds                                                  |
| Subtitle batch deadline                                  | 30 seconds                                                   |
| Invalid response                                         | One retry within the same live authorized operation          |
| Memory translation cache                                 | 500 entries per UI realm                                     |
| Persistent PDF cache                                     | 5,000 records                                                |
| PDF source                                               | 50 MiB; 1,000 pages; 2,000,000 extracted characters          |
| PDF batch                                                | 64 items; 100,000 characters total; 20,000 per item          |
| Translation settings record                              | 65,536 UTF-8 bytes; templates at most 16,384 characters each |
| Translation operation/result envelope                    | 131,072 UTF-8 bytes                                          |
| Model/caption response body                              | 2,097,152 bytes                                              |
| Launch/routing authorization                             | 24 hours, with tab/document/owner revalidation               |

`piBrowserAgentTranslationSettingsV1` is a versioned trusted-local record. `piBrowserAgentAuthChangeV1` contains only a provider ID, version, and replacement nonce; it cancels affected translation before explicit credential replacement. Expected serialized same-account token refresh does not cancel its own startup.

Routing uses trusted session keys `piBrowserAgentTranslationOwnerV1:<token>`; PDF launches use `piBrowserAgentPdfLaunchV1:<token>`. They contain bounded routing/source metadata, not provider credentials or extracted text. A launch can contain a signed remote URL; it is not included in the reader URL, logs, model requests, or conversation sessions. Closed reader tabs remove their launch; expired records cannot authorize access and are pruned during tab cleanup.

The separate IndexedDB database `pi-browser-agent-pdf-translations`, store `translations`, contains bounded translated blocks and source/settings identities. Cache identity includes source revision, provider/model, endpoint, thinking, target language, and templates. **Clear PDF cache** in Translation Settings or the reader clears that cache, not credentials or conversations. Page, selection, and subtitle cache data remain memory-only. Stop does not claim secure erasure or delete provider-held data.

No other installed extension's data is imported. Users configure missing credentials here. Reverting the integration does not require deleting conversations, skills, MCP records, approvals, or existing Codex/API-key credentials. A downgraded build cannot use new account/custom-provider records it does not understand. Clear only the documented translation records/cache for explicit feature cleanup, never all extension storage.

## Recovery

1. **Missing or denied access:** use the explicit approval action. For an expired/changed tab, invoke the native menu again.
2. **Changed endpoint/account:** stop and start explicitly from the current page. Configure or sign in again when an authentication origin was revoked. The client pins the selected endpoint's origin, port, and base path; metadata changes cannot silently reroute an active request.
3. **Subtitle failure:** leave native captions on, use the in-player explicit restart, and inspect sanitized diagnostics. Do not treat an old cue as a reason to retry a browser mutation.
4. **PDF failure:** retain the original tab, download through the normal site if authentication/redirects are needed, then choose that local file. Retry failed blocks explicitly; clear only the PDF cache for cache recovery.

Local cancellation cannot retract text already sent or guarantee that provider billing stops. None of these recovery actions replays a browser mutation or remote MCP call.

## Evidence and provenance

The port preserves the user-facing F01–F18 inventory from Pi Translator `5e530c9`. Source extraction/rendering, translation algorithms, subtitle helpers, and PDF helpers were adapted into `src/browser/translation/` and `src/browser/pdf/`; account adapters use `src/browser/auth/`. Provider requests were moved out of the source worker into trusted UI contexts. Tests and generated browser fixtures are owned locally and require no sibling checkout. PDF.js `6.5.438` is the only added runtime dependency; its Apache license (`pdf/LICENSE`) and asset licenses ship with the artifact. The artifact audit rejects JavaScript eval/remote script sources and unreviewed WebAssembly assets.

All paths below are destination tests. Browser tests use the temporary-copy extension harness and mocked model responses, not paid services or production automation hooks. Before review fixes, local `npm run ci` passed 2,892 unit/integration tests in 125 files, the production build/typecheck and 259-file artifact audit, and all 398 unsharded E2E scenarios. The separate smoke command passed both scenarios. Toolchain and prior-attempt details are retained in [manual acceptance](manual-acceptance.md#translation-integration--2026-11-15). Review-fix evidence and unresolved external work are recorded in the [PR #153 review ledger](reviews/pr-153-review.md).

| Parity | Passing acceptance evidence                                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01    | `tests/e2e/translation.spec.ts`; `tests/integration/service-worker-context-menu.test.ts`                                                                                                                                      |
| F02    | `content-source-revisions`, `content-viewport`, `page-observer`, `background-page-lifecycle` under `tests/unit/translation/`; dynamic-page browser scenario                                                                   |
| F03    | `source-analyzer-visibility`, `content`, `content-helpers` unit suites; hidden/editable/table/flex browser scenario                                                                                                           |
| F04    | `content-site-profiles`, `embedded-frames` unit suites; `tests/e2e/translation-profiles.spec.ts`, including real cross-origin frame selection                                                                                 |
| F05    | `content-selection-panel` unit suite; selection/Escape/dismissal browser scenarios                                                                                                                                            |
| F06    | `api-chunk-plan`, `api-responses`, `progressive-translation`, `translation-cancellation`, `request-abort`, `page-translation-session` unit suites; profile-wide Web Locks test                                                |
| F07    | `api-protected-fragments` unit suite; literal source/layout browser assertions                                                                                                                                                |
| F08    | `tests/unit/provider.test.ts`; `translation/boundaries.test.ts`; `tests/e2e/custom-translation.spec.ts`                                                                                                                       |
| F09    | `tests/unit/oauth.test.ts`, `authentication-actions.test.ts`, `translation/auth-protocols.test.js`, `translation/auth-anthropic-security.test.js`                                                                             |
| F10    | Settings/schema/provider boundary suites; independent Settings and Custom Responses browser scenarios                                                                                                                         |
| F11    | `api-responses`/settings validation suites; `tests/e2e/translation-settings.spec.ts` template preview/reset/discard assertions                                                                                                |
| F12    | `translation-appearance` suite; unsaved preview/concurrent-save scenario; seven-section locale/design scenarios and expanded light/dark, reduced-motion, forced-color, and native 200% zoom checks                            |
| F13    | `youtube-caption-prefetch`, `youtube-caption-tracks`, `youtube-caption-fallback`, `youtube-timed-captions`, `content-subtitles`, `youtube-runtime` suites; caption/rate/seek browser scenario                                 |
| F14    | `youtube-player-control`, `youtube-recovery` suites; actual worker stop, 35-second paused idle, video replacement, fullscreen, bounded recovery exhaustion/delayed-navigation, and five stalled SSE-request browser scenarios |
| F15    | `pdf-source`, `pdf-extraction`, `pdf-shared` suites; generated encrypted/malformed/local/remote browser fixtures                                                                                                              |
| F16    | `pdf-navigation`, `pdf-reader-utils`, `pdf-controller`, `pdf-session` suites; six-page navigation, whole-document confirmation, search, and target-change browser scenarios                                                   |
| F17    | `api-cache`, `pdf-cache`, provider-identity tests; generated-document target-change and concurrent Settings browser scenarios                                                                                                 |
| F18    | `tests/integration/translation-worker.test.ts`; lifecycle/recovery suites; actual restart, replacement-owner race, target-scoped navigation, stalled PDF-source cancellation/replacement, and original-tab browser assertions |

A standalone packaged PDF parser/worker proof rendered selectable generated pages on Chromium 158 and Chrome 116. This does not fix or waive the existing full-application Chrome 116 startup gate in [manual acceptance](manual-acceptance.md). Current-Chromium automated checks do not prove native UI, native-language quality, live account policy, or long-running public YouTube behavior.

## External acceptance and release restrictions

These procedures require the named authorized role. They do not authorize paid requests, access-control bypasses, publishing, or sharing secrets in an issue.

1. **Native UI and accessibility — UI maintainer/authorized tester.** Load the built extension through Chrome's native UI. Physically right-click empty pages and selections; check menu grouping, optional permission prompts, toolbar/shortcut behavior, keyboard focus, Escape, and screen-reader announcements. Review generated light/dark, narrow, large-text, reduced-motion, and forced-color captures. Expected: readable, reachable controls and unchanged action entry. Actual native menu/prompt behavior, subjective layout/language quality, and assistive-technology output remain unverified; do not label DOM/mock checks as this acceptance.
2. **Live accounts — authorized provider account owners.** Use legitimate accounts to sign in, cancel, refresh, and remove each supported provider without recording codes, callback URLs, or tokens. Synthetic protocols do not establish live acceptance. **The changed Anthropic flow must not be released until live sign-in, cancellation, and refresh pass.** Other provider-policy/account paths also remain unverified.
3. **Live subtitles/provider soak — authorized tester and CI maintainer.** With an approved model budget and an accessible captioned video, check timed acquisition/fallback and both display modes, then play for at least 20 real-time minutes with rates, seeks, pause, ads, and node transitions when available. Retain only sanitized diagnostics. Public DOM/track compatibility, provider latency/limits, and billing termination remain unverified. Local fixtures do not resolve historical live-source incidents; do not bypass sign-in or bot checks.
4. **Minimum Chrome — release maintainer.** Follow the existing Chrome 116 full-application startup procedure and record the result. The PDF-only proof is not full-extension acceptance. Retain that existing release restriction until the application gate is resolved.

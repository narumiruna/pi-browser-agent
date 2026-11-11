# Image generation

`codex_imagegen` generates one image from a text prompt with the OpenAI Codex account configured in Pi Browser Agent. The chat model can use another provider. A readable web page is not required.

## Use

1. Select **Add credential → Sign in with an account → OpenAI Codex (legacy)** and complete login.
2. Send a request to generate an image. Include pixel dimensions, such as `512x512`, when needed. The tool becomes available at the start of a new run when a Codex OAuth credential is stored.
3. Review the full image prompt, background choice, requested size, and endpoint in the confirmation dialog. Select **Confirm** to approve endpoint access and one generation request, or **Cancel** to decline.
4. Open the image tool result in the conversation to inspect the image. Use Chrome's image context menu to save it if needed.

Every generation requires fresh confirmation in Strict, Balanced, and Convenient modes. The browser-tool preference list does not control this account tool. Missing credentials require login; an OpenAI API key does not enable it.

## Tool contract

```json
{
  "prompt": "A red square on a plain background",
  "transparentBackground": false,
  "size": "512x512"
}
```

- `prompt` is required, must not be blank, and is limited to 32,000 UTF-16 code units. The original text is sent without trimming.
- `transparentBackground` is optional and defaults to `false`. It requests transparency; it does not prove that the returned image has an alpha channel.
- `size` is optional and defaults to `auto`. An explicit size uses `WIDTHxHEIGHT` with lowercase `x` and no leading zeroes.
  - Each side must be from 256 through 3,840 pixels and divisible by 16.
  - The total must not exceed 8,294,400 pixels. The aspect ratio must be from 1:3 through 3:1.
  - Invalid sizes fail before confirmation, authentication resolution, or HTTP dispatch.
- No path, reference image, mask, image editing, or batch argument is supported.

The Side Panel sends one JSON `POST` to `https://chatgpt.com/backend-api/codex/images/generations` with `model: "gpt-image-2"`, `quality: "auto"`, the confirmed `size`, and `background: "opaque"` or `"transparent"`. This operation does not use chat SSE. It sends only the image prompt, requested size, and fixed generation options, not conversation history or page data unless those are included in the confirmed prompt.

The base protocol follows `../pi-extensions/packages/pi-codex-imagegen/`. Explicit sizes use the `WIDTHxHEIGHT` format described in the [OpenAI image API reference](https://developers.openai.com/api/reference/resources/images/methods/generate/). The internal Codex endpoint can change without an extension release. Its acceptance of explicit sizes remains unverified; it can reject a requested size. A stored login is not proof of image entitlement or acceptance of extension-origin requests. Account quota and organization policy still apply. No alternate endpoint, account, or provider is tried after a failure.

## Bounds and results

The returned JSON must contain exactly one inline `data[].b64_json` image. URLs and file references are not fetched. Response content must be JSON with valid UTF-8; its streamed body is capped at 4,065,536 bytes.

Accepted images are static PNG, JPEG, and WebP with canonical padded base64. Decoded bytes must not exceed 3,000,000. Header dimensions must be positive, at most 4,096 pixels per side, and at most 16,000,000 pixels in total before raster decoding. Browser decoding must succeed and report the header dimensions. For JPEG, an exact width/height transpose is also accepted because Chrome can apply EXIF orientation. Result metadata uses the decoded display dimensions. APNG, animated WebP, GIF, SVG, malformed data, and larger images fail without retry. Images are not resized or re-encoded.

A smaller requested size can reduce image bytes, but it does not guarantee a result below 3 MB. The tool does not resize or regenerate an oversized result. A later request needs explicit approval and can consume more quota.

The image result contains the original validated image and bounded MIME type, dimensions, and optional image request ID. Existing tool-result rendering displays it. The selected chat provider receives the ordinary tool result on continuation, subject to its image support. Complete results use the existing IndexedDB transcript and retention rules, including the 5 MB total session limit. Several images or conversation-tree duplication can exceed that limit even when each image is valid. For an oversized linear session, compaction replaces images with omission placeholders and can remove older messages. The Side Panel reports this loss. Tree-enabled sessions do not use compaction: an oversized write fails and retains the previous stored record. There is no new artifact store or session migration.

## Authorization and cancellation

Credentials remain in the trusted Side Panel and credential store. Before confirmation, the tool binds the request to the stored credential's ChatGPT account claim. Stored account metadata, when present, must match that claim. A change to the account or credential removal cancels pending confirmation and authentication. Before authentication resolves, same-account credential changes can continue. This includes OAuth refresh and explicit replacement with credentials for the same account. After authentication resolves, a changed access token cancels local work. It resolves `openai-codex` OAuth through the existing serialized refresh path. Image requests authenticate only to the fixed endpoint; token refresh can send the refresh token to OpenAI authentication services. Requests omit cookies and reject redirects. Both OpenAI authentication and image origins must retain Chrome permission and recorded exact-origin approval. Screenshot all-sites access alone is not sufficient.

Authentication has a 30-second deadline. Authentication, HTTP headers, response body, and image validation share a five-minute deadline after confirmation. Abort, panel shutdown, credential removal, a change to the account, or origin revocation cancels local work. Late results cannot enter the conversation. Readers, listeners, timers, and decoded bitmaps are released.

A failed or cancelled request may still consume quota. The tool never automatically retries or restores a generation request. Session restore displays completed images only; a new generation needs a new model call and confirmation. Error messages do not include raw service bodies, tokens, or account claims.

## Verification

Offline unit tests cover the JSON protocol, default and explicit sizes, invalid size rejection, bounded image validation, confirmation, authentication, cancellation, revocation, and fixed errors. The mocked browser scenarios cover EXIF-oriented non-square JPEGs, no-page use, size confirmation and dispatch, endpoint approval from Confirm, image preview, transcript persistence, restore without replay, and fresh confirmation in Convenient mode.

Run from the repository root:

```sh
npm test -- tests/unit/imagegen.test.ts tests/unit/imagegen-image.test.ts tests/integration/imagegen-runtime.test.ts
npm run check
npm run build
npm run test:e2e -- tests/e2e/imagegen.spec.ts
```

Run E2E only after a successful build. These checks make no real generation request. The account owner must separately verify live account entitlement, extension-origin and size acceptance, quota behavior, and transparent output after login and explicit confirmation. These live-service properties remain unverified by the mocked tests.

# Image generation

`codex_imagegen` generates one image from a text prompt with the OpenAI Codex account configured in Pi Browser Agent. The chat model can use another provider. A readable web page is not required.

## Use

1. Select **Add credential → Sign in with an account → OpenAI Codex (legacy)** and complete login.
2. Send a request to generate an image. The tool becomes available at the start of a new run when a Codex OAuth credential is stored.
3. Review the full image prompt, background choice, and endpoint in the confirmation dialog. Select **Confirm** to approve endpoint access and one generation request, or **Cancel** to decline.
4. Open the image tool result in the conversation to inspect the image. Use Chrome's image context menu to save it if needed.

Every generation requires fresh confirmation in Strict, Balanced, and Convenient modes. The browser-tool preference list does not control this account tool. Missing credentials require login; an OpenAI API key does not enable it.

## Tool contract

```json
{
  "prompt": "A red square on a plain background",
  "transparentBackground": false
}
```

- `prompt` is required, must not be blank, and is limited to 32,000 UTF-16 code units. The original text is sent without trimming.
- `transparentBackground` is optional and defaults to `false`. It requests transparency; it does not prove that the returned image has an alpha channel.
- No path, reference image, mask, image editing, or batch argument is supported.

The Side Panel sends one JSON `POST` to `https://chatgpt.com/backend-api/codex/images/generations` with `model: "gpt-image-2"`, `quality: "auto"`, `size: "auto"`, and `background: "opaque"` or `"transparent"`. This operation does not use chat SSE. It sends only the image prompt and fixed generation options, not conversation history or page data unless those are included in the confirmed prompt.

This protocol follows `../pi-extensions/packages/pi-codex-imagegen/`. It uses an internal endpoint, which can change without an extension release. A stored login is not proof of image entitlement or acceptance of extension-origin requests. Account quota and organization policy still apply. No alternate endpoint, account, or provider is tried after a failure.

## Bounds and results

The returned JSON must contain exactly one inline `data[].b64_json` image. URLs and file references are not fetched. Response content must be JSON with valid UTF-8; its streamed body is capped at 4,065,536 bytes.

Accepted images are static PNG, JPEG, and WebP with canonical padded base64. Decoded bytes must not exceed 3,000,000. Header dimensions must be positive, at most 4,096 pixels per side, and at most 16,000,000 pixels in total before raster decoding. Browser decoding must succeed and report the same dimensions. APNG, animated WebP, GIF, SVG, malformed data, and larger images fail without retry. Images are not resized or re-encoded.

The image result contains the original validated image and bounded MIME type, dimensions, and optional image request ID. Existing tool-result rendering displays it. The selected chat provider receives the ordinary tool result on continuation, subject to its image support. Complete results use the existing IndexedDB transcript and retention rules, including the 5 MB total session limit. Several images or conversation-tree duplication can exceed that limit even when each image is valid; persistence then reports failure. There is no new artifact store or session migration.

## Authorization and cancellation

Credentials remain in the trusted Side Panel and credential store. The tool resolves `openai-codex` OAuth through the existing serialized refresh path, reads its ChatGPT account claim, and authenticates only to the fixed endpoint. Requests omit cookies and reject redirects. Both OpenAI authentication and image origins must retain Chrome permission and recorded exact-origin approval. Screenshot all-sites access alone is not sufficient.

Authentication has a 30-second deadline. Authentication, HTTP headers, response body, and image validation share a five-minute deadline after confirmation. Abort, panel shutdown, credential replacement/removal, or origin revocation cancels local work. Late results cannot enter the conversation. Readers, listeners, timers, and decoded bitmaps are released.

A failed or cancelled request may still consume quota. The tool never automatically retries or restores a generation request. Session restore displays completed images only; a new generation needs a new model call and confirmation. Error messages do not include raw service bodies, tokens, or account claims.

## Verification

Offline unit tests cover the JSON protocol, bounded image validation, confirmation, authentication, cancellation, revocation, and fixed errors. The mocked browser scenario covers no-page use, endpoint approval from Confirm, image preview, transcript persistence, restore without replay, and fresh confirmation in Convenient mode.

Run from the repository root:

```sh
npm test -- tests/unit/imagegen.test.ts tests/unit/imagegen-image.test.ts tests/integration/imagegen-runtime.test.ts
npm run check
npm run build
npm run test:e2e -- tests/e2e/imagegen.spec.ts
```

Run E2E only after a successful build. These checks make no real generation request. The account owner must separately verify live account entitlement, extension-origin acceptance, quota behavior, and transparent output after login and explicit confirmation. These live-service properties remain unverified by the mocked tests.

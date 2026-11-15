/** Bound response bytes before an SDK or JSON parser can accumulate them. */
export function boundedResponse(response: Response, maximumBytes: number): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  let total = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          controller.close()
          reader.releaseLock()
          return
        }
        total += next.value.byteLength
        if (total > maximumBytes) {
          await reader.cancel()
          controller.error(new Error("Response exceeds the supported byte limit"))
          return
        }
        controller.enqueue(next.value)
      } catch {
        controller.error(new Error("Response stream failed"))
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined)
    },
  })
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

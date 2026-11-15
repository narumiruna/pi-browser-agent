import assert from "node:assert/strict"
import { test } from "vitest"

import {
  inspectRemotePdf,
  readLocalPdf,
  readResponseBytes,
} from "../../../src/browser/pdf/source.js"

function response(body, options = {}) {
  return new Response(body, {
    headers: options.headers,
    status: options.status || 200,
  })
}

test("remote PDF inspection accepts PDF bytes and same-origin final URLs", async () => {
  const result = await inspectRemotePdf("https://example.com/paper.pdf", {
    async fetchImpl(_url, options) {
      assert.equal(options.credentials, "omit")
      assert.equal(options.redirect, "error")
      const result = response("%PDF-1.7\ncontent", {
        headers: { "content-type": "application/pdf" },
      })
      Object.defineProperty(result, "url", {
        value: "https://example.com/paper.pdf",
      })
      return result
    },
  })

  assert.equal(result.url, "https://example.com/paper.pdf")
  assert.equal(result.title, "paper")
  assert.equal(new TextDecoder().decode(result.data), "%PDF-1.7\ncontent")
})

test("remote PDF inspection rejects HTML and cross-origin redirects", async () => {
  await assert.rejects(
    inspectRemotePdf("https://example.com/paper.pdf", {
      async fetchImpl() {
        const result = response("<html>not pdf</html>")
        Object.defineProperty(result, "url", {
          value: "https://example.com/paper.pdf",
        })
        return result
      },
    }),
    /non-PDF content type|valid PDF/,
  )
  await assert.rejects(
    inspectRemotePdf("https://example.com/paper.pdf", {
      async fetchImpl() {
        const result = response("%PDF-1.7", {
          headers: { "content-type": "text/html" },
        })
        Object.defineProperty(result, "url", {
          value: "https://example.com/paper.pdf",
        })
        return result
      },
    }),
    /non-PDF content type/,
  )
  await assert.rejects(
    inspectRemotePdf("https://example.com/paper.pdf", {
      async fetchImpl() {
        const result = response("%PDF-1.7", {
          headers: { "content-type": "application/pdf" },
        })
        Object.defineProperty(result, "url", {
          value: "https://cdn.example.net/paper.pdf",
        })
        return result
      },
    }),
    /another origin/,
  )
})

test("remote PDF inspection enforces Content-Range source limits", async () => {
  await assert.rejects(
    inspectRemotePdf("https://example.com/large.pdf", {
      async fetchImpl() {
        const result = response("%PDF-1.7", {
          headers: {
            "content-range": "bytes 0-1023/999999999",
            "content-type": "application/pdf",
          },
        })
        Object.defineProperty(result, "url", {
          value: "https://example.com/large.pdf",
        })
        return result
      },
    }),
    /size limit/,
  )
})

test("local PDF validation accepts files and rejects malformed selections", async () => {
  const valid = {
    name: "test.pdf",
    size: 12,
    async arrayBuffer() {
      return new TextEncoder().encode("%PDF-1.7\n").buffer
    },
  }
  assert.equal((await readLocalPdf(valid)).title, "test")
  await assert.rejects(
    readLocalPdf({
      ...valid,
      async arrayBuffer() {
        return new TextEncoder().encode("not pdf").buffer
      },
    }),
    /not a valid PDF/,
  )
})

test("bounded response reader rejects streams without size headers", async () => {
  await assert.rejects(
    readResponseBytes(new Response(new Uint8Array([1, 2, 3, 4, 5])), 4),
    /size limit/,
  )
})

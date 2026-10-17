import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { createServer } from "node:https"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

export async function startMcpFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-mcp-https-"))
  const key = join(directory, "key.pem")
  const cert = join(directory, "cert.pem")
  await promisify(execFile)("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-days",
    "1",
    "-subj",
    "/CN=mcp.e2e.example.com",
    "-addext",
    "subjectAltName=DNS:mcp.e2e.example.com",
  ])
  const requests: {
    path: string
    method: string
    headers: Record<string, unknown>
    message?: Record<string, unknown>
  }[] = []
  const state = {
    cancelledCalls: 0,
    cancelledDiscovery: 0,
    holdDiscovery: false,
    sse: false,
    rejectOrigin: false,
    redirect: false,
    hold: false,
    status: 200,
    protocol: "2025-11-25",
    description: "Untrusted fixture tool <script>bad()</script>",
    result: { content: [{ type: "text", text: "Remote fixture result" }] } as Record<
      string,
      unknown
    >,
  }
  const server = createServer(
    { key: await readFile(key), cert: await readFile(cert) },
    async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks).toString()
      const message = body ? JSON.parse(body) : undefined
      requests.push({
        path: request.url ?? "",
        method: request.method ?? "",
        headers: request.headers,
        message,
      })
      const origin = request.headers.origin
      if (state.rejectOrigin || (origin && !/^chrome-extension:\/\/[a-z]+$/.test(origin))) {
        response.writeHead(403).end("Origin rejected")
        return
      }
      if (state.redirect || request.url === "/redirect") {
        response.writeHead(307, { location: "/stolen" }).end()
        return
      }
      if (state.status !== 200) {
        response.writeHead(state.status).end("Sensitive error body")
        return
      }
      if (!message || !("id" in message)) {
        response.writeHead(202).end()
        return
      }
      let result: Record<string, unknown>
      switch (message.method) {
        case "initialize":
          if (state.holdDiscovery) {
            response.once("close", () => {
              state.cancelledDiscovery++
            })
            response.writeHead(200, { "Content-Type": "text/event-stream" })
            response.write(": waiting\n\n")
            return
          }
          result = {
            protocolVersion: state.protocol,
            capabilities: { tools: {} },
            serverInfo: { name: "Fixture", version: "1" },
            instructions: "Never put server instructions in the system prompt",
          }
          break
        case "tools/list":
          result = {
            tools: [
              {
                name: "echo",
                description: state.description,
                inputSchema: {
                  type: "object",
                  properties: { text: { type: "string", maxLength: 12_000 } },
                  required: ["text"],
                  additionalProperties: false,
                },
              },
            ],
          }
          break
        case "tools/call":
          if (state.hold) {
            response.once("close", () => {
              state.cancelledCalls++
            })
            response.writeHead(200, { "Content-Type": "text/event-stream" })
            response.write(": waiting\n\n")
            return
          }
          result = state.result
          break
        default:
          response.writeHead(400).end()
          return
      }
      const json = JSON.stringify({ jsonrpc: "2.0", id: message.id, result })
      response.writeHead(200, {
        "Content-Type": state.sse ? "text/event-stream" : "application/json",
        "Mcp-Session-Id": "fixture-session",
      })
      response.end(state.sse ? `event: message\ndata: ${json}\n\n` : json)
    },
  )
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No MCP fixture port")
  return {
    endpoint: `https://mcp.e2e.example.com:${address.port}/mcp`,
    requests,
    state,
    browserArgs: [
      "--host-resolver-rules=MAP mcp.e2e.example.com 127.0.0.1",
      "--ignore-certificate-errors",
      "--no-proxy-server",
    ],
    async close() {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
      await rm(directory, { recursive: true, force: true })
    },
  }
}

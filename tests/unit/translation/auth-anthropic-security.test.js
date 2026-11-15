import assert from "node:assert/strict"
import { createHash, webcrypto } from "node:crypto"
import { test } from "vitest"

import { createBrowserAnthropicOAuth } from "../../../src/browser/auth/anthropic-oauth.js"

function createFlow(input, options = {}) {
  const requests = []
  const events = []
  const controller = new AbortController()
  const randomDraws = []
  const oauth = createBrowserAnthropicOAuth({
    crypto: {
      getRandomValues(bytes) {
        webcrypto.getRandomValues(bytes)
        randomDraws.push(Buffer.from(bytes))
        return bytes
      },
      subtle: webcrypto.subtle,
    },
    async fetch(url, init) {
      requests.push({ url, init, body: JSON.parse(init.body) })
      options.onExchange?.(requests.at(-1), events[0])
      return Response.json({
        access_token: "synthetic-access",
        refresh_token: "synthetic-refresh",
        expires_in: 3600,
      })
    },
    now: () => 1_000_000,
  })
  const interaction = {
    notify(event) {
      events.push(event)
    },
    async prompt(definition) {
      const state = new URL(events[0].url).searchParams.get("state")
      return input(state, controller, definition)
    },
    signal: controller.signal,
  }
  return { oauth, interaction, requests, events, controller, randomDraws }
}

const inputForms = [
  ["callback URL", (state) => `http://localhost:53692/callback?code=synthetic-code&state=${state}`],
  ["compound code", (state) => `synthetic-code#${state}`],
  ["query parameters", (state) => `code=synthetic-code&state=${state}`],
  ["query with leading question mark", (state) => `?code=synthetic-code&state=${state}`],
  ["bare code", () => "synthetic-code"],
]

for (const [name, input] of inputForms) {
  test(`Anthropic ${name} exchanges independent state with an S256 verifier`, async () => {
    const flow = createFlow(input, {
      onExchange({ body, url, init }, event) {
        const authorize = new URL(event.url)
        const params = authorize.searchParams
        assert.equal(url, "https://platform.claude.com/v1/oauth/token")
        assert.equal(init.method, "POST")
        assert.equal(params.get("code_challenge_method"), "S256")
        assert.equal(params.get("state"), body.state)
        assert.notEqual(body.state, body.code_verifier)
        assert.equal(
          createHash("sha256").update(body.code_verifier).digest("base64url"),
          params.get("code_challenge"),
        )
        assert.equal(authorize.href.includes(body.code_verifier), false)
        assert.equal(body.redirect_uri, params.get("redirect_uri"))
        assert.equal(body.client_id, params.get("client_id"))
        assert.equal(body.code, "synthetic-code")
        assert.equal(body.grant_type, "authorization_code")
      },
    })
    const credential = await flow.oauth.login(flow.interaction)
    assert.equal(flow.requests.length, 1)
    assert.equal(flow.randomDraws.length, 2)
    assert.equal(flow.randomDraws[1].length, 32)
    assert.equal(flow.randomDraws[1].toString("hex"), flow.requests[0].body.state)
    assert.equal(flow.randomDraws[0].toString("base64url"), flow.requests[0].body.code_verifier)
    assert.deepEqual(credential, {
      type: "oauth",
      access: "synthetic-access",
      refresh: "synthetic-refresh",
      expires: 4_300_000,
    })
  })
}

for (const [name, input] of [
  ["URL state mismatch", () => "http://localhost:53692/callback?code=synthetic-code&state=wrong"],
  ["compound state mismatch", () => "synthetic-code#wrong"],
  ["query state mismatch", () => "code=synthetic-code&state=wrong"],
  ["URL missing state", () => "http://localhost:53692/callback?code=synthetic-code"],
  ["query missing state", () => "code=synthetic-code"],
  ["compound missing state", () => "synthetic-code#"],
]) {
  test(`Anthropic rejects ${name} without an exchange`, async () => {
    const flow = createFlow(input)
    await assert.rejects(flow.oauth.login(flow.interaction), /state/iu)
    assert.deepEqual(flow.requests, [])
  })
}

test("Anthropic rejects an empty code without an exchange", async () => {
  const flow = createFlow(() => "")
  await assert.rejects(flow.oauth.login(flow.interaction), /code is required/iu)
  assert.deepEqual(flow.requests, [])
})

test("Anthropic cancellation before login emits no URL or prompt", async () => {
  const flow = createFlow(() => assert.fail("Cancelled login prompted."))
  flow.controller.abort()
  await assert.rejects(flow.oauth.login(flow.interaction), {
    name: "AbortError",
  })
  assert.deepEqual(flow.events, [])
  assert.deepEqual(flow.requests, [])
})

test("Anthropic cancellation after a manual prompt sends no exchange", async () => {
  const flow = createFlow((state, controller) => {
    controller.abort()
    return `synthetic-code#${state}`
  })
  await assert.rejects(flow.oauth.login(flow.interaction), {
    name: "AbortError",
  })
  assert.deepEqual(flow.requests, [])
  assert.equal(
    flow.events.some((event) => event.type === "progress"),
    false,
  )
})

test("Anthropic prompt cancellation propagates without an exchange", async () => {
  const flow = createFlow(() => {
    throw new DOMException("Authentication cancelled.", "AbortError")
  })
  await assert.rejects(flow.oauth.login(flow.interaction), {
    name: "AbortError",
  })
  assert.deepEqual(flow.requests, [])
})

test("Anthropic generates a new independent state for each login", async () => {
  const flow = createFlow(() => "synthetic-code")
  await flow.oauth.login(flow.interaction)
  await flow.oauth.login(flow.interaction)
  const [first, second] = flow.requests.map(({ body }) => body)
  assert.notEqual(first.state, second.state)
  assert.notEqual(first.code_verifier, second.code_verifier)
  assert.notEqual(first.state, first.code_verifier)
  assert.notEqual(second.state, second.code_verifier)
})

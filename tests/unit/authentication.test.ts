import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  createAuthenticationProof,
  createChallenge,
  parseExtensionOrigin,
  verifyAuthenticationProof,
} from "../../src/pi/authentication.js"
import { BridgeConfigStore } from "../../src/pi/config.js"
import { BridgeError } from "../../src/protocol/index.js"

const extensionId = "a".repeat(32)
const origin = `chrome-extension://${extensionId}`
const secret = Buffer.alloc(32, 7).toString("base64url")

describe("bridge authentication", () => {
  test("accepts one valid challenge response", () => {
    const challenge = createChallenge(1_000)
    const proof = createAuthenticationProof(secret, challenge, "client", origin)

    expect(() =>
      verifyAuthenticationProof({
        challenge,
        challengeId: challenge.challengeId,
        clientId: "client",
        now: 1_001,
        origin,
        proof,
        secret,
      }),
    ).not.toThrow()
  })

  test("rejects incorrect, expired, and replayed proofs", () => {
    const incorrect = createChallenge(1_000)
    expect(() =>
      verifyAuthenticationProof({
        challenge: incorrect,
        challengeId: incorrect.challengeId,
        clientId: "client",
        now: 1_001,
        origin,
        proof: "incorrect",
        secret,
      }),
    ).toThrow(BridgeError)

    const expired = createChallenge(1_000)
    const expiredProof = createAuthenticationProof(secret, expired, "client", origin)
    expect(() =>
      verifyAuthenticationProof({
        challenge: expired,
        challengeId: expired.challengeId,
        clientId: "client",
        now: expired.expiresAt + 1,
        origin,
        proof: expiredProof,
        secret,
      }),
    ).toThrow(/expired/)

    const replayed = createChallenge(1_000)
    const replayedProof = createAuthenticationProof(secret, replayed, "client", origin)
    const options = {
      challenge: replayed,
      challengeId: replayed.challengeId,
      clientId: "client",
      now: 1_001,
      origin,
      proof: replayedProof,
      secret,
    }
    verifyAuthenticationProof(options)
    expect(() => verifyAuthenticationProof(options)).toThrow(/already used/)
  })

  test("only accepts exact Chrome extension origins", () => {
    expect(parseExtensionOrigin(origin)).toEqual({ extensionId, origin })
    expect(() => parseExtensionOrigin("https://example.com")).toThrow(BridgeError)
    expect(() => parseExtensionOrigin("chrome-extension://*")).toThrow(BridgeError)
    expect(() => parseExtensionOrigin(`${origin}/`)).toThrow(BridgeError)
    expect(() => parseExtensionOrigin(undefined)).toThrow(BridgeError)
  })
})

describe("pairing configuration", () => {
  test("stores secrets outside sessions with mode 0600 and supports revoke", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-chrome-config-"))
    const path = join(directory, "pi-chrome.json")
    const store = new BridgeConfigStore(path)

    const pairing = await store.createPairing()
    expect(pairing.secret).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ secret: pairing.secret })
    expect((await stat(path)).mode & 0o777).toBe(0o600)

    await store.bindExtension(extensionId)
    expect(await store.load()).toMatchObject({ allowedExtensionId: extensionId })

    await store.revoke()
    expect(await store.load()).toEqual({ port: 17_373 })
  })
})

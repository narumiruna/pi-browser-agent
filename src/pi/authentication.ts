import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { type AuthChallengeFrame, BridgeError } from "../protocol/index.js"
import { isExtensionId } from "./config.js"

export const AUTH_CHALLENGE_TTL_MS = 30_000

export interface PendingChallenge {
  challengeId: string
  nonce: string
  expiresAt: number
  used: boolean
}

export function parseExtensionOrigin(origin: string | undefined): {
  extensionId: string
  origin: string
} {
  if (!origin) throw new BridgeError("AUTHENTICATION_FAILED", "Missing WebSocket origin")
  const match = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin)
  const extensionId = match?.[1]
  if (!extensionId || !isExtensionId(extensionId)) {
    throw new BridgeError("AUTHENTICATION_FAILED", "Only Chrome extension origins are allowed")
  }
  return { extensionId, origin }
}

export function createChallenge(now = Date.now()): PendingChallenge {
  return {
    challengeId: randomBytes(18).toString("base64url"),
    nonce: randomBytes(32).toString("base64url"),
    expiresAt: now + AUTH_CHALLENGE_TTL_MS,
    used: false,
  }
}

export function toChallengeFrame(challenge: PendingChallenge): AuthChallengeFrame {
  return {
    type: "auth.challenge",
    challengeId: challenge.challengeId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
  }
}

export function createAuthenticationProof(
  secret: string,
  challenge: Pick<PendingChallenge, "challengeId" | "nonce">,
  clientId: string,
  origin: string,
): string {
  return createHmac("sha256", Buffer.from(secret, "base64url"))
    .update(`${challenge.challengeId}.${challenge.nonce}.${clientId}.${origin}`)
    .digest("base64url")
}

export function verifyAuthenticationProof(options: {
  challenge: PendingChallenge
  challengeId: string
  clientId: string
  now?: number
  origin: string
  proof: string
  secret: string
}): void {
  const now = options.now ?? Date.now()
  if (options.challenge.used) {
    throw new BridgeError("AUTHENTICATION_FAILED", "Authentication challenge was already used")
  }
  if (options.challenge.challengeId !== options.challengeId || now > options.challenge.expiresAt) {
    throw new BridgeError("AUTHENTICATION_FAILED", "Authentication challenge is invalid or expired")
  }
  options.challenge.used = true

  const expected = Buffer.from(
    createAuthenticationProof(options.secret, options.challenge, options.clientId, options.origin),
    "utf8",
  )
  const received = Buffer.from(options.proof, "utf8")
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    throw new BridgeError("AUTHENTICATION_FAILED", "Pairing secret is incorrect")
  }
}

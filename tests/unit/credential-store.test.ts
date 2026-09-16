import { createModels, createProvider, type OAuthCredential } from "@earendil-works/pi-ai"
import { describe, expect, test, vi } from "vitest"
import { ChromeCredentialStore } from "../../src/browser/auth/credential-store.js"

class MemoryStorage {
  values: Record<string, unknown> = {}

  async get(key: string | string[] | null): Promise<Record<string, unknown>> {
    if (typeof key === "string") return { [key]: this.values[key] }
    return { ...this.values }
  }

  async set(items: Record<string, unknown>): Promise<void> {
    Object.assign(this.values, structuredClone(items))
  }

  async remove(key: string | string[]): Promise<void> {
    for (const item of typeof key === "string" ? [key] : key) delete this.values[item]
  }
}

describe("Chrome credential store", () => {
  test("serializes mutations and does not expose secrets from list", async () => {
    const area = new MemoryStorage()
    const store = new ChromeCredentialStore(area as unknown as chrome.storage.StorageArea)
    await Promise.all([
      store.modify("openai-codex", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return { type: "oauth", access: "access-1", refresh: "refresh-1", expires: 1 }
      }),
      store.modify("openai-codex", async (current) => ({
        ...(current as OAuthCredential),
        access: "access-2",
        refresh: "refresh-2",
      })),
    ])

    await expect(store.read("openai-codex")).resolves.toMatchObject({
      access: "access-2",
      refresh: "refresh-2",
    })
    await expect(store.list()).resolves.toEqual([{ providerId: "openai-codex", type: "oauth" }])
    await store.delete("openai-codex")
    await expect(store.read("openai-codex")).resolves.toBeUndefined()
  })

  test("allows Models to perform one effective refresh for concurrent callers", async () => {
    const store = new ChromeCredentialStore(
      new MemoryStorage() as unknown as chrome.storage.StorageArea,
    )
    await store.modify("test", async () => ({
      type: "oauth",
      access: "expired",
      refresh: "refresh-old",
      expires: 0,
    }))
    const refresh = vi.fn(async (credential: OAuthCredential) => {
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        ...credential,
        access: "fresh",
        refresh: "refresh-new",
        expires: Date.now() + 3_600_000,
      }
    })
    const models = createModels({
      credentials: store,
      authContext: { env: async () => undefined, fileExists: async () => false },
    })
    models.setProvider(
      createProvider({
        id: "test",
        auth: {
          oauth: {
            name: "test",
            login: async () => {
              throw new Error("unused")
            },
            refresh,
            toAuth: async (credential) => ({ apiKey: credential.access }),
          },
        },
        models: [],
        api: {
          stream() {
            throw new Error("unused")
          },
          streamSimple() {
            throw new Error("unused")
          },
        },
      }),
    )

    const results = await Promise.all([models.getAuth("test"), models.getAuth("test")])
    expect(results).toEqual([
      { auth: { apiKey: "fresh" }, source: "OAuth" },
      { auth: { apiKey: "fresh" }, source: "OAuth" },
    ])
    expect(refresh).toHaveBeenCalledOnce()
    await expect(store.read("test")).resolves.toMatchObject({ refresh: "refresh-new" })
  })
})

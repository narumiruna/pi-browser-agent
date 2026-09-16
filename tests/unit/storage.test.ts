import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { getBoundTabId, getBridgeSettings, saveBoundTabId } from "../../src/browser/storage.js"

const LOCAL_KEY = "piChromeBridgeSettings"
const SESSION_KEY = "piChromeBoundTabId"
const validSecret = Buffer.alloc(32, 7).toString("base64url")

let localValues: Record<string, unknown>
let sessionValues: Record<string, unknown>

beforeEach(() => {
  localValues = {}
  sessionValues = {}
  const storageArea = (values: Record<string, unknown>) => ({
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => Object.assign(values, items)),
    remove: vi.fn(async (key: string) => {
      delete values[key]
    }),
  })
  vi.stubGlobal("chrome", {
    storage: {
      local: storageArea(localValues),
      session: storageArea(sessionValues),
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("browser bridge storage", () => {
  test("migrates a legacy persisted tab binding out of local storage", async () => {
    localValues[LOCAL_KEY] = {
      enabled: true,
      port: 17_373,
      secret: validSecret,
      clientId: "client-id",
      boundTabId: 42,
    }

    await expect(getBridgeSettings()).resolves.toEqual({
      enabled: true,
      port: 17_373,
      secret: validSecret,
      clientId: "client-id",
    })
    expect(localValues[LOCAL_KEY]).not.toHaveProperty("boundTabId")
    expect(sessionValues).not.toHaveProperty(SESSION_KEY)
  })

  test("keeps tab bindings only for the current browser session", async () => {
    await saveBoundTabId(42)
    await expect(getBoundTabId()).resolves.toBe(42)

    delete sessionValues[SESSION_KEY]
    await expect(getBoundTabId()).resolves.toBeUndefined()
  })

  test("removes a session binding when it is cleared", async () => {
    await saveBoundTabId(42)
    await saveBoundTabId(undefined)

    await expect(getBoundTabId()).resolves.toBeUndefined()
  })
})

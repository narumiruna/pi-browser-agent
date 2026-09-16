import { isPairingSecret } from "../protocol/index.js"

export const DEFAULT_BRIDGE_PORT = 17_373

export interface StoredBridgeSettings {
  enabled: boolean
  port: number
  secret?: string
  clientId: string
}

const LOCAL_STORAGE_KEY = "piChromeBridgeSettings"
const SESSION_TAB_KEY = "piChromeBoundTabId"

export async function getBridgeSettings(): Promise<StoredBridgeSettings> {
  const stored = await chrome.storage.local.get(LOCAL_STORAGE_KEY)
  const value = stored[LOCAL_STORAGE_KEY] as
    | (Partial<StoredBridgeSettings> & { boundTabId?: unknown })
    | undefined
  const clientId =
    typeof value?.clientId === "string" && value.clientId.length > 0 && value.clientId.length <= 256
      ? value.clientId
      : crypto.randomUUID()
  const port =
    Number.isInteger(value?.port) && (value?.port ?? 0) >= 1024 && (value?.port ?? 0) <= 65_535
      ? (value?.port as number)
      : DEFAULT_BRIDGE_PORT
  const settings: StoredBridgeSettings = {
    enabled: value?.enabled === true,
    port,
    clientId,
    ...(isPairingSecret(value?.secret) ? { secret: value.secret } : {}),
  }
  const hasLegacyBoundTab = typeof value === "object" && value !== null && "boundTabId" in value
  if (clientId !== value?.clientId || port !== value?.port || hasLegacyBoundTab) {
    await saveBridgeSettings(settings)
  }
  return settings
}

export async function saveBridgeSettings(settings: StoredBridgeSettings): Promise<void> {
  await chrome.storage.local.set({ [LOCAL_STORAGE_KEY]: settings })
}

export async function updateBridgeSettings(
  patch: Partial<StoredBridgeSettings>,
): Promise<StoredBridgeSettings> {
  const current = await getBridgeSettings()
  const next = { ...current, ...patch }
  await saveBridgeSettings(next)
  return next
}

export async function getBoundTabId(): Promise<number | undefined> {
  const stored = await chrome.storage.session.get(SESSION_TAB_KEY)
  const value = stored[SESSION_TAB_KEY]
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : undefined
}

export async function saveBoundTabId(tabId: number | undefined): Promise<void> {
  if (tabId === undefined) {
    await chrome.storage.session.remove(SESSION_TAB_KEY)
    return
  }
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Invalid Chrome tab ID")
  await chrome.storage.session.set({ [SESSION_TAB_KEY]: tabId })
}

export async function clearPairing(): Promise<StoredBridgeSettings> {
  const current = await getBridgeSettings()
  const next: StoredBridgeSettings = {
    enabled: false,
    port: current.port,
    clientId: current.clientId,
  }
  await saveBridgeSettings(next)
  return next
}

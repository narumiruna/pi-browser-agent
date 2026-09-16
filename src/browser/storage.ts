export const DEFAULT_BRIDGE_PORT = 17_373

export interface StoredBridgeSettings {
  enabled: boolean
  port: number
  secret?: string
  clientId: string
  boundTabId?: number
}

const STORAGE_KEY = "piChromeBridgeSettings"

export async function getBridgeSettings(): Promise<StoredBridgeSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY)
  const value = stored[STORAGE_KEY] as Partial<StoredBridgeSettings> | undefined
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
    ...(typeof value?.secret === "string" && /^[A-Za-z0-9_-]{43}$/.test(value.secret)
      ? { secret: value.secret }
      : {}),
    ...(Number.isInteger(value?.boundTabId) && (value?.boundTabId ?? -1) >= 0
      ? { boundTabId: value?.boundTabId as number }
      : {}),
  }
  if (clientId !== value?.clientId || port !== value?.port) await saveBridgeSettings(settings)
  return settings
}

export async function saveBridgeSettings(settings: StoredBridgeSettings): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEY]: settings })
}

export async function updateBridgeSettings(
  patch: Partial<StoredBridgeSettings>,
): Promise<StoredBridgeSettings> {
  const current = await getBridgeSettings()
  const next = { ...current, ...patch }
  await saveBridgeSettings(next)
  return next
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

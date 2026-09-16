import { randomBytes } from "node:crypto"
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

export const DEFAULT_BRIDGE_PORT = 17_373

export interface BridgeConfig {
  port: number
  secret?: string
  allowedExtensionId?: string
}

export class BridgeConfigStore {
  readonly path: string

  constructor(path = join(getAgentDir(), "pi-chrome.json")) {
    this.path = path
  }

  async load(): Promise<BridgeConfig> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<BridgeConfig>
      return {
        port: normalizePort(parsed.port),
        ...(isSecret(parsed.secret) ? { secret: parsed.secret } : {}),
        ...(isExtensionId(parsed.allowedExtensionId)
          ? { allowedExtensionId: parsed.allowedExtensionId }
          : {}),
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      return { port: normalizePort(undefined) }
    }
  }

  async save(config: BridgeConfig): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
    await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, this.path)
    await chmod(this.path, 0o600)
  }

  async createPairing(): Promise<{ config: BridgeConfig; secret: string }> {
    const current = await this.load()
    const secret = randomBytes(32).toString("base64url")
    const config: BridgeConfig = { port: current.port, secret }
    await this.save(config)
    return { config, secret }
  }

  async bindExtension(extensionId: string): Promise<BridgeConfig> {
    if (!isExtensionId(extensionId)) throw new Error("Invalid Chrome extension id")
    const current = await this.load()
    const config = { ...current, allowedExtensionId: extensionId }
    await this.save(config)
    return config
  }

  async revoke(): Promise<BridgeConfig> {
    const current = await this.load()
    const config = { port: current.port }
    await this.save(config)
    return config
  }
}

function normalizePort(port: unknown): number {
  const fromEnvironment = Number(process.env.PI_CHROME_PORT)
  if (Number.isInteger(fromEnvironment) && fromEnvironment >= 1024 && fromEnvironment <= 65_535) {
    return fromEnvironment
  }
  return typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65_535
    ? port
    : DEFAULT_BRIDGE_PORT
}

function isSecret(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value)
}

export function isExtensionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-p]{32}$/.test(value)
}

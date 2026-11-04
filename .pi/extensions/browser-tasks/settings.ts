import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { TaskError } from "../../../src/browser/coding-agent/protocol.js"

export function publicExtensionId(value: unknown): string {
  if (typeof value !== "string" || value.length !== 32 || !/^[a-p]{32}$/.test(value)) {
    throw new TaskError(
      "Enter the public extension ID: exactly 32 lowercase letters a–p from chrome://extensions. No connection was opened.",
    )
  }
  return value
}

export async function loadBrowserSettings(
  path: string,
): Promise<Record<string, unknown> & { extensionId?: string }> {
  try {
    const stats = await lstat(path)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 16 * 1024) throw new Error()
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    const document = value as Record<string, unknown>
    return {
      ...document,
      ...(Object.hasOwn(document, "extensionId")
        ? { extensionId: publicExtensionId(document.extensionId) }
        : {}),
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {}
    throw new TaskError(
      `Fix the Browser Agent settings at ${path} before connecting. The file was not changed.`,
    )
  }
}

export async function saveBrowserExtensionId(path: string, extensionId: string): Promise<void> {
  publicExtensionId(extensionId)
  const document = await loadBrowserSettings(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(temporary, `${JSON.stringify({ ...document, extensionId }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    })
    await rename(temporary, path)
  } catch {
    throw new TaskError(
      `Could not save the Browser Agent extension ID at ${path}. No connection was opened.`,
    )
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

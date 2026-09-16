import { readdir, readFile, stat } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { NODE_BUILTIN_IMPORT } from "../tooling/node-builtins.mjs"

const root = resolve("dist/chrome")
const files = []
async function walk(directory) {
  for (const name of await readdir(directory)) {
    const path = join(directory, name)
    const details = await stat(path)
    if (details.isDirectory()) await walk(path)
    else files.push(path)
  }
}
await walk(root)

const failures = []
for (const path of files) {
  const name = relative(root, path)
  const contents = await readFile(path, "utf8").catch(() => "")
  const checks = [
    [NODE_BUILTIN_IMPORT, "Node built-in import"],
    [/(?:ws|wss):\/\/(?:127\.0\.0\.1|localhost)|127\.0\.0\.1:17373/, "localhost bridge URL"],
    [/<script[^>]+src=["']https?:\/\//i, "remote executable script"],
    [
      /(?:access_token|refresh_token)["']?\s*[:=]\s*["'][A-Za-z0-9._-]{20,}/i,
      "embedded credential",
    ],
  ]
  for (const [pattern, label] of checks) {
    if (pattern.test(contents)) failures.push(`${name}: ${label}`)
  }
}

const manifest = JSON.parse(await readFile(join(root, "manifest.json"), "utf8"))
const expectedPermissions = ["activeTab", "contextMenus", "scripting", "sidePanel", "storage"]
const expectedOrigins = [
  "https://auth.openai.com/*",
  "https://chatgpt.com/*",
  "http://*/*",
  "https://*/*",
]
for (const permission of manifest.permissions ?? []) {
  if (!expectedPermissions.includes(permission))
    failures.push(`manifest.json: unexpected permission ${permission}`)
}
for (const origin of manifest.optional_host_permissions ?? []) {
  if (!expectedOrigins.includes(origin))
    failures.push(`manifest.json: unexpected optional host ${origin}`)
}
if (manifest.host_permissions?.length)
  failures.push("manifest.json: production host_permissions must be empty")
if (files.some((path) => path.endsWith(".map")))
  failures.push("production artifact contains source maps")

if (failures.length > 0) {
  console.error(`Artifact audit failed:\n${failures.map((failure) => `- ${failure}`).join("\n")}`)
  process.exitCode = 1
} else {
  console.log(`Artifact audit passed (${files.length} files checked).`)
}

import { readdir, readFile } from "node:fs/promises"
import { join, relative, resolve } from "node:path"
import { containsNodeBuiltinImport } from "../tooling/node-builtins.mjs"

const root = resolve(process.env.PI_BROWSER_AGENT_ARTIFACT_ROOT ?? "dist/chrome")
const files = (await readdir(root, { recursive: true, withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name))
  .sort()
const artifactFiles = new Set(files.map((path) => relative(root, path).replaceAll("\\", "/")))

const failures = []
for (const path of files) {
  const name = relative(root, path)
  const contents = await readFile(path, "utf8").catch(() => "")
  if (containsNodeBuiltinImport(contents)) failures.push(`${name}: Node built-in import`)
  const checks = [
    [/(?:ws|wss):\/\/(?:127\.0\.0\.1|localhost)|127\.0\.0\.1:17373/, "localhost bridge URL"],
    [/<script[^>]+src=["']https?:\/\//i, "remote executable script"],
    [/\.bookmarks\.(?:create|move|remove|removeTree|update)\s*\(/, "bookmark mutation call"],
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
// Chrome resolves native message references at runtime. Keep the placeholders intact.
const nativeReferences = new Set()
function collectNativeReferences(value) {
  if (typeof value === "string") {
    const remainder = value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (_match, key) => {
      if (!key.startsWith("@@")) nativeReferences.add(key.toLowerCase())
      return ""
    })
    if (remainder.includes("__MSG_"))
      failures.push("manifest.json: malformed native message reference")
  } else if (Array.isArray(value)) {
    for (const item of value) collectNativeReferences(item)
  } else if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectNativeReferences(item)
  }
}
collectNativeReferences(manifest)
const nativeCatalogPaths = [...artifactFiles].filter((path) =>
  /^_locales\/[^/]+\/messages\.json$/.test(path),
)
const defaultLocale = manifest.default_locale
if (defaultLocale !== undefined || nativeCatalogPaths.length || nativeReferences.size) {
  if (typeof defaultLocale !== "string" || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(defaultLocale)) {
    failures.push("manifest.json: valid default_locale is required for native catalogs/references")
  } else if (!artifactFiles.has(`_locales/${defaultLocale}/messages.json`)) {
    failures.push(
      `manifest.json: missing default locale catalog _locales/${defaultLocale}/messages.json`,
    )
  }
  for (const path of nativeCatalogPaths) {
    let catalog
    try {
      catalog = JSON.parse(await readFile(join(root, path), "utf8"))
    } catch {
      failures.push(`${path}: malformed native catalog JSON`)
      continue
    }
    if (
      !catalog ||
      typeof catalog !== "object" ||
      Array.isArray(catalog) ||
      !Object.keys(catalog).length
    ) {
      failures.push(`${path}: native catalog must be a non-empty object`)
      continue
    }
    const keys = new Set()
    for (const [key, entry] of Object.entries(catalog)) {
      const normalizedKey = key.toLowerCase()
      if (!/^[A-Za-z0-9_@]+$/.test(key) || keys.has(normalizedKey))
        failures.push(`${path}: invalid or duplicate native key ${key}`)
      keys.add(normalizedKey)
      if (
        !entry ||
        typeof entry !== "object" ||
        Array.isArray(entry) ||
        typeof entry.message !== "string" ||
        !entry.message.trim()
      ) {
        failures.push(`${path}: native key ${key} requires a non-empty message`)
      }
    }
    for (const key of nativeReferences) {
      if (!keys.has(key)) failures.push(`${path}: missing native message key ${key}`)
    }
  }
}

const iconPaths = (icons) => {
  if (typeof icons === "string") return [icons]
  if (!icons || typeof icons !== "object") return []
  return Object.values(icons).filter((path) => typeof path === "string")
}
const extensionIcons = iconPaths(manifest.icons)
const actionIcons = iconPaths(manifest.action?.default_icon)
if (extensionIcons.length === 0) failures.push("manifest.json: extension icons must be declared")
if (actionIcons.length === 0) failures.push("manifest.json: action icons must be declared")
for (const iconPath of new Set([...extensionIcons, ...actionIcons])) {
  const normalizedPath = iconPath.replaceAll("\\", "/").replace(/^\/+/, "")
  if (!artifactFiles.has(normalizedPath)) {
    failures.push(`manifest.json: missing icon file ${iconPath}`)
  }
}

const expectedPermissions = [
  "activeTab",
  "contextMenus",
  "scripting",
  "sidePanel",
  "storage",
  "tabs",
]
const expectedOptionalPermissions = ["bookmarks"]
const expectedOrigins = [
  "https://auth.openai.com/*",
  "https://chatgpt.com/*",
  "http://*/*",
  "https://*/*",
  "<all_urls>",
]
const requiredOptionalOrigins = ["<all_urls>"]
for (const permission of manifest.permissions ?? []) {
  if (!expectedPermissions.includes(permission))
    failures.push(`manifest.json: unexpected permission ${permission}`)
}
for (const permission of manifest.optional_permissions ?? []) {
  if (!expectedOptionalPermissions.includes(permission)) {
    failures.push(`manifest.json: unexpected optional permission ${permission}`)
  }
}
for (const permission of expectedOptionalPermissions) {
  if (!(manifest.optional_permissions ?? []).includes(permission)) {
    failures.push(`manifest.json: missing optional permission ${permission}`)
  }
}
for (const origin of manifest.optional_host_permissions ?? []) {
  if (!expectedOrigins.includes(origin))
    failures.push(`manifest.json: unexpected optional host ${origin}`)
}
for (const origin of requiredOptionalOrigins) {
  if (!(manifest.optional_host_permissions ?? []).includes(origin)) {
    failures.push(`manifest.json: missing optional host ${origin}`)
  }
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

import { readFile, writeFile } from "node:fs/promises"

const packageJson = JSON.parse(await readFile("package.json", "utf8"))
const manifestSource = await readFile("manifest.json", "utf8")
const manifest = JSON.parse(manifestSource)
const version = packageJson.version

const parts = typeof version === "string" ? version.split(".") : []
const isChromeVersion =
  parts.length >= 1 &&
  parts.length <= 4 &&
  parts.every((part) => /^(0|[1-9]\d*)$/.test(part) && Number(part) >= 0 && Number(part) <= 65_535)

if (!isChromeVersion) {
  throw new Error(
    `Package version ${JSON.stringify(version)} is not a valid Chrome extension version`,
  )
}

if (manifest.version !== version) {
  const updatedManifest = manifestSource.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`)

  if (updatedManifest === manifestSource) {
    throw new Error("Could not update the manifest version")
  }

  await writeFile("manifest.json", updatedManifest)
}

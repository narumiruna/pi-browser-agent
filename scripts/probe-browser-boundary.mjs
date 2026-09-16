import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { build } from "esbuild"

const output = await mkdtemp(join(tmpdir(), "pi-chrome-browser-probe-"))
try {
  await build({
    entryPoints: [resolve("scripts/probes/browser-boundary.ts")],
    outdir: output,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "chrome116",
    define: { process: "undefined" },
    minify: true,
    metafile: true,
    logLevel: "warning",
  })

  const inventory = []
  async function walk(directory) {
    for (const name of await readdir(directory)) {
      const path = join(directory, name)
      const details = await stat(path)
      if (details.isDirectory()) await walk(path)
      else inventory.push({ file: relative(output, path), bytes: details.size })
    }
  }
  await walk(output)
  inventory.sort((left, right) => left.file.localeCompare(right.file))
  for (const item of inventory) {
    const contents = await readFile(join(output, item.file), "utf8")
    if (/\b(?:import|from|require\s*\()["']node:/.test(contents)) {
      throw new Error(`Browser boundary emitted a Node built-in import in ${item.file}`)
    }
  }
  console.log("Browser boundary chunk inventory:")
  for (const item of inventory) console.log(`${item.file}\t${item.bytes} bytes`)
} finally {
  await rm(output, { recursive: true, force: true })
}

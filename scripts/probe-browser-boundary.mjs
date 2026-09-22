import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { build } from "esbuild"
import { containsNodeBuiltinImport } from "../tooling/node-builtins.mjs"

const output = await mkdtemp(join(tmpdir(), "pi-browser-agent-browser-probe-"))
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

  const inventory = await Promise.all(
    (await readdir(output, { recursive: true, withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const path = join(entry.parentPath, entry.name)
        return { file: relative(output, path), bytes: (await stat(path)).size }
      }),
  )
  inventory.sort((left, right) => left.file.localeCompare(right.file))
  for (const item of inventory) {
    const contents = await readFile(join(output, item.file), "utf8")
    if (containsNodeBuiltinImport(contents)) {
      throw new Error(`Browser boundary emitted a Node built-in import in ${item.file}`)
    }
  }
  console.log("Browser boundary chunk inventory:")
  for (const item of inventory) console.log(`${item.file}\t${item.bytes} bytes`)
} finally {
  await rm(output, { recursive: true, force: true })
}

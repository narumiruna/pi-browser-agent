import { rspack } from "@rspack/core"

/** @type {import("extension").FileConfig} */
export default {
  folders: { pages: "src/browser/pages" },
  include: {
    "pdf/cmaps": "./node_modules/pdfjs-dist/cmaps",
    "pdf/standard_fonts": "./node_modules/pdfjs-dist/standard_fonts",
    ...Object.fromEntries(
      [
        "jbig2.wasm",
        "jbig2_nowasm_fallback.js",
        "openjpeg.wasm",
        "openjpeg_nowasm_fallback.js",
        "qcms_bg.wasm",
        "LICENSE_JBIG2",
        "LICENSE_OPENJPEG",
        "LICENSE_PDFJS_JBIG2",
        "LICENSE_PDFJS_OPENJPEG",
        "LICENSE_PDFJS_QCMS",
        "LICENSE_QCMS",
      ].map((name) => [`pdf/wasm/${name}`, `./node_modules/pdfjs-dist/wasm/${name}`]),
    ),
    "pdf/iccs": "./node_modules/pdfjs-dist/iccs",
    "pdf/LICENSE": "./node_modules/pdfjs-dist/LICENSE",
  },
  config(config) {
    config.plugins ??= []
    config.plugins.push(
      new rspack.DefinePlugin({
        process: "undefined",
        "global.process": "undefined",
        __PI_BROWSER_AGENT_DEVELOPER_MODE__: JSON.stringify(config.mode === "development"),
      }),
    )
    return config
  },
}

import { rspack } from "@rspack/core"

/** @type {import("extension").FileConfig} */
export default {
  config(config) {
    config.plugins ??= []
    config.plugins.push(
      new rspack.DefinePlugin({
        process: "undefined",
        "global.process": "undefined",
      }),
    )
    return config
  },
}

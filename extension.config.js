import { rspack } from "@rspack/core"

/** @type {import("extension").FileConfig} */
export default {
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

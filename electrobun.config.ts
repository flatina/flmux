import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "flmux",
    identifier: "com.flatina.flmux",
    version: "0.2.0"
  },
  build: {
    bun: {
      entrypoint: "src/flmux/main/index.ts"
    },
    views: {
      mainview: {
        entrypoint: "src/flmux/renderer/index.ts"
      }
    },
    copy: {
      "src/flmux/renderer/index.html": "views/mainview/index.html",
      "node_modules/bun-pty/rust-pty/target/release": "bun/rust-pty/target/release",
      "src/sdk": "node_modules/flmux-sdk",
      "ext": "ext"
    },
    mac: {
      bundleCEF: false
    },
    linux: {
      bundleCEF: false
    },
    win: {
      bundleCEF: false
    }
  }
} satisfies ElectrobunConfig;

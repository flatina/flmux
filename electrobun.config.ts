import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    name: "flmux",
    identifier: "com.flatina.flmux",
    version: "0.1.0"
  },
  build: {
    bun: {
      entrypoint: "src/main/index.ts"
    },
    views: {
      mainview: {
        entrypoint: "src/renderer/main.ts"
      }
    },
    copy: {
      "src/renderer/index.html": "views/mainview/index.html",
      "node_modules/bun-pty/rust-pty/target/release": "bun/rust-pty/target/release"
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

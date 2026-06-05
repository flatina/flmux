import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionConfigLoader } from "../src/main/extConfig";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "flmux-ext-config-"));
  tempRoots.push(dir);
  return dir;
}

describe("createExtensionConfigLoader", () => {
  it("resolves relative paths against dataDir, layers env over file", async () => {
    const dir = dataDir();
    writeFileSync(join(dir, "dbs.toml"), `[conns.a]\nstring = "from-file"\n\ndefault = "a"\n`);
    const disposers: Array<() => void> = [];
    const loadConfig = createExtensionConfigLoader({
      extId: "test.ext",
      dataDir: dir,
      registerDispose: (fn) => disposers.push(fn)
    });

    type Dbs = { conns: Record<string, { string: string }>; default?: string };
    const realEnv = process.env.TEST_EXT_DEFAULT;
    process.env.TEST_EXT_DEFAULT = "b";
    try {
      const config = await loadConfig<Dbs>((b) =>
        b
          .useDefaults({ conns: {} })
          .useTomlFile("dbs.toml", { required: false })
          .useEnv({ map: { TEST_EXT_DEFAULT: "default" } })
          .validate((value) => {
            if (!value.conns) throw new Error("conns required");
          })
      );
      expect(config.value.conns.a?.string).toBe("from-file");
      expect(config.value.default).toBe("b"); // env overrides file
      const trace = config.getTrace("conns").find((t) => t.effective);
      expect(String(trace?.meta?.path ?? "")).toContain(dir);
    } finally {
      if (realEnv === undefined) delete process.env.TEST_EXT_DEFAULT;
      else process.env.TEST_EXT_DEFAULT = realEnv;
    }
    expect(disposers.length).toBe(1);
    for (const dispose of disposers) dispose();
  });

  it("validate failure rejects load", async () => {
    const dir = dataDir();
    const loadConfig = createExtensionConfigLoader({
      extId: "test.ext",
      dataDir: dir,
      registerDispose: () => {}
    });
    await expect(
      loadConfig<{ x: number }>((b) =>
        b.useDefaults({}).validate(() => {
          throw new Error("nope");
        })
      )
    ).rejects.toThrow();
  });
});

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { FlmuxLastFile } from "../shared/flmux-last";
import { getFlmuxLastPath } from "../shared/paths";

export class FlmuxLastStore {
  constructor(private readonly filePath = getFlmuxLastPath()) {}

  async load(): Promise<FlmuxLastFile | null> {
    try {
      const raw = await readFile(this.filePath, "utf-8");
      return JSON.parse(raw) as FlmuxLastFile;
    } catch (error) {
      if (isMissingFileError(error)) {
        return null;
      }

      throw error;
    }
  }

  async save(file: FlmuxLastFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(file, null, 2)}\n`, "utf-8");
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

import { createHash } from "node:crypto";
import { normalizeTerminalRootDir } from "./terminalPath";

export function toTerminalRootKey(rootDir: string) {
  const normalized = normalizeTerminalRootDir(rootDir);
  return `root_${createHash("sha1").update(normalized.toLowerCase()).digest("hex").slice(0, 12)}`;
}

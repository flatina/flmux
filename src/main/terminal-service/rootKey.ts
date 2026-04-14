import { createHash } from "node:crypto";
import {
  normalizeTerminalRootDir,
  resolveTerminalCwdFromRoot
} from "../../shared/terminalPath";

export { normalizeTerminalRootDir, resolveTerminalCwdFromRoot } from "../../shared/terminalPath";

export function toTerminalRootKey(rootDir: string) {
  const normalized = normalizeTerminalRootDir(rootDir);
  return `root_${createHash("sha1").update(normalized.toLowerCase()).digest("hex").slice(0, 12)}`;
}

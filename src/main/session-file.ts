import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getSessionRecordPath } from "../shared/paths";
import type { SessionRecord } from "../shared/session-record";

export class SessionFileManager {
  constructor(private readonly filePath: string) {}

  static fromSessionRecord(record: SessionRecord): SessionFileManager {
    return new SessionFileManager(getSessionRecordPath(record.sessionId));
  }

  async write(record: SessionRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
  }

  async remove(): Promise<void> {
    try {
      await rm(this.filePath, { force: true });
    } catch {
      // best effort cleanup
    }
  }
}

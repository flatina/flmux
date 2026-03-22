import { defineCommand } from "citty";
import type { SessionId } from "../../shared/ids";
import { cleanupStaleSessions, listSessions, resolveSession } from "../session-discovery";
import { output } from "./_utils";

export default defineCommand({
  meta: { name: "session", description: "Manage app sessions" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list", description: "List all sessions" },
      run: async () => output({ sessions: await listSessions() })
    }),
    get: defineCommand({
      meta: { name: "get", description: "Get a specific session" },
      args: {
        id: { type: "positional", description: "Session ID", required: false }
      },
      run: async ({ args }) => output({ session: await resolveSession(args.id as SessionId | undefined) })
    }),
    cleanup: defineCommand({
      meta: { name: "cleanup", description: "Remove stale sessions" },
      run: async () => output(await cleanupStaleSessions())
    })
  }
});

import { defineExtensionServer, definePaneSpec } from "@flmux/extension-api";
import { normalizeScratchpadText } from "./helpers";

export default defineExtensionServer({
  panes: [
    definePaneSpec({
      kind: "scratchpad",
      createParams: ({ input }) => ({ note: normalizeScratchpadText(input.params?.note) }),
      normalizeRestoredParams: ({ params }) => ({ note: normalizeScratchpadText(params?.note) }),
      serializeParams: ({ currentParams }) => ({ note: normalizeScratchpadText(currentParams?.note) }),
      pathMount: {
        mountKey: "scratchpad",
        getStateSnapshot: ({ currentParams }) => ({ note: normalizeScratchpadText(currentParams?.note) }),
        canSetStatePath: ({ relativePath }) => relativePath.length === 1 && relativePath[0] === "note",
        setState: async ({ relativePath, value, setParams }) => {
          if (relativePath.length !== 1 || relativePath[0] !== "note") {
            throw new Error(`Unsupported scratchpad path '${relativePath.join("/")}'`);
          }
          const note = normalizeScratchpadText(value);
          await setParams({ note });
          return { value: note };
        },
        canCallStatePath: ({ relativePath }) =>
          relativePath.length === 1 && (relativePath[0] === "stats" || relativePath[0] === "clear"),
        callState: async ({ relativePath, currentParams, patchParams }) => {
          const op = relativePath[0];
          if (op === "stats") {
            const note = normalizeScratchpadText(currentParams?.note);
            return {
              value: {
                chars: note.length,
                words: note.trim() === "" ? 0 : note.trim().split(/\s+/).length,
                lines: note === "" ? 0 : note.split(/\r?\n/).length
              }
            };
          }
          if (op === "clear") {
            await patchParams({ note: "" });
            return { value: { cleared: true } };
          }
          throw new Error(`Unsupported scratchpad op '${op}'`);
        },
        getStatusSnapshot: ({ currentParams }) => {
          const note = normalizeScratchpadText(currentParams?.note);
          return { noteLength: note.length };
        }
      }
    })
  ]
});

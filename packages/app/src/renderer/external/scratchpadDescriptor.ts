import { ScratchpadPaneRenderer, normalizeScratchpadText } from "./scratchpadPane";
import { createExternalPaneDescriptor } from "./runtime";

export const scratchpadPaneDescriptor = createExternalPaneDescriptor({
  kind: "scratchpad",
  createRenderer: (context) => new ScratchpadPaneRenderer(context),
  createParams: ({ input }) => ({
    note: normalizeScratchpadText(input.params?.note)
  }),
  getTitle: ({ input }) => input.title?.trim() || "Scratchpad",
  normalizeRestoredParams: ({ params }) => ({
    note: normalizeScratchpadText(params?.note)
  }),
  serializeParams: ({ currentParams }) => ({
    note: normalizeScratchpadText(currentParams?.note)
  }),
  pathMount: {
    mountKey: "scratchpad",
    getStateSnapshot: ({ currentParams }) => {
      const note = normalizeScratchpadText(currentParams?.note);
      return { note };
    },
    canSetStatePath: ({ relativePath }) => relativePath.length === 1 && relativePath[0] === "note",
    setState: async ({ relativePath, value, setParams }) => {
      if (relativePath.length !== 1 || relativePath[0] !== "note") {
        throw new Error(`Unsupported scratchpad path '${relativePath.join("/")}'`);
      }

      const note = normalizeScratchpadText(value);
      await setParams({ note });
      return { value: note };
    },
    getStatusSnapshot: ({ currentParams }) => {
      const note = normalizeScratchpadText(currentParams?.note);
      return {
        noteLength: note.length
      };
    }
  }
});

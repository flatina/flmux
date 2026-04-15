import type { FlmuxExtensionCliContext } from "@flmux/extension-api";

export async function run(context: FlmuxExtensionCliContext) {
  const title = context.argv.join(" ").trim();
  const client = await context.getClient();
  const result = await client.call("/panes/new", {
    kind: "cowsay",
    place: "right",
    ...(title ? { title } : {})
  });
  context.print(result);
}

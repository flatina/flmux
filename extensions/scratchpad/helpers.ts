export function normalizeScratchpadText(value: unknown): string {
  if (typeof value === "string") return value;
  return "";
}

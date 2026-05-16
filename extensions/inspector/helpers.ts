export function normalizeSubscription(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "*";
}

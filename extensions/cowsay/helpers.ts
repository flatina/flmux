import type { ShellPathGetResult } from "@flmux/extension-api";

export type OutputMode = "pretty" | "compact";

export const parser = {
  tokenize(command: string): string[] {
    const tokens: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let escaping = false;
    for (const char of command.trim()) {
      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if (quote) {
        if (char === quote) {
          quote = null;
          continue;
        }
        current += char;
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (/\s/.test(char)) {
        if (current) {
          tokens.push(current);
          current = "";
        }
        continue;
      }
      current += char;
    }
    if (quote) throw new Error("Unterminated quoted string");
    if (current) tokens.push(current);
    return tokens;
  },

  required(token: string | undefined, message: string): string {
    if (!token) throw new Error(message);
    return token;
  },

  parseNamedArgs(tokens: string[]) {
    const named: Record<string, unknown> = {};
    const extras: string[] = [];
    for (const token of tokens) {
      const equalsIndex = token.indexOf("=");
      if (equalsIndex <= 0) {
        extras.push(token);
        continue;
      }
      named[token.slice(0, equalsIndex)] = parser.coerceScalar(token.slice(equalsIndex + 1));
    }
    return { named, extras };
  },

  coerceScalar(rawValue: string): unknown {
    if (rawValue === "true") return true;
    if (rawValue === "false") return false;
    if (rawValue === "null") return null;
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) return Number(rawValue);
    if ((rawValue.startsWith("{") && rawValue.endsWith("}")) || (rawValue.startsWith("[") && rawValue.endsWith("]"))) {
      try {
        return JSON.parse(rawValue);
      } catch {
        return rawValue;
      }
    }
    return rawValue;
  }
} as const;

export function ensureStylesheet(id: string, href: string) {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export function unwrapValue(result: ShellPathGetResult) {
  if (!result.ok) return result;
  return result.found ? result.value : { found: false };
}

export function formatValue(value: unknown, mode: OutputMode): string {
  if (typeof value === "string") return value;
  return mode === "compact" ? JSON.stringify(value) : JSON.stringify(value, null, 2);
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

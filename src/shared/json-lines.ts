const textDecoder = new TextDecoder();

function toUtf8String(chunk: string | Buffer | Uint8Array): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  return textDecoder.decode(chunk);
}

export function toJsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

export function createJsonLineParser(onValue: (value: unknown) => void): (chunk: string | Buffer | Uint8Array) => void {
  let buffer = "";

  return (chunk) => {
    buffer += toUtf8String(chunk);

    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }

      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (!line) {
        continue;
      }

      try {
        onValue(JSON.parse(line) as unknown);
      } catch {
        // ignore malformed frames
      }
    }
  };
}

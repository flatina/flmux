const decoder = new TextDecoder();

function toUtf8String(chunk: string | Buffer | Uint8Array) {
  if (typeof chunk === "string") {
    return chunk;
  }

  return decoder.decode(chunk);
}

export function toJsonLine(value: unknown) {
  return `${JSON.stringify(value)}\n`;
}

export function createJsonLineParser(onValue: (value: unknown) => void) {
  let buffer = "";

  return (chunk: string | Buffer | Uint8Array) => {
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
        onValue(JSON.parse(line));
      } catch {}
    }
  };
}

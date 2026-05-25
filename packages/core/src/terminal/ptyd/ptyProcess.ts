import { StringDecoder } from "node:string_decoder";

// pty backend over Bun.Terminal (Bun ≥1.3.5 POSIX, 1.3.14 adds Windows ConPTY).
// Replaces @flatina/bun-pty: no native librust_pty dlopen, every arch built into
// the Bun runtime. Bun.spawn's `terminal` option is absent from bun-types@1.3.14,
// so the slice we use is typed locally.

interface BunTerminalHandle {
  write(data: string): number;
  resize(cols: number, rows: number): void;
  close(): void;
}

interface BunTerminalSubprocess {
  readonly terminal: BunTerminalHandle;
  kill(): void;
}

type SpawnWithTerminal = (
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string>;
    terminal: { cols: number; rows: number; data: (term: BunTerminalHandle, chunk: Uint8Array) => void };
    onExit: (proc: BunTerminalSubprocess, exitCode: number | null, signal: number | string | null) => void;
  }
) => BunTerminalSubprocess;

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface PtySpawnOptions {
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  onData: (data: string) => void;
  onExit: (exitCode: number | null, signal: string | null) => void;
}

export function spawnPty(command: string, args: string[], options: PtySpawnOptions): PtyProcess {
  const spawnWithTerminal = Bun.spawn as unknown as SpawnWithTerminal;
  // pty output arrives as raw bytes; decode incrementally so a multi-byte UTF-8
  // sequence split across chunks isn't corrupted (xterm consumes strings).
  const decoder = new StringDecoder("utf8");
  const proc = spawnWithTerminal([command, ...args], {
    cwd: options.cwd,
    env: options.env,
    terminal: {
      cols: options.cols,
      rows: options.rows,
      data: (_term, chunk) => options.onData(decoder.write(Buffer.from(chunk)))
    },
    onExit: (_proc, exitCode, signal) =>
      options.onExit(typeof exitCode === "number" ? exitCode : null, signal == null ? null : String(signal))
  });
  return {
    write: (data) => void proc.terminal.write(data),
    resize: (cols, rows) => proc.terminal.resize(cols, rows),
    kill: () => proc.kill()
  };
}

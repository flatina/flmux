import type { ShellClient } from "./shell";

export interface FlmuxExtensionCliContext {
  commandId: string;
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  getClient(clientId?: string): Promise<ShellClient>;
  print(value: unknown): void;
  printError(message: string): void;
}

export type FlmuxExtensionCliRunner = (context: FlmuxExtensionCliContext) => Promise<void> | void;

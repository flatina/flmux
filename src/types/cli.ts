export interface ExtensionCliContext {
  args: Record<string, unknown>;
  getClient: (sessionId?: string) => Promise<{ call: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown> }>;
  output: (value: unknown) => void;
}

export interface ExtensionCliArg {
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

export interface ExtensionCliCommand {
  meta: { name: string; description?: string };
  args?: Record<string, ExtensionCliArg>;
  subCommands?: Record<string, ExtensionCliCommand>;
  run?: (ctx: ExtensionCliContext) => void | Promise<void>;
}

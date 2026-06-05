// Extension config store contract — a narrow structural subset of
// @flatina/confkit, so the host hands extensions its own confkit instance
// (single implementation/version, watcher lifecycle owned by the host)
// without this package taking a runtime dependency. Layering: registration
// order, later sources win; objects deep-merge, arrays replace wholesale.

export type ExtensionConfigDeepPartial<T> = T extends Date
  ? T
  : T extends readonly unknown[]
    ? T
    : T extends object
      ? { [K in keyof T]?: ExtensionConfigDeepPartial<T[K]> }
      : T;

export interface ExtensionConfigFileOptions {
  /** Default true; `false` tolerates a missing file. */
  required?: boolean;
  /** Reload + `onChange` on external edits (atomic-rename safe). */
  watch?: boolean | { debounceMs?: number };
}

export interface ExtensionConfigWritableFileOptions extends ExtensionConfigFileOptions {
  /** Create the file (and parent dirs) on first save. */
  create?: boolean;
}
// At most ONE writable file per store — `set`/`patch`/`unset` expose no target
// selector, so a second writable source makes writes ambiguous (rejected at
// write time by the host implementation).

export interface ExtensionConfigTrace {
  source: string;
  path: string;
  value: unknown;
  effective: boolean;
  /** File sources carry `{ path }` — resolve file-relative values against it. */
  meta?: Record<string, unknown> | undefined;
}

export interface ExtensionConfigBuilder<T> {
  useDefaults(value: ExtensionConfigDeepPartial<T>): this;
  /** Relative paths resolve against the extension's `dataDir`. */
  useTomlFile(path: string, options?: ExtensionConfigFileOptions): this;
  /** `set`/`patch` persist here (set values only — no layer back-copy). */
  useWritableTomlFile(path: string, options?: ExtensionConfigWritableFileOptions): this;
  /** Allowlist env: keys absent from `map` are ignored. Values coerce
   * ("true"/"false"/number-ish); path is dot-separated into the config. */
  useEnv(options: { map: Record<string, string> }): this;
  /** Runs after load/reload/set. Throw to reject (previous snapshot kept on
   * watched reloads); a returned value replaces the effective config. */
  validate(validator: (value: T) => T | void): this;
}

export interface ExtensionConfig<T> {
  readonly value: T;
  getTrace(path: string): ExtensionConfigTrace[];
  set(path: string, value: unknown): Promise<unknown>;
  patch(value: ExtensionConfigDeepPartial<T>): Promise<unknown>;
  unset(path: string): Promise<unknown>;
  reload(): Promise<void>;
  onChange(listener: (next: { value: T }, previous: { value: T }) => void): () => void;
}

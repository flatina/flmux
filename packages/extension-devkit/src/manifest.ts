// Internal copy of the manifest schema + validator, kept in sync with
// `packages/extension-api/src/manifest.ts`. Duplicated rather than imported
// so `@flmux/extension-devkit` has no runtime dependency on
// `@flmux/extension-api` — file-link consumers only need to
// install extension-api for their own code, not as a transitive dep for
// devkit. Drift is caught by the shared schema's tests and by the small
// stable surface (rarely changes).

export const FLMUX_EXTENSION_API_VERSION = 1;

export interface ExtensionManifestEntrypoints {
  renderer?: string;
  cli?: string;
  server?: string;
}

export interface ExtensionManifestCommand {
  id: string;
  description?: string;
  shim?: string;
}

export type PaneSingletonScope = "workspace" | "app";
export type PaneEdgeGroup = "left" | "right" | "top" | "bottom";

export interface ExtensionManifestPane {
  kind: string;
  defaultTitle?: string;
  singletonScope?: PaneSingletonScope;
  edgeGroup?: PaneEdgeGroup;
  icon?: string;
  minimumSize?: number;
  maximumSize?: number;
  initialSize?: number;
  newMenu?: boolean;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  apiVersion: number;
  entrypoints: ExtensionManifestEntrypoints;
  commands?: ExtensionManifestCommand[];
  panes?: ExtensionManifestPane[];
  devOnly?: boolean;
}

export type ExtensionManifestValidationResult =
  | { ok: true; manifest: ExtensionManifest }
  | { ok: false; errors: string[] };

export function validateExtensionManifest(value: unknown): ExtensionManifestValidationResult {
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["Manifest must be a JSON object"] };
  }

  const errors: string[] = [];
  const id = asNonEmptyString(value.id);
  const name = asNonEmptyString(value.name);
  const version = asNonEmptyString(value.version);
  const apiVersion = value.apiVersion;
  const entrypoints = value.entrypoints;
  const commands = value.commands;
  const panes = value.panes;

  if (!id) {
    errors.push("Manifest field 'id' must be a non-empty string");
  } else if (!isValidExtensionId(id)) {
    errors.push(
      "Manifest field 'id' must contain only ASCII letters, digits, '.', '_', '-' and not be '.' or '..'"
    );
  }
  if (!name) {
    errors.push("Manifest field 'name' must be a non-empty string");
  }
  if (!version) {
    errors.push("Manifest field 'version' must be a non-empty string");
  }
  if (apiVersion !== FLMUX_EXTENSION_API_VERSION) {
    errors.push(
      `Manifest field 'apiVersion' must be ${FLMUX_EXTENSION_API_VERSION}, got ${typeof apiVersion === "number" ? apiVersion : String(apiVersion)}`
    );
  }
  if (!isPlainObject(entrypoints)) {
    errors.push("Manifest field 'entrypoints' must be an object");
  }

  const renderer = isPlainObject(entrypoints) ? entrypoints.renderer : undefined;
  const cli = isPlainObject(entrypoints) ? entrypoints.cli : undefined;
  const server = isPlainObject(entrypoints) ? entrypoints.server : undefined;
  const rendererPath = validateManifestEntrypointPath(renderer, "entrypoints.renderer");
  const cliPath = validateManifestEntrypointPath(cli, "entrypoints.cli");
  const serverPath = validateManifestEntrypointPath(server, "entrypoints.server");
  const commandsResult = validateManifestCommands(commands, Boolean(cli));
  const panesResult = validateManifestPanes(panes);
  const devOnlyRaw = value.devOnly;
  if (devOnlyRaw !== undefined && typeof devOnlyRaw !== "boolean") {
    errors.push("Manifest field 'devOnly' must be a boolean when provided");
  }
  const devOnly = typeof devOnlyRaw === "boolean" ? devOnlyRaw : undefined;

  if (rendererPath) errors.push(rendererPath);
  if (cliPath) errors.push(cliPath);
  if (serverPath) errors.push(serverPath);
  if (!commandsResult.ok) errors.push(...commandsResult.errors);
  if (!panesResult.ok) errors.push(...panesResult.errors);

  if (!renderer && !cli && !server) {
    errors.push(
      "Manifest must define at least one of 'entrypoints.renderer', 'entrypoints.cli', or 'entrypoints.server'"
    );
  }

  if (errors.length > 0 || !id || !name || !version || !isPlainObject(entrypoints)) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    manifest: {
      id,
      name,
      version,
      apiVersion: FLMUX_EXTENSION_API_VERSION,
      entrypoints: {
        renderer: typeof renderer === "string" ? renderer.trim() : undefined,
        cli: typeof cli === "string" ? cli.trim() : undefined,
        server: typeof server === "string" ? server.trim() : undefined
      },
      commands: commandsResult.ok ? commandsResult.commands : undefined,
      panes: panesResult.ok ? panesResult.panes : undefined,
      ...(devOnly !== undefined ? { devOnly } : {})
    }
  };
}

function validateManifestEntrypointPath(value: unknown, label: string) {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) {
    return `Manifest field '${label}' must be a non-empty string when provided`;
  }
  const normalized = value.trim().replace(/\\/g, "/");
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith("/") || normalized.startsWith("//")) {
    return `Manifest field '${label}' must be a relative path`;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return `Manifest field '${label}' must stay within the extension directory`;
  }
  return null;
}

function asNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const VALID_EXTENSION_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
function isValidExtensionId(id: string): boolean {
  if (id === "." || id === "..") return false;
  return VALID_EXTENSION_ID_PATTERN.test(id);
}

function validateManifestCommands(value: unknown, hasCliEntrypoint: boolean) {
  if (value === undefined) {
    return hasCliEntrypoint
      ? {
          ok: false as const,
          errors: ["Manifest field 'commands' must be a non-empty array when 'entrypoints.cli' is set"]
        }
      : { ok: true as const, commands: undefined };
  }
  if (!hasCliEntrypoint) {
    return { ok: false as const, errors: ["Manifest field 'commands' requires 'entrypoints.cli'"] };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false as const,
      errors: ["Manifest field 'commands' must be a non-empty array when 'entrypoints.cli' is set"]
    };
  }

  const commands: ExtensionManifestCommand[] = [];
  const errors: string[] = [];
  const seenIds = new Set<string>();

  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`Manifest field 'commands[${index}]' must be an object`);
      return;
    }
    const id = asNonEmptyString(entry.id);
    const description = entry.description === undefined ? undefined : asNonEmptyString(entry.description);
    const shim = entry.shim === undefined ? undefined : asNonEmptyString(entry.shim);
    if (!id) {
      errors.push(`Manifest field 'commands[${index}].id' must be a non-empty string`);
      return;
    }
    if (entry.description !== undefined && !description) {
      errors.push(`Manifest field 'commands[${index}].description' must be a non-empty string when provided`);
      return;
    }
    if (entry.shim !== undefined && !shim) {
      errors.push(`Manifest field 'commands[${index}].shim' must be a non-empty string when provided`);
      return;
    }
    if (seenIds.has(id)) {
      errors.push(`Manifest field 'commands' contains duplicate command id '${id}'`);
      return;
    }
    seenIds.add(id);
    const command: ExtensionManifestCommand = { id };
    if (description) command.description = description;
    if (shim) command.shim = shim;
    commands.push(command);
  });

  return errors.length > 0 ? { ok: false as const, errors } : { ok: true as const, commands };
}

function validateManifestPanes(value: unknown) {
  if (value === undefined) return { ok: true as const, panes: undefined };
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false as const, errors: ["Manifest field 'panes' must be a non-empty array when provided"] };
  }

  const panes: ExtensionManifestPane[] = [];
  const errors: string[] = [];
  const seenKinds = new Set<string>();

  value.forEach((entry, index) => {
    if (!isPlainObject(entry)) {
      errors.push(`Manifest field 'panes[${index}]' must be an object`);
      return;
    }
    const kind = asNonEmptyString(entry.kind);
    const defaultTitle = entry.defaultTitle === undefined ? undefined : asNonEmptyString(entry.defaultTitle);
    const singletonScope = entry.singletonScope;
    const edgeGroup = entry.edgeGroup;
    const iconPath = validateManifestEntrypointPath(entry.icon, `panes[${index}].icon`);
    const minimumSizeRaw = entry.minimumSize;
    let minimumSize: number | undefined;
    if (minimumSizeRaw !== undefined) {
      if (typeof minimumSizeRaw !== "number" || !Number.isFinite(minimumSizeRaw) || minimumSizeRaw <= 0) {
        errors.push(`Manifest field 'panes[${index}].minimumSize' must be a positive finite number when provided`);
        return;
      }
      minimumSize = minimumSizeRaw;
    }
    const maximumSizeRaw = entry.maximumSize;
    let maximumSize: number | undefined;
    if (maximumSizeRaw !== undefined) {
      if (typeof maximumSizeRaw !== "number" || !Number.isFinite(maximumSizeRaw) || maximumSizeRaw <= 0) {
        errors.push(`Manifest field 'panes[${index}].maximumSize' must be a positive finite number when provided`);
        return;
      }
      maximumSize = maximumSizeRaw;
    }
    const initialSizeRaw = entry.initialSize;
    let initialSize: number | undefined;
    if (initialSizeRaw !== undefined) {
      if (typeof initialSizeRaw !== "number" || !Number.isFinite(initialSizeRaw) || initialSizeRaw <= 0) {
        errors.push(`Manifest field 'panes[${index}].initialSize' must be a positive finite number when provided`);
        return;
      }
      initialSize = initialSizeRaw;
    }
    if (!kind) {
      errors.push(`Manifest field 'panes[${index}].kind' must be a non-empty string`);
      return;
    }
    if (entry.defaultTitle !== undefined && !defaultTitle) {
      errors.push(`Manifest field 'panes[${index}].defaultTitle' must be a non-empty string when provided`);
      return;
    }
    if (singletonScope !== undefined && singletonScope !== "workspace" && singletonScope !== "app") {
      errors.push(`Manifest field 'panes[${index}].singletonScope' must be 'workspace' or 'app' when provided`);
      return;
    }
    if (edgeGroup !== undefined && edgeGroup !== "left" && edgeGroup !== "right" && edgeGroup !== "top" && edgeGroup !== "bottom") {
      errors.push(`Manifest field 'panes[${index}].edgeGroup' must be 'left'|'right'|'top'|'bottom' when provided`);
      return;
    }
    const newMenu = entry.newMenu;
    if (newMenu !== undefined && typeof newMenu !== "boolean") {
      errors.push(`Manifest field 'panes[${index}].newMenu' must be a boolean when provided`);
      return;
    }
    if (iconPath) {
      errors.push(iconPath);
      return;
    }
    if (seenKinds.has(kind)) {
      errors.push(`Manifest field 'panes' contains duplicate pane kind '${kind}'`);
      return;
    }
    const icon = entry.icon === undefined ? undefined : (entry.icon as string).trim().replace(/\\/g, "/");
    seenKinds.add(kind);
    panes.push({
      kind,
      ...(defaultTitle ? { defaultTitle } : {}),
      ...(singletonScope ? { singletonScope } : {}),
      ...(edgeGroup ? { edgeGroup } : {}),
      ...(icon ? { icon } : {}),
      ...(minimumSize !== undefined ? { minimumSize } : {}),
      ...(maximumSize !== undefined ? { maximumSize } : {}),
      ...(initialSize !== undefined ? { initialSize } : {}),
      ...(newMenu !== undefined ? { newMenu } : {})
    });
  });

  return errors.length > 0 ? { ok: false as const, errors } : { ok: true as const, panes };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

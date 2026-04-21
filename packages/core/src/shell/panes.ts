import type { TerminalRuntimeSummary } from "../terminal/terminal";
import type { Awaitable, NewPaneInput, ShellPaneRecordSnapshot, WorkspaceBus } from "./types";

export interface PaneWorkspaceContext {
  id: string;
  defaultBrowserPath: string;
  bus: WorkspaceBus;
  appOrigin: string;
}

export type BrowserPaneStateRecord = { kind: "browser"; url: string };

export type TerminalPaneStateRecord = {
  kind: "terminal";
  cwd: string;
  rootKey: string | null;
  runtimeId: string | null;
  summary: TerminalRuntimeSummary | null;
};

export type GenericPaneStateRecord = { kind: string };

export type PaneStateRecord = BrowserPaneStateRecord | TerminalPaneStateRecord | GenericPaneStateRecord;

export interface PaneLifecycleHooks<TRecord extends PaneStateRecord = PaneStateRecord> {
  createParams?(args: { workspace: PaneWorkspaceContext; input: NewPaneInput }): Record<string, unknown> | undefined;
  getTitle?(args: {
    workspace: PaneWorkspaceContext;
    input: NewPaneInput;
    params: Record<string, unknown> | undefined;
  }): string;
  createRecord?(args: { workspace: PaneWorkspaceContext; params: Record<string, unknown> | undefined }): TRecord;
  createSnapshot?(args: { paneId: string; title: string; record: TRecord }): ShellPaneRecordSnapshot;
}

export interface PanePersistenceHooks<TRecord extends PaneStateRecord = PaneStateRecord> {
  normalizeRestoredParams?(args: {
    workspace: PaneWorkspaceContext;
    params: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  serializeParams?(args: {
    workspace: PaneWorkspaceContext;
    record: TRecord;
    currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
}

export interface PanePathMountContext<TRecord extends PaneStateRecord = PaneStateRecord> {
  paneId: string;
  workspace: PaneWorkspaceContext;
  record: TRecord;
  currentParams: Record<string, unknown> | undefined;
  setParams(nextParams: Record<string, unknown>): Awaitable<Record<string, unknown>>;
  patchParams(patch: Record<string, unknown>): Awaitable<Record<string, unknown>>;
}

export interface PanePathMount<TRecord extends PaneStateRecord = PaneStateRecord> {
  mountKey: string;
  getStateSnapshot?(ctx: PanePathMountContext<TRecord>): Awaitable<Record<string, unknown> | undefined>;
  canSetStatePath?(ctx: PanePathMountContext<TRecord>, relativePath: string[]): Awaitable<boolean>;
  setState?(ctx: PanePathMountContext<TRecord>, relativePath: string[], value: unknown): Awaitable<{ value: unknown }>;
  getStatusSnapshot?(ctx: PanePathMountContext<TRecord>): Awaitable<Record<string, unknown> | undefined>;
}

export type PaneSubtreeMount<TRecord extends PaneStateRecord = PaneStateRecord> = PanePathMount<TRecord>;

export interface PaneSpec<TRecord extends PaneStateRecord = PaneStateRecord> {
  kind: string;
  lifecycle?: PaneLifecycleHooks<TRecord>;
  persistence?: PanePersistenceHooks<TRecord>;
  subtreeMounts?: PaneSubtreeMount<TRecord>[];
  pathMount?: PanePathMount<TRecord>;
}

/** Read-only lookup view; use this in parameters that shouldn't get register(). */
export interface PaneSpecRegistry {
  get(kind: string): PaneSpec | undefined;
  list(): readonly PaneSpec[];
}

export const PLACEHOLDER_PANE_KIND = "placeholder";

/**
 * Substituted into workspaces when a pane's original kind is unavailable at
 * restore time (missing extension, normalize/create hook throws). Callers are
 * expected to register it before handing ShellCore a registry.
 */
export function createPlaceholderPaneSpec(): PaneSpec {
  return { kind: PLACEHOLDER_PANE_KIND };
}

export class PaneRegistry<
  TDescriptor extends {
    kind: string;
    pathMount?: { mountKey: string } | undefined;
    subtreeMounts?: Array<{ mountKey: string }> | undefined;
  }
> {
  private readonly descriptors = new Map<string, TDescriptor>();

  register(descriptor: TDescriptor) {
    if (this.descriptors.has(descriptor.kind)) {
      throw new Error(`Pane descriptor '${descriptor.kind}' is already registered`);
    }

    validateDescriptorMounts(descriptor);
    this.descriptors.set(descriptor.kind, descriptor);
  }

  get(kind: string) {
    return this.descriptors.get(kind);
  }

  list(): readonly TDescriptor[] {
    return [...this.descriptors.values()];
  }
}

export function isBrowserPaneStateRecord(record: PaneStateRecord): record is BrowserPaneStateRecord {
  return record.kind === "browser";
}

export function isTerminalPaneStateRecord(record: PaneStateRecord): record is TerminalPaneStateRecord {
  return record.kind === "terminal";
}

export function resolvePaneCreateParams<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  fallbackParams: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return (
    options.spec.lifecycle?.createParams?.({
      workspace: options.workspace,
      input: options.input
    }) ?? options.fallbackParams
  );
}

export function resolvePaneTitle<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  params: Record<string, unknown> | undefined;
  fallbackTitle: string;
}): string {
  return (
    options.spec.lifecycle?.getTitle?.({
      workspace: options.workspace,
      input: options.input,
      params: options.params
    }) ?? options.fallbackTitle
  );
}

export function createPaneStateRecord<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  params: Record<string, unknown> | undefined;
}): TRecord {
  return (
    options.spec.lifecycle?.createRecord?.({
      workspace: options.workspace,
      params: options.params
    }) ??
    ({
      kind: options.spec.kind
    } as TRecord)
  );
}

export function createPaneSnapshot<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  paneId: string;
  title: string;
  record: TRecord;
}): ShellPaneRecordSnapshot {
  return (
    options.spec.lifecycle?.createSnapshot?.({
      paneId: options.paneId,
      title: options.title,
      record: options.record
    }) ?? {
      id: options.paneId,
      kind: options.record.kind,
      title: options.title
    }
  );
}

export function normalizeRestoredPaneParams<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  params: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return (
    options.spec.persistence?.normalizeRestoredParams?.({
      workspace: options.workspace,
      params: options.params
    }) ?? options.params
  );
}

export function serializePaneParams<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  record: TRecord;
  currentParams: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return (
    options.spec.persistence?.serializeParams?.({
      workspace: options.workspace,
      record: options.record,
      currentParams: options.currentParams
    }) ?? options.currentParams
  );
}

const RESERVED_MOUNT_KEYS = new Set([
  "__proto__",
  "active",
  "browser",
  "bus",
  "close",
  "constructor",
  "cwd",
  "id",
  "kind",
  "params",
  "prototype",
  "runtimeId",
  "terminal",
  "title",
  "url"
]);

const RESERVED_SUBTREE_MOUNT_KEYS = new Set([
  "__proto__",
  "active",
  "close",
  "constructor",
  "id",
  "kind",
  "prototype",
  "title"
]);

function validateDescriptorMounts(descriptor: {
  kind: string;
  pathMount?: { mountKey: string } | undefined;
  subtreeMounts?: Array<{ mountKey: string }> | undefined;
}) {
  const seenKeys = new Set<string>();
  const pathMountKey = descriptor.pathMount?.mountKey;
  if (pathMountKey) {
    validateMountKey(descriptor.kind, pathMountKey, "path mount key");
    if (RESERVED_MOUNT_KEYS.has(pathMountKey)) {
      throw new Error(`Pane descriptor '${descriptor.kind}' uses reserved path mount key '${pathMountKey}'`);
    }
    seenKeys.add(pathMountKey);
  }

  for (const subtreeMount of descriptor.subtreeMounts ?? []) {
    validateMountKey(descriptor.kind, subtreeMount.mountKey, "subtree mount key");
    if (RESERVED_SUBTREE_MOUNT_KEYS.has(subtreeMount.mountKey)) {
      throw new Error(
        `Pane descriptor '${descriptor.kind}' uses reserved subtree mount key '${subtreeMount.mountKey}'`
      );
    }
    if (seenKeys.has(subtreeMount.mountKey)) {
      throw new Error(`Pane descriptor '${descriptor.kind}' defines duplicate mount key '${subtreeMount.mountKey}'`);
    }
    seenKeys.add(subtreeMount.mountKey);
  }
}

function validateMountKey(kind: string, mountKey: string, label: string) {
  if (!/^[a-z0-9-]+$/.test(mountKey)) {
    throw new Error(
      `Pane descriptor '${kind}' has invalid ${label} '${mountKey}'; use lowercase letters, numbers, and hyphen only`
    );
  }
}

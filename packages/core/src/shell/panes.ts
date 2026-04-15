import type { TerminalRuntimeSummary } from "../terminal/terminal";
import type { Awaitable, NewPaneInput, ShellPaneRecordSnapshot, WorkspaceBus } from "./types";

export interface PaneWorkspaceContext {
  id: string;
  rootDir: string;
  defaultFixture: string;
  bus: WorkspaceBus;
}

export type BrowserPaneStateRecord = { kind: "browser"; url: string };

export type TerminalPaneStateRecord = {
  kind: "terminal";
  cwd: string;
  rootDir: string;
  rootKey: string | null;
  runtimeId: string | null;
  summary: TerminalRuntimeSummary | null;
};

export type GenericPaneStateRecord = { kind: string };

export type PaneStateRecord = BrowserPaneStateRecord | TerminalPaneStateRecord | GenericPaneStateRecord;

export interface PaneLifecycleHooks<TRecord extends PaneStateRecord = PaneStateRecord> {
  createParams?(args: {
    workspace: PaneWorkspaceContext;
    input: NewPaneInput;
  }): Record<string, unknown> | undefined;
  getTitle?(args: {
    workspace: PaneWorkspaceContext;
    input: NewPaneInput;
    params: Record<string, unknown> | undefined;
  }): string;
  createRecord?(args: {
    workspace: PaneWorkspaceContext;
    params: Record<string, unknown> | undefined;
  }): TRecord;
  createSnapshot?(args: {
    paneId: string;
    title: string;
    active: boolean;
    record: TRecord;
  }): ShellPaneRecordSnapshot;
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
  setState?(
    ctx: PanePathMountContext<TRecord>,
    relativePath: string[],
    value: unknown
  ): Awaitable<{ value: unknown }>;
  getStatusSnapshot?(ctx: PanePathMountContext<TRecord>): Awaitable<Record<string, unknown> | undefined>;
}

export interface PaneSpec<TRecord extends PaneStateRecord = PaneStateRecord> {
  kind: string;
  lifecycle?: PaneLifecycleHooks<TRecord>;
  persistence?: PanePersistenceHooks<TRecord>;
  pathMount?: PanePathMount<TRecord>;
}

export class PaneRegistry<TDescriptor extends { kind: string; pathMount?: { mountKey: string } | undefined }> {
  private readonly descriptors = new Map<string, TDescriptor>();

  register(descriptor: TDescriptor) {
    if (this.descriptors.has(descriptor.kind)) {
      throw new Error(`Pane descriptor '${descriptor.kind}' is already registered`);
    }

    validateDescriptorPathMount(descriptor);
    this.descriptors.set(descriptor.kind, descriptor);
  }

  get(kind: string) {
    return this.descriptors.get(kind);
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
  return options.spec.lifecycle?.createParams?.({
    workspace: options.workspace,
    input: options.input
  }) ?? options.fallbackParams;
}

export function resolvePaneTitle<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  params: Record<string, unknown> | undefined;
  fallbackTitle: string;
}): string {
  return options.spec.lifecycle?.getTitle?.({
    workspace: options.workspace,
    input: options.input,
    params: options.params
  }) ?? options.fallbackTitle;
}

export function createPaneStateRecord<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  params: Record<string, unknown> | undefined;
}): TRecord {
  return options.spec.lifecycle?.createRecord?.({
    workspace: options.workspace,
    params: options.params
  }) ?? {
    kind: options.spec.kind
  } as TRecord;
}

export function createPaneSnapshot<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  paneId: string;
  title: string;
  active: boolean;
  record: TRecord;
}): ShellPaneRecordSnapshot {
  return options.spec.lifecycle?.createSnapshot?.({
    paneId: options.paneId,
    title: options.title,
    active: options.active,
    record: options.record
  }) ?? {
    id: options.paneId,
    kind: options.record.kind,
    title: options.title,
    active: options.active
  };
}

export function normalizeRestoredPaneParams<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  params: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return options.spec.persistence?.normalizeRestoredParams?.({
    workspace: options.workspace,
    params: options.params
  }) ?? options.params;
}

export function serializePaneParams<TRecord extends PaneStateRecord>(options: {
  spec: PaneSpec<TRecord>;
  workspace: PaneWorkspaceContext;
  record: TRecord;
  currentParams: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return options.spec.persistence?.serializeParams?.({
    workspace: options.workspace,
    record: options.record,
    currentParams: options.currentParams
  }) ?? options.currentParams;
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

function validateDescriptorPathMount(descriptor: { kind: string; pathMount?: { mountKey: string } | undefined }) {
  const mountKey = descriptor.pathMount?.mountKey;
  if (!mountKey) {
    return;
  }

  if (!/^[a-z0-9-]+$/.test(mountKey)) {
    throw new Error(
      `Pane descriptor '${descriptor.kind}' has invalid path mount key '${mountKey}'; use lowercase letters, numbers, and hyphen only`
    );
  }

  if (RESERVED_MOUNT_KEYS.has(mountKey)) {
    throw new Error(`Pane descriptor '${descriptor.kind}' uses reserved path mount key '${mountKey}'`);
  }
}

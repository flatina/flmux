import type { CreateComponentOptions, IDockviewPanel, IContentRenderer } from "dockview-core";
import type { TerminalRuntimeSummary } from "../../shared/terminal";
import type { TerminalHostAPI } from "../terminalHost";
import type { Awaitable, NewPaneInput, ShellModelAPI, ShellPaneSnapshot, WorkspaceBus } from "./types";

export type BrowserPaneRecord = { kind: "browser"; panel: IDockviewPanel; url: string };

export type TerminalPaneRecord = {
  kind: "terminal";
  panel: IDockviewPanel;
  cwd: string;
  rootDir: string;
  rootKey: string | null;
  runtimeId: string | null;
  summary: TerminalRuntimeSummary | null;
};

export type GenericPaneRecord = { kind: string; panel: IDockviewPanel };

export type PaneRecord = BrowserPaneRecord | TerminalPaneRecord | GenericPaneRecord;

export interface PaneWorkspaceContext {
  id: string;
  rootDir: string;
  defaultFixture: string;
  bus: WorkspaceBus;
}

export interface PaneRendererRuntimeContext {
  shellModel: ShellModelAPI;
  browserPanelTemplate: HTMLTemplateElement;
  terminalHost: Pick<TerminalHostAPI, "onEvent" | "listRoots">;
  normalizeBrowserUrl(value: string): string | null;
  onBrowserUrlChange(paneId: string, url: string): void;
  onTerminalRuntimeStateChange(
    paneId: string,
    state: { cwd: string; rootKey: string | null; runtimeId: string | null; summary: TerminalRuntimeSummary | null }
  ): void;
}

export interface PaneLifecycleHooks {
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
    panel: IDockviewPanel;
    params: Record<string, unknown> | undefined;
  }): PaneRecord;
  createSnapshot?(args: {
    paneId: string;
    title: string;
    active: boolean;
    record: PaneRecord;
  }): ShellPaneSnapshot;
}

export interface PanePersistenceHooks {
  normalizeRestoredParams?(args: {
    workspace: PaneWorkspaceContext;
    params: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
  serializeParams?(args: {
    workspace: PaneWorkspaceContext;
    record: PaneRecord;
    currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined;
}

export interface PanePathMountContext {
  paneId: string;
  workspace: PaneWorkspaceContext;
  record: PaneRecord;
  currentParams: Record<string, unknown> | undefined;
  setParams(nextParams: Record<string, unknown>): Awaitable<Record<string, unknown>>;
  patchParams(patch: Record<string, unknown>): Awaitable<Record<string, unknown>>;
}

export interface PanePathMount {
  mountKey: string;
  getStateSnapshot?(ctx: PanePathMountContext): Awaitable<Record<string, unknown> | undefined>;
  canSetStatePath?(ctx: PanePathMountContext, relativePath: string[]): Awaitable<boolean>;
  setState?(
    ctx: PanePathMountContext,
    relativePath: string[],
    value: unknown
  ): Awaitable<{ value: unknown }>;
  getStatusSnapshot?(ctx: PanePathMountContext): Awaitable<Record<string, unknown> | undefined>;
}

export interface PaneDescriptor {
  kind: string;
  createRenderer(args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  }): IContentRenderer;
  lifecycle?: PaneLifecycleHooks;
  persistence?: PanePersistenceHooks;
  pathMount?: PanePathMount;
}

export class PaneRegistry {
  private readonly descriptors = new Map<string, PaneDescriptor>();

  register(descriptor: PaneDescriptor) {
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

export function isBrowserPaneRecord(record: PaneRecord): record is BrowserPaneRecord {
  return record.kind === "browser";
}

export function isTerminalPaneRecord(record: PaneRecord): record is TerminalPaneRecord {
  return record.kind === "terminal";
}

export function resolvePaneCreateParams(options: {
  descriptor: PaneDescriptor;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  fallbackParams: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return options.descriptor.lifecycle?.createParams?.({
    workspace: options.workspace,
    input: options.input
  }) ?? options.fallbackParams;
}

export function resolvePaneTitle(options: {
  descriptor: PaneDescriptor;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  params: Record<string, unknown> | undefined;
  fallbackTitle: string;
}): string {
  return options.descriptor.lifecycle?.getTitle?.({
    workspace: options.workspace,
    input: options.input,
    params: options.params
  }) ?? options.fallbackTitle;
}

export function createPaneRecord(options: {
  descriptor: PaneDescriptor;
  workspace: PaneWorkspaceContext;
  panel: IDockviewPanel;
  params: Record<string, unknown> | undefined;
}): PaneRecord {
  return options.descriptor.lifecycle?.createRecord?.({
    workspace: options.workspace,
    panel: options.panel,
    params: options.params
  }) ?? {
    kind: options.descriptor.kind,
    panel: options.panel
  };
}

export function createPaneSnapshot(options: {
  descriptor: PaneDescriptor;
  paneId: string;
  title: string;
  active: boolean;
  record: PaneRecord;
}): ShellPaneSnapshot {
  return options.descriptor.lifecycle?.createSnapshot?.({
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

export function normalizeRestoredPaneParams(options: {
  descriptor: PaneDescriptor;
  workspace: PaneWorkspaceContext;
  params: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return options.descriptor.persistence?.normalizeRestoredParams?.({
    workspace: options.workspace,
    params: options.params
  }) ?? options.params;
}

export function serializePaneParams(options: {
  descriptor: PaneDescriptor;
  workspace: PaneWorkspaceContext;
  record: PaneRecord;
  currentParams: Record<string, unknown> | undefined;
  }): Record<string, unknown> | undefined {
  return options.descriptor.persistence?.serializeParams?.({
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

function validateDescriptorPathMount(descriptor: PaneDescriptor) {
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

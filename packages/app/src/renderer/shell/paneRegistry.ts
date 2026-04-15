import type { CreateComponentOptions, IDockviewPanel, IContentRenderer } from "dockview-core";
import type {
  BrowserPaneStateRecord,
  GenericPaneStateRecord,
  PaneLifecycleHooks,
  PanePathMount,
  PanePathMountContext,
  PanePersistenceHooks,
  PaneSpec,
  PaneStateRecord,
  PaneWorkspaceContext,
  TerminalPaneStateRecord
} from "@flmux/core/shell";
import {
  PaneRegistry as CorePaneRegistry,
  createPaneSnapshot as createCorePaneSnapshot,
  createPaneStateRecord,
  isBrowserPaneStateRecord,
  isTerminalPaneStateRecord,
  normalizeRestoredPaneParams as normalizeCoreRestoredPaneParams,
  resolvePaneCreateParams as resolveCorePaneCreateParams,
  resolvePaneTitle as resolveCorePaneTitle,
  serializePaneParams as serializeCorePaneParams
} from "@flmux/core/shell";
import type { TerminalRuntimeSummary } from "../../shared/terminal";
import type { TerminalHostAPI } from "../terminalHost";
import type { NewPaneInput, ShellModelAPI } from "./types";

export type { PaneWorkspaceContext, PaneLifecycleHooks, PanePersistenceHooks, PanePathMountContext, PanePathMount };

export type PaneRecordOf<TStateRecord extends PaneStateRecord = PaneStateRecord> = TStateRecord & { panel: IDockviewPanel };

export type BrowserPaneRecord = PaneRecordOf<BrowserPaneStateRecord>;
export type TerminalPaneRecord = PaneRecordOf<TerminalPaneStateRecord>;
export type GenericPaneRecord = PaneRecordOf<GenericPaneStateRecord>;
export type PaneRecord = BrowserPaneRecord | TerminalPaneRecord | GenericPaneRecord;

export interface PaneRendererRuntimeContext {
  shellModel: ShellModelAPI;
  browserPanelTemplate: HTMLTemplateElement;
  terminalHost: Pick<TerminalHostAPI, "onEvent">;
  normalizeBrowserUrl(value: string): string | null;
  onBrowserUrlChange(paneId: string, url: string): void;
  onTerminalRuntimeStateChange(
    paneId: string,
    state: { cwd: string; rootKey: string | null; runtimeId: string | null; summary: TerminalRuntimeSummary | null }
  ): void;
}

export interface PaneDescriptor<TStateRecord extends PaneStateRecord = PaneStateRecord> extends PaneSpec<TStateRecord> {
  createRenderer(args: {
    workspace: PaneWorkspaceContext;
    options: CreateComponentOptions;
    runtime: PaneRendererRuntimeContext;
  }): IContentRenderer;
}

export class PaneRegistry extends CorePaneRegistry<PaneDescriptor> {}

export function isBrowserPaneRecord(record: PaneStateRecord): record is BrowserPaneStateRecord {
  return isBrowserPaneStateRecord(record);
}

export function isTerminalPaneRecord(record: PaneStateRecord): record is TerminalPaneStateRecord {
  return isTerminalPaneStateRecord(record);
}

export function resolvePaneCreateParams<TStateRecord extends PaneStateRecord>(options: {
  descriptor: PaneDescriptor<TStateRecord>;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  fallbackParams: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return resolveCorePaneCreateParams({
    spec: options.descriptor,
    workspace: options.workspace,
    input: options.input,
    fallbackParams: options.fallbackParams
  });
}

export function resolvePaneTitle<TStateRecord extends PaneStateRecord>(options: {
  descriptor: PaneDescriptor<TStateRecord>;
  workspace: PaneWorkspaceContext;
  input: NewPaneInput;
  params: Record<string, unknown> | undefined;
  fallbackTitle: string;
}): string {
  return resolveCorePaneTitle({
    spec: options.descriptor,
    workspace: options.workspace,
    input: options.input,
    params: options.params,
    fallbackTitle: options.fallbackTitle
  });
}

export function createPaneRecord<TStateRecord extends PaneStateRecord>(options: {
  descriptor: PaneDescriptor<TStateRecord>;
  workspace: PaneWorkspaceContext;
  panel: IDockviewPanel;
  params: Record<string, unknown> | undefined;
}): PaneRecordOf<TStateRecord> {
  const state = createPaneStateRecord({
    spec: options.descriptor,
    workspace: options.workspace,
    params: options.params
  });
  return {
    ...state,
    panel: options.panel
  };
}

export function createPaneSnapshot<TStateRecord extends PaneStateRecord>(options: {
  descriptor: PaneDescriptor<TStateRecord>;
  paneId: string;
  title: string;
  active: boolean;
  record: PaneRecordOf<TStateRecord>;
}) {
  return createCorePaneSnapshot({
    spec: options.descriptor,
    paneId: options.paneId,
    title: options.title,
    active: options.active,
    record: options.record
  });
}

export function normalizeRestoredPaneParams<TStateRecord extends PaneStateRecord>(options: {
  descriptor: PaneDescriptor<TStateRecord>;
  workspace: PaneWorkspaceContext;
  params: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return normalizeCoreRestoredPaneParams({
    spec: options.descriptor,
    workspace: options.workspace,
    params: options.params
  });
}

export function serializePaneParams<TStateRecord extends PaneStateRecord>(options: {
  descriptor: PaneDescriptor<TStateRecord>;
  workspace: PaneWorkspaceContext;
  record: PaneRecordOf<TStateRecord>;
  currentParams: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  return serializeCorePaneParams({
    spec: options.descriptor,
    workspace: options.workspace,
    record: options.record,
    currentParams: options.currentParams
  });
}

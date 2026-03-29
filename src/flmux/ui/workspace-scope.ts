import type { TabId } from "../../lib/ids";
import { PropertyOwnerBase, PropertyUnavailableError, type PropertyChangeCallback } from "../props/property";
import { prop } from "../props/decorators";
import type { TabRenderer } from "./tabs/tab-renderer";

export interface WorkspaceScopeHost {
  queueSave(): void;
  publishSimplePaneTitleChange(previousValue: unknown): void;
}

export class WorkspaceScope extends PropertyOwnerBase {
  constructor(
    private readonly host: WorkspaceScopeHost,
    readonly tabId: TabId,
    private readonly renderer: TabRenderer,
    private readonly publishChange: PropertyChangeCallback
  ) {
    super();
    this.finalizeProperties();
  }

  protected override onPropertyChanged(key: string, value: unknown, previousValue: unknown): void {
    super.onPropertyChanged(key, value, previousValue);
    this.publishChange({ scope: "workspace", targetId: this.tabId, key, value, previousValue, timestamp: Date.now() });
  }

  protected override afterWrite(key: string, previousValue: unknown): void {
    if (key === "title" && this.isSimple()) {
      this.host.publishSimplePaneTitleChange(previousValue);
    }
  }

  @prop({ type: "string", description: "Workspace title" })
  getTitle(): string {
    const title = this.renderer.getWorkspaceTitle();
    if (title === null) throw new PropertyUnavailableError(`workspace not found: ${this.tabId}`);
    return title;
  }

  @prop()
  setTitle(value: unknown): void {
    const nextTitle = String(value ?? "").trim();
    if (!nextTitle) return;
    this.renderer.setWorkspaceTitle(nextTitle);
    this.host.queueSave();
  }

  isSimple(): boolean {
    return !this.renderer.isLayoutable;
  }
}

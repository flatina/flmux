import type { DockviewApi } from "dockview-core";
import type { HostRpc } from "../rpc/host-rpc";
import type { TabRenderer } from "./tabs/tab-renderer";
import { captureWorkspaceFile, restoreWorkspaceFile } from "./workspace-persistence";

export async function saveSessionAs(
  hostRpc: HostRpc,
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>
): Promise<void> {
  const name = prompt("Session name:", `session-${new Date().toISOString().slice(0, 10)}`);
  if (!name?.trim() || !dockview) return;

  const windowFrame = await hostRpc.request("window.frame.get", undefined);
  const file = captureWorkspaceFile(dockview, tabRenderers, windowFrame);
  file.name = name.trim();

  await hostRpc.request("session.save", { name: name.trim(), file });
  await hostRpc.request("flmuxLast.save", { file });
}

export async function showLoadSessionMenu(
  hostRpc: HostRpc,
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  parentMenu: HTMLElement,
  queueSave: () => void
): Promise<void> {
  const { sessions } = await hostRpc.request("session.list", undefined);
  if (sessions.length === 0) {
    alert("No saved sessions found.");
    return;
  }

  parentMenu.querySelectorAll(".session-list-item").forEach((el) => el.remove());

  const sep = document.createElement("hr");
  sep.className = "session-list-item";
  sep.style.cssText = "border:none;border-top:1px solid var(--divider);margin:4px 0;";
  parentMenu.append(sep);

  for (const s of sessions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "titlebar-menu-item session-list-item";
    btn.textContent = s.name;
    btn.title = s.savedAt ? `Saved: ${s.savedAt}` : "";
    btn.addEventListener("click", () => {
      parentMenu.hidden = true;
      parentMenu.querySelectorAll(".session-list-item").forEach((el) => el.remove());
      void loadNamedSession(hostRpc, dockview, tabRenderers, s.name, queueSave);
    });
    parentMenu.append(btn);
  }

  parentMenu.hidden = false;
}

export async function loadNamedSession(
  hostRpc: HostRpc,
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  name: string,
  queueSave: () => void
): Promise<void> {
  const { file } = await hostRpc.request("session.load", { name });
  restoreWorkspaceFile(dockview, tabRenderers, file, queueSave);
}

export async function loadLastSession(
  hostRpc: HostRpc,
  dockview: DockviewApi | null,
  tabRenderers: Map<string, TabRenderer>,
  queueSave: () => void
): Promise<void> {
  const { file } = await hostRpc.request("flmuxLast.load", undefined);
  restoreWorkspaceFile(dockview, tabRenderers, file, queueSave);
}

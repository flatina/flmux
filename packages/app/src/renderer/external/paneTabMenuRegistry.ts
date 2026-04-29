import type { PaneHeaderMenu } from "@flmux/extension-api";

const menus = new Map<string, PaneHeaderMenu>();

export function setPaneHeaderMenu(paneId: string, menu: PaneHeaderMenu | null): void {
  if (menu) menus.set(paneId, menu);
  else menus.delete(paneId);
}

export function getPaneHeaderMenu(paneId: string): PaneHeaderMenu | undefined {
  return menus.get(paneId);
}

export function clearPaneHeaderMenu(paneId: string): void {
  menus.delete(paneId);
}

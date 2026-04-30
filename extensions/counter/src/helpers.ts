import type { ExtensionPaneContext } from "@flmux/extension-api";

export interface ScopeDom {
  valueEl: HTMLElement;
  inc: HTMLButtonElement;
  dec: HTMLButtonElement;
  reset: HTMLButtonElement;
}

export interface PanelDom {
  app: ScopeDom;
  workspace: ScopeDom;
}

export function ensureStylesheet(id: string, href: string) {
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export async function mountPanelShell(
  host: HTMLElement,
  templateUrl: string,
  ctx: ExtensionPaneContext
): Promise<PanelDom | null> {
  let html: string;
  try {
    html = await fetch(templateUrl).then((res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    });
  } catch (error) {
    console.warn("[counter] panel template fetch failed", error);
    host.textContent = "(panel template failed to load)";
    return null;
  }
  host.innerHTML = html;
  host.querySelector<HTMLElement>('[data-role="workspace-id"]')!.textContent = ctx.workspaceId;
  host.querySelector<HTMLElement>('[data-role="pane-id"]')!.textContent = ctx.paneId;
  return {
    app: {
      valueEl: host.querySelector<HTMLElement>('[data-role="app-value"]')!,
      inc: host.querySelector<HTMLButtonElement>('[data-action="app-inc"]')!,
      dec: host.querySelector<HTMLButtonElement>('[data-action="app-dec"]')!,
      reset: host.querySelector<HTMLButtonElement>('[data-action="app-reset"]')!
    },
    workspace: {
      valueEl: host.querySelector<HTMLElement>('[data-role="workspace-value"]')!,
      inc: host.querySelector<HTMLButtonElement>('[data-action="workspace-inc"]')!,
      dec: host.querySelector<HTMLButtonElement>('[data-action="workspace-dec"]')!,
      reset: host.querySelector<HTMLButtonElement>('[data-action="workspace-reset"]')!
    }
  };
}

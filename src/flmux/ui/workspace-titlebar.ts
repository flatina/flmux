import type { ThemePreference } from "../../types/view";
import { getTheme } from "./theme";

export interface WorkspaceTitlebarOptions {
  host: HTMLElement;
  titleElement: HTMLElement;
  launchers?: Array<{
    icon: string;
    tooltip: string;
    onClick: () => void | Promise<void>;
  }>;
  onNewWorkspace: () => void;
  onSaveSessionAs: () => void;
  onShowLoadSessionMenu: (menu: HTMLElement) => void;
  onLoadLastSession: () => void;
  onOpenExtensionManager: () => void;
  onSetTheme: (theme: ThemePreference) => void;
  onWindowMinimize: () => void;
  onWindowMaximize: () => void;
  onWindowClose: () => void;
}

export function mountWorkspaceTitlebar(options: WorkspaceTitlebarOptions): () => void {
  const cleanupCallbacks: Array<() => void> = [];

  const left = document.createElement("div");
  left.className = "titlebar-left";
  options.titleElement.className = "titlebar-title";
  left.append(options.titleElement);

  const center = document.createElement("div");
  center.className = "titlebar-center electrobun-webkit-app-region-no-drag";
  center.append(createTitlebarButton("\u{1FA9F}", "New Workspace", options.onNewWorkspace));
  for (const launcher of options.launchers ?? []) {
    center.append(createTitlebarButton(launcher.icon, launcher.tooltip, () => void launcher.onClick()));
  }
  center.append(
    buildSessionMenu(options, cleanupCallbacks),
    buildSettingsMenu(options, cleanupCallbacks)
  );

  const right = document.createElement("div");
  right.className = "titlebar-window-controls electrobun-webkit-app-region-no-drag";
  right.append(
    createWindowButton("\u2500", "Minimize", options.onWindowMinimize),
    createWindowButton("\u25A1", "Maximize", options.onWindowMaximize),
    createWindowButton("\u2715", "Close", options.onWindowClose, "window-btn-close")
  );

  options.host.replaceChildren(left, center, right);

  return () => {
    for (const cleanup of cleanupCallbacks) {
      cleanup();
    }
    options.host.replaceChildren();
  };
}

function createTitlebarButton(icon: string, tooltip: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "titlebar-btn";
  button.textContent = icon;
  button.title = tooltip;
  button.addEventListener("click", onClick);
  return button;
}

function createWindowButton(icon: string, tooltip: string, onClick: () => void, extraClass?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `window-btn${extraClass ? ` ${extraClass}` : ""}`;
  button.textContent = icon;
  button.title = tooltip;
  button.addEventListener("click", onClick);
  return button;
}

function buildSessionMenu(options: WorkspaceTitlebarOptions, cleanupCallbacks: Array<() => void>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "titlebar-menu-wrapper";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "titlebar-btn";
  trigger.textContent = "\u{1F4D1}";
  trigger.title = "Session";

  const menu = document.createElement("div");
  menu.className = "titlebar-menu";
  menu.hidden = true;

  const makeItem = (text: string, onClick: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "titlebar-menu-item";
    button.textContent = text;
    button.addEventListener("click", () => {
      menu.hidden = true;
      onClick();
    });
    return button;
  };

  menu.append(
    makeItem("Save Session\u2026", options.onSaveSessionAs),
    makeItem("Load Session\u2026", () => options.onShowLoadSessionMenu(menu)),
    makeItem("Load Last Session", options.onLoadLastSession)
  );

  const onTriggerClick = (event: MouseEvent) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
  };
  const onDocumentClick = (event: MouseEvent) => {
    if (!wrapper.contains(event.target as Node)) {
      menu.hidden = true;
    }
  };

  trigger.addEventListener("click", onTriggerClick);
  document.addEventListener("click", onDocumentClick);
  cleanupCallbacks.push(() => document.removeEventListener("click", onDocumentClick));

  wrapper.append(trigger, menu);
  return wrapper;
}

function buildSettingsMenu(options: WorkspaceTitlebarOptions, cleanupCallbacks: Array<() => void>): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "titlebar-menu-wrapper";

  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "titlebar-btn";
  trigger.textContent = "\u2699\uFE0F";
  trigger.title = "Settings";

  const menu = document.createElement("div");
  menu.className = "titlebar-menu";
  menu.hidden = true;

  const extButton = document.createElement("button");
  extButton.type = "button";
  extButton.className = "titlebar-menu-item";
  extButton.textContent = "Extensions";
  extButton.addEventListener("click", () => {
    menu.hidden = true;
    options.onOpenExtensionManager();
  });

  const themeOptions: Array<{ value: ThemePreference; label: string }> = [
    { value: "system", label: "System Default" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" }
  ];

  const themeWrapper = document.createElement("div");
  themeWrapper.className = "titlebar-submenu-wrapper";

  const themeTrigger = document.createElement("button");
  themeTrigger.type = "button";
  themeTrigger.className = "titlebar-menu-item titlebar-submenu-trigger";
  themeTrigger.textContent = "Theme";

  const themeMenu = document.createElement("div");
  themeMenu.className = "titlebar-submenu";
  themeMenu.hidden = true;

  const themeButtons: HTMLButtonElement[] = [];
  const updateThemeButtons = () => {
    const current = getTheme();
    for (const button of themeButtons) {
      const isActive = button.dataset.theme === current;
      button.classList.toggle("titlebar-menu-item-active", isActive);
      button.textContent = `${isActive ? "\u2022 " : "  "}${button.dataset.label}`;
    }
  };

  for (const option of themeOptions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "titlebar-menu-item";
    button.dataset.theme = option.value;
    button.dataset.label = option.label;
    button.addEventListener("click", () => {
      options.onSetTheme(option.value);
      updateThemeButtons();
      themeMenu.hidden = true;
      menu.hidden = true;
    });
    themeButtons.push(button);
  }

  updateThemeButtons();
  themeTrigger.addEventListener("click", (event) => {
    event.stopPropagation();
    updateThemeButtons();
    themeMenu.hidden = !themeMenu.hidden;
  });

  themeMenu.append(...themeButtons);
  themeWrapper.append(themeTrigger, themeMenu);
  menu.append(extButton, themeWrapper);

  const onTriggerClick = (event: MouseEvent) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    if (!menu.hidden) {
      updateThemeButtons();
      themeMenu.hidden = true;
    }
  };
  const onDocumentClick = (event: MouseEvent) => {
    if (!wrapper.contains(event.target as Node)) {
      themeMenu.hidden = true;
      menu.hidden = true;
    }
  };

  trigger.addEventListener("click", onTriggerClick);
  document.addEventListener("click", onDocumentClick);
  cleanupCallbacks.push(() => document.removeEventListener("click", onDocumentClick));

  wrapper.append(trigger, menu);
  return wrapper;
}

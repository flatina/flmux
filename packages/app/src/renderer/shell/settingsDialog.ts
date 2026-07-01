import type { FlmuxRendererBootstrapConfig } from "../../shared/rendererBridge";
import { getThemePreference, setThemePreference, type ThemePreference } from "../theme";

const THEME_GLYPH: Record<ThemePreference, string> = {
  light: "☀",
  dark: "☾",
  system: "◐"
};

const THEME_OPTIONS: ReadonlyArray<{ preference: ThemePreference; label: string }> = [
  { preference: "light", label: "Light" },
  { preference: "dark", label: "Dark" },
  { preference: "system", label: "System" }
];

type SectionId = "appearance" | "account" | "about";

interface SettingsSection {
  id: SectionId;
  label: string;
  render(body: HTMLElement): void;
}

/**
 * Centered modal Settings dialog. Overlay-based — never a dockview pane or a
 * new page. Left = section list, right = section content. Account section is
 * web-only (gated on `config.mode === "web"` && `config.account`) and edits
 * the signed-in user's own display name via `POST /api/auth/profile`.
 *
 * Singleton: only one dialog open at a time. Pointerdown-outside + Esc close.
 */
let openDialog: SettingsDialog | null = null;

export function openSettingsDialog(
  config: FlmuxRendererBootstrapConfig,
  initialSection: SectionId = "appearance"
): void {
  if (openDialog) {
    openDialog.show(initialSection);
    return;
  }
  openDialog = new SettingsDialog(config, () => {
    openDialog = null;
  });
  openDialog.show(initialSection);
}

class SettingsDialog {
  private readonly overlay = document.createElement("div");
  private readonly nav = document.createElement("div");
  private readonly body = document.createElement("div");
  private readonly sections: SettingsSection[];

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  };

  constructor(
    private readonly config: FlmuxRendererBootstrapConfig,
    private readonly onClosed: () => void
  ) {
    this.sections = this.buildSections();

    this.overlay.className = "settings-overlay";
    const dialog = document.createElement("div");
    dialog.className = "settings-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");

    const header = document.createElement("div");
    header.className = "settings-dialog__header";
    const title = document.createElement("span");
    title.className = "settings-dialog__title";
    title.textContent = "Settings";
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "settings-dialog__close";
    closeBtn.title = "Close";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());
    header.append(title, closeBtn);

    this.nav.className = "settings-dialog__nav";
    this.body.className = "settings-dialog__body";

    const main = document.createElement("div");
    main.className = "settings-dialog__main";
    main.append(this.nav, this.body);

    dialog.append(header, main);
    this.overlay.append(dialog);

    this.overlay.addEventListener("pointerdown", (event) => {
      if (event.target === this.overlay) this.close();
    });

    this.renderNav();
  }

  show(sectionId: SectionId): void {
    if (!this.overlay.isConnected) {
      document.body.append(this.overlay);
      document.addEventListener("keydown", this.onKeyDown);
    }
    this.select(this.sections.some((s) => s.id === sectionId) ? sectionId : this.sections[0].id);
  }

  private buildSections(): SettingsSection[] {
    const sections: SettingsSection[] = [
      { id: "appearance", label: "Appearance", render: (body) => this.renderAppearance(body) }
    ];
    if (this.config.mode === "web" && this.config.account) {
      sections.push({ id: "account", label: "Account", render: (body) => this.renderAccount(body) });
    }
    sections.push({ id: "about", label: "About", render: (body) => this.renderAbout(body) });
    return sections;
  }

  private renderNav(): void {
    this.nav.replaceChildren();
    for (const section of this.sections) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "settings-dialog__nav-item";
      item.dataset.section = section.id;
      item.textContent = section.label;
      item.addEventListener("click", () => this.select(section.id));
      this.nav.append(item);
    }
  }

  private select(sectionId: SectionId): void {
    for (const item of this.nav.querySelectorAll<HTMLElement>(".settings-dialog__nav-item")) {
      item.classList.toggle("settings-dialog__nav-item--active", item.dataset.section === sectionId);
    }
    const section = this.sections.find((s) => s.id === sectionId);
    this.body.replaceChildren();
    section?.render(this.body);
  }

  private renderAppearance(body: HTMLElement): void {
    body.append(sectionHeading("Theme"));
    const list = document.createElement("div");
    list.className = "settings-option-list";
    const current = getThemePreference();
    for (const option of THEME_OPTIONS) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "settings-option";
      if (option.preference === current) item.classList.add("settings-option--active");
      item.textContent = `${THEME_GLYPH[option.preference]}  ${option.label}`;
      item.addEventListener("click", () => {
        setThemePreference(option.preference);
        for (const sibling of list.querySelectorAll<HTMLElement>(".settings-option")) {
          sibling.classList.remove("settings-option--active");
        }
        item.classList.add("settings-option--active");
      });
      list.append(item);
    }
    body.append(list);
  }

  private renderAccount(body: HTMLElement): void {
    const account = this.config.account;
    if (!account) return;

    body.append(sectionHeading("Display name"));
    const row = document.createElement("div");
    row.className = "settings-field-row";
    const input = document.createElement("input");
    input.type = "text";
    input.className = "settings-input";
    input.maxLength = 48;
    input.value = account.displayName ?? "";
    input.placeholder = account.name;
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "settings-btn settings-btn--primary";
    saveBtn.textContent = "Save";
    row.append(input, saveBtn);

    const error = document.createElement("div");
    error.className = "settings-field-error";
    error.hidden = true;

    saveBtn.addEventListener("click", () => {
      void this.saveDisplayName(input.value, { input, saveBtn, error });
    });

    body.append(row, error);

    body.append(sectionHeading("Login id"));
    const loginId = document.createElement("div");
    loginId.className = "settings-readonly";
    loginId.textContent = account.name;
    body.append(loginId);

    const logoutRow = document.createElement("div");
    logoutRow.className = "settings-field-row settings-field-row--logout";
    const logoutBtn = document.createElement("button");
    logoutBtn.type = "button";
    logoutBtn.className = "settings-btn settings-btn--danger";
    logoutBtn.textContent = "Log out";
    logoutBtn.addEventListener("click", () => void logout());
    logoutRow.append(logoutBtn);
    body.append(logoutRow);
  }

  private renderAbout(body: HTMLElement): void {
    const list = document.createElement("div");
    list.className = "settings-about";
    list.append(
      aboutRow("App", this.config.appName),
      aboutRow("Version", this.config.appVersion),
      aboutRow("Build date", formatBuildDate(this.config.buildDate))
    );
    body.append(list);

    const message = this.config.aboutMessage?.trim();
    if (message) {
      const blurb = document.createElement("div");
      blurb.className = "settings-about__message";
      blurb.textContent = message;
      body.append(blurb);
    }
  }

  private async saveDisplayName(
    value: string,
    ui: { input: HTMLInputElement; saveBtn: HTMLButtonElement; error: HTMLElement }
  ): Promise<void> {
    ui.error.hidden = true;
    ui.saveBtn.disabled = true;
    try {
      const response = await fetch(`/api/auth/profile`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ displayName: value })
      });
      const payload = (await response.json().catch(() => null)) as {
        ok: boolean;
        result?: { displayName?: string };
        error?: string;
      } | null;
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `Save failed (${response.status})`);
      }
      // Update in-memory account so the hamburger label + dialog reflect the
      // new name without a reload.
      const saved = payload.result?.displayName;
      if (this.config.account) this.config.account.displayName = saved;
      ui.input.value = saved ?? "";
    } catch (cause) {
      ui.error.textContent = cause instanceof Error ? cause.message : String(cause);
      ui.error.hidden = false;
    } finally {
      ui.saveBtn.disabled = false;
    }
  }

  private close(): void {
    this.overlay.remove();
    document.removeEventListener("keydown", this.onKeyDown);
    this.onClosed();
  }
}

function sectionHeading(text: string): HTMLElement {
  const heading = document.createElement("div");
  heading.className = "settings-section-heading";
  heading.textContent = text;
  return heading;
}

function aboutRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "settings-about__row";
  const labelEl = document.createElement("span");
  labelEl.className = "settings-about__label";
  labelEl.textContent = label;
  const valueEl = document.createElement("span");
  valueEl.className = "settings-about__value";
  valueEl.textContent = value;
  row.append(labelEl, valueEl);
  return row;
}

function formatBuildDate(value: string): string {
  if (value === "dev") return "dev";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export async function logout(): Promise<void> {
  // Logout → unauthenticated: tear the WS connection down. A clean client-side
  // close also reports info-undefined to bunite, so the connection-loss overlay
  // stays hidden during the redirect to /login.
  const conn = window.__bunite?.webConnection;
  if (conn && !conn.closed) conn.shutdown();
  try {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  } finally {
    location.href = "/login";
  }
}

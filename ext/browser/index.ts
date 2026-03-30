import { defineView, type BrowserPaneAdapter } from "flmux-sdk";
import type { WebviewTagElement } from "electrobun/view";

type BrowserParams = {
  url: string;
  adapter: BrowserPaneAdapter;
};

type BrowserState = {
  url?: string;
};

type BrowserTarget = {
  id: string;
  title: string;
  url: string;
  type: string;
  webSocketDebuggerUrl: string;
};

export default defineView<BrowserParams, BrowserState>({
  createInstance(context) {
    let params = normalizeParams(context.params);
    let currentUrl = context.state?.url ?? params.url;
    let browserAdapter = params.adapter;
    let browserInput: HTMLInputElement | null = null;
    let browserWebview: WebviewTagElement | null = null;
    let browserDisposables: Array<() => void> = [];
    let visible = true;
    let host: HTMLElement | null = null;
    let cdpBaseUrl: string | null = null;
    let beforeTargetIds = new Set<string>();
    let beforeTargetIdsPromise: Promise<Set<string>> | null = null;
    let cdpHydrationStarted = false;
    let disposed = false;

    const runtime = window as Window & { __electrobun?: unknown; __electrobunWindowId?: unknown };
    const isElectrobunRuntime =
      typeof runtime.__electrobun !== "undefined" || typeof runtime.__electrobunWindowId === "number";

    const visibilityUnsub = context.onVisibilityChange((nextVisible) => {
      visible = nextVisible;
      syncVisibility();
    });
    const dimensionsUnsub = context.onDimensionsChange(() => {
      browserWebview?.syncDimensions(true);
    });

    return {
      beforeMount(nextHost) {
        host = nextHost;
        prepareBrowserBootstrap();
      },
      mount() {
        renderCurrentMode();
        syncBrowserParams();
        requestAnimationFrame(() => {
          syncVisibility();
          browserWebview?.syncDimensions(true);
        });
      },
      update(nextParams) {
        const next = normalizeParams(nextParams);
        params = next;
        currentUrl = next.url;
        if (next.adapter !== browserAdapter) {
          renderCurrentMode();
          return;
        }
        syncBrowserParams();
      },
      dispose() {
        disposed = true;
        visibilityUnsub();
        dimensionsUnsub();
        disposeBrowserView();
        host?.replaceChildren();
        host = null;
      }
    };

    function renderCurrentMode(): void {
      disposeBrowserView();
      if (isElectrobunRuntime && params.adapter === "electrobun-native") {
        mountBrowserView();
        return;
      }
      mountBrowserIframe();
    }

    function mountBrowserView(): void {
      if (!host) {
        return;
      }

      browserAdapter = "electrobun-native";

      const shell = document.createElement("div");
      shell.className = "browser-pane";

      const toolbar = document.createElement("div");
      toolbar.className = "browser-toolbar";

      const backBtn = document.createElement("button");
      backBtn.className = "browser-nav-btn";
      backBtn.type = "button";
      backBtn.textContent = "\u2190";
      backBtn.addEventListener("click", () => {
        if (!browserWebview) {
          return;
        }

        try {
          browserWebview.executeJavascript("history.back()");
        } catch {
          browserWebview.goBack();
        }
      });

      const refreshBtn = document.createElement("button");
      refreshBtn.className = "browser-nav-btn";
      refreshBtn.type = "button";
      refreshBtn.textContent = "\u21BB";
      refreshBtn.addEventListener("click", () => {
        if (!browserWebview) {
          return;
        }

        try {
          browserWebview.executeJavascript("window.location.reload()");
        } catch {
          browserWebview.reload();
        }
      });

      const address = document.createElement("input");
      address.className = "browser-address";
      address.type = "text";
      address.spellcheck = false;
      address.autocomplete = "off";
      address.placeholder = "Search or enter URL";
      browserInput = address;

      toolbar.append(backBtn, refreshBtn, address);

      const welcome = createBrowserWelcome();
      const isBlank = !currentUrl || currentUrl === "about:blank";

      const syncDimensions = () => {
        browserWebview?.syncDimensions(true);
      };

      const syncWebviewIdentity = () => {
        const webviewId = browserWebview?.webviewId;
        if (typeof webviewId === "number") {
          context.curPane.props.set("browser.webviewId", webviewId);
        }
      };

      const handleDidNavigate = (event: CustomEvent) => {
        const url = extractWebviewUrl(event.detail);
        if (!url) {
          return;
        }

        if (browserInput && browserInput !== document.activeElement) {
          browserInput.value = url;
        }

        if (currentUrl !== url) {
          currentUrl = url;
          context.setState({ url });
        }
        context.curPane.title = browserTitleFromUrl(url);
      };

      const ensureWebview = (url: string): WebviewTagElement => {
        if (browserWebview) {
          return browserWebview;
        }

        const webview = document.createElement("electrobun-webview") as WebviewTagElement;
        webview.className = "browser-webview";
        webview.renderer = "native";
        webview.setAttribute("src", url);

        webview.on("dom-ready", () => {
          syncWebviewIdentity();
          syncDimensions();
          void hydrateBrowserCdpAfterCreate();
        });
        webview.on("did-navigate", handleDidNavigate);
        webview.on("did-commit-navigation", handleDidNavigate);

        browserDisposables.push(
          () => webview.off("did-navigate", handleDidNavigate),
          () => webview.off("did-commit-navigation", handleDidNavigate)
        );

        shell.appendChild(webview);
        browserWebview = webview;
        requestAnimationFrame(() => syncWebviewIdentity());
        requestAnimationFrame(() => syncVisibility());
        return webview;
      };

      const navigateToUrl = (url: string) => {
        welcome.style.display = "none";
        ensureWebview(url);
        navigateBrowser(url);
      };

      address.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          navigateToUrl(normalizeUrl(address.value));
        }
      });

      welcome.querySelector(".browser-welcome-input")?.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
          navigateToUrl(normalizeUrl((event.target as HTMLInputElement).value));
        }
      });
      welcome.querySelectorAll<HTMLButtonElement>(".browser-welcome-link").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.url) navigateToUrl(button.dataset.url);
        });
      });

      shell.append(toolbar, welcome);
      host.replaceChildren(shell);

      if (!isBlank) {
        welcome.style.display = "none";
        ensureWebview(normalizeBrowserUrlValue(currentUrl));
        navigateBrowser(normalizeBrowserUrlValue(currentUrl));
        requestAnimationFrame(() => syncVisibility());
      }
    }

    function mountBrowserIframe(): void {
      if (!host) {
        return;
      }

      browserAdapter = "web-iframe";

      const shell = document.createElement("div");
      shell.className = "browser-pane";

      const toolbar = document.createElement("div");
      toolbar.className = "browser-toolbar";

      const backBtn = document.createElement("button");
      backBtn.className = "browser-nav-btn";
      backBtn.type = "button";
      backBtn.textContent = "\u2190";

      const address = document.createElement("input");
      address.className = "browser-address";
      address.type = "text";
      address.spellcheck = false;
      address.autocomplete = "off";
      address.placeholder = "Search or enter URL";
      address.value = normalizeBrowserUrlValue(currentUrl);
      browserInput = address;

      const iframe = document.createElement("iframe");
      iframe.className = "browser-webview";
      iframe.style.cssText = "width:100%;flex:1;border:none;";
      iframe.sandbox.add("allow-scripts", "allow-same-origin", "allow-forms", "allow-popups");
      iframe.src = normalizeUrl(currentUrl);

      backBtn.addEventListener("click", () => {
        try {
          iframe.contentWindow?.history.back();
        } catch {
          // cross-origin
        }
      });

      const refreshBtn = document.createElement("button");
      refreshBtn.className = "browser-nav-btn";
      refreshBtn.type = "button";
      refreshBtn.textContent = "\u21BB";
      refreshBtn.addEventListener("click", () => {
        iframe.src = normalizeUrl(address.value);
      });

      address.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          const url = normalizeUrl(address.value);
          iframe.src = url;
          currentUrl = url;
          context.setState({ url });
          context.curPane.title = browserTitleFromUrl(url);
        }
      });

      toolbar.append(backBtn, refreshBtn, address);

      const welcome = createBrowserWelcome();
      const isBlank = !currentUrl || currentUrl === "about:blank";
      welcome.style.display = isBlank ? "" : "none";
      if (isBlank) {
        iframe.style.display = "none";
      }

      const navigateFromWelcome = (url: string) => {
        address.value = url;
        iframe.src = url;
        iframe.style.display = "";
        welcome.style.display = "none";
        currentUrl = url;
        context.setState({ url });
        context.curPane.title = browserTitleFromUrl(url);
      };

      welcome.querySelector(".browser-welcome-input")?.addEventListener("keydown", (event) => {
        if ((event as KeyboardEvent).key === "Enter") {
          navigateFromWelcome(normalizeUrl((event.target as HTMLInputElement).value));
        }
      });
      welcome.querySelectorAll<HTMLButtonElement>(".browser-welcome-link").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.url) navigateFromWelcome(button.dataset.url);
        });
      });

      shell.append(toolbar, welcome, iframe);
      host.replaceChildren(shell);
      context.curPane.title = browserTitleFromUrl(currentUrl);
    }

    function syncBrowserParams(): void {
      if (!browserInput) {
        return;
      }

      const normalizedUrl = normalizeBrowserUrlValue(currentUrl);
      if (normalizedUrl !== currentUrl) {
        currentUrl = normalizedUrl;
        context.setState({ url: normalizedUrl });
      }

      if (browserInput !== document.activeElement) {
        browserInput.value = normalizedUrl;
      }

      if (browserAdapter === "electrobun-native" && browserWebview) {
        if (normalizedUrl !== "about:blank" && browserWebview.src !== normalizedUrl) {
          browserWebview.loadURL(normalizedUrl);
        }
        browserWebview.syncDimensions(true);
      }
    }

    function navigateBrowser(url: string): void {
      if (!browserInput || !browserWebview) {
        return;
      }

      browserInput.value = url;
      browserWebview.loadURL(url);
      browserWebview.syncDimensions(true);
      currentUrl = url;
      context.setState({ url });
      context.curPane.title = browserTitleFromUrl(url);
    }

    function syncVisibility(): void {
      if (!browserWebview) {
        return;
      }

      browserWebview.toggleHidden(!visible);
      browserWebview.togglePassthrough(!visible);
      if (visible) {
        browserWebview.syncDimensions(true);
      }
    }

    function disposeBrowserView(): void {
      for (const dispose of browserDisposables) {
        dispose();
      }
      browserDisposables.length = 0;

      if (browserWebview) {
        browserWebview.toggleHidden?.(true);
        browserWebview.togglePassthrough?.(true);
        // Let DOM teardown trigger disconnectedCallback once for native cleanup.
        browserWebview = null;
      }

      browserInput = null;
    }

    function prepareBrowserBootstrap(): void {
      context.curPane.props.set("browser.cdp.ready", false);
      context.curPane.props.set("browser.cdp.targetId", null);
      context.curPane.props.set("browser.cdp.webSocketDebuggerUrl", null);

      if (!isElectrobunRuntime || params.adapter !== "electrobun-native") {
        return;
      }

      const current = context.app.props.get("browser.cdpBaseUrl");
      if (typeof current === "string" && current) {
        cdpBaseUrl = current;
        beforeTargetIdsPromise = fetchBrowserTargets(current)
          .then((targets) => new Set(targets.map((target) => target.id)))
          .catch(() => new Set<string>());
      } else {
        beforeTargetIdsPromise = null;
      }
    }

    async function hydrateBrowserCdpAfterCreate(): Promise<void> {
      if (cdpHydrationStarted || disposed || params.adapter !== "electrobun-native") {
        return;
      }
      cdpHydrationStarted = true;
      try {
        if (!cdpBaseUrl) {
          cdpBaseUrl = await waitForCdpBaseUrl();
        }
        if (!cdpBaseUrl) {
          return;
        }

        if (beforeTargetIdsPromise) {
          beforeTargetIds = await beforeTargetIdsPromise;
        }

        let target: BrowserTarget;
        if (beforeTargetIds.size > 0) {
          try {
            target = await waitForCreatedTargetDiff(cdpBaseUrl, beforeTargetIds);
          } catch {
            target = await waitForLikelyCreatedTarget(cdpBaseUrl);
          }
        } else {
          target = await waitForLikelyCreatedTarget(cdpBaseUrl);
        }
        if (disposed) {
          return;
        }
        context.curPane.props.set("browser.cdp.targetId", target.id);
        context.curPane.props.set("browser.cdp.webSocketDebuggerUrl", target.webSocketDebuggerUrl);
        context.curPane.props.set("browser.cdp.ready", true);
      } catch {
        context.curPane.props.set("browser.cdp.ready", false);
      }
    }

    async function waitForCdpBaseUrl(): Promise<string | null> {
      const current = context.app.props.get("browser.cdpBaseUrl");
      if (typeof current === "string" && current) {
        return current;
      }

      return new Promise((resolve) => {
        const timeout = window.setTimeout(() => {
          unsubscribe();
          resolve(null);
        }, 15_000);
        const unsubscribe = context.app.on("change:browser.cdpBaseUrl", (value) => {
          if (typeof value !== "string" || !value) {
            return;
          }
          window.clearTimeout(timeout);
          unsubscribe();
          resolve(value);
        });
      });
    }

    async function waitForCreatedTargetDiff(baseUrl: string, previousTargetIds: Set<string>): Promise<BrowserTarget> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const added = (await fetchBrowserTargets(baseUrl)).filter((target) => !previousTargetIds.has(target.id));
        if (added.length === 1) {
          return added[0]!;
        }
        await sleep(200);
      }
      throw new Error("Timed out waiting for browser CDP target");
    }

    async function waitForLikelyCreatedTarget(baseUrl: string): Promise<BrowserTarget> {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const claimedTargetIds = collectClaimedTargetIds();
        const candidates = (await fetchBrowserTargets(baseUrl)).filter((target) => !claimedTargetIds.has(target.id));
        const matched = matchTargetsForCurrentPane(candidates);
        if (matched.length === 1) {
          return matched[0]!;
        }
        if (matched.length === 0 && candidates.length === 1) {
          return candidates[0]!;
        }
        await sleep(200);
      }
      throw new Error("Timed out waiting for likely browser CDP target");
    }

    function collectClaimedTargetIds(): Set<string> {
      const claimed = new Set<string>();
      for (const pane of context.getAppSummary().panes) {
        if (pane.kind !== "browser" || String(pane.paneId) === String(context.paneId)) {
          continue;
        }
        const value = context.getPane(pane.paneId).props.get("browser.cdp.targetId");
        if (typeof value === "string" && value) {
          claimed.add(value);
        }
      }
      return claimed;
    }

    function matchTargetsForCurrentPane(targets: BrowserTarget[]): BrowserTarget[] {
      const normalizedCurrentUrl = normalizeBrowserUrlValue(currentUrl);
      return targets.filter((target) => {
        const normalizedTargetUrl = normalizeBrowserUrlValue(target.url ?? "");
        if (normalizedCurrentUrl === "about:blank") {
          return normalizedTargetUrl === "about:blank" || normalizedTargetUrl.length === 0;
        }
        return normalizedTargetUrl === normalizedCurrentUrl;
      });
    }
  }
});

function normalizeParams(value: unknown): BrowserParams {
  const raw = value as Partial<BrowserParams> | null | undefined;
  return {
    url: typeof raw?.url === "string" ? raw.url : "about:blank",
    adapter: raw?.adapter === "web-iframe" ? "web-iframe" : "electrobun-native"
  };
}

function extractWebviewUrl(detail: unknown): string | null {
  if (typeof detail === "string" && detail.length > 0) {
    return normalizeBrowserUrlValue(detail);
  }

  if (detail && typeof detail === "object") {
    const candidate = (detail as { url?: unknown }).url;
    if (typeof candidate === "string" && candidate.length > 0) {
      return normalizeBrowserUrlValue(candidate);
    }
  }

  return null;
}

function normalizeBrowserUrlValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{")) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed) as { url?: unknown };
    if (typeof parsed.url === "string" && parsed.url.trim().length > 0) {
      return parsed.url.trim();
    }
  } catch {
    // keep original string when it is not JSON
  }

  return trimmed;
}

function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    return "about:blank";
  }

  if (value.startsWith("http://") || value.startsWith("https://") || value.startsWith("about:")) {
    return value;
  }

  if (value.includes(".") && !value.includes(" ")) {
    return `https://${value}`;
  }

  return `https://www.google.com/search?q=${encodeURIComponent(value)}`;
}

function browserTitleFromUrl(url: string): string {
  try {
    const parsed = new URL(normalizeBrowserUrlValue(url));
    return parsed.hostname || "Browser";
  } catch {
    return "Browser";
  }
}

function createBrowserWelcome(): HTMLElement {
  const element = document.createElement("div");
  element.className = "browser-welcome";
  element.innerHTML = `<div class="browser-welcome-card">
  <div class="browser-welcome-title">flmux</div>
  <div class="browser-welcome-subtitle">Search or enter a URL to get started</div>
  <input class="browser-welcome-input" type="text" placeholder="Search or enter URL" spellcheck="false" autocomplete="off" />
  <div class="browser-welcome-links">
    <button type="button" class="browser-welcome-link" data-url="https://www.google.com">Google</button>
    <button type="button" class="browser-welcome-link" data-url="https://github.com">GitHub</button>
    <button type="button" class="browser-welcome-link" data-url="https://developer.mozilla.org">MDN</button>
  </div>
</div>`;
  return element;
}

async function fetchBrowserTargets(baseUrl: string): Promise<BrowserTarget[]> {
  try {
    const response = await fetch(`${baseUrl}/json/list`);
    const raw = (await response.json()) as Array<Record<string, string>>;
    return raw
      .filter((target) => target.type === "page" && !!target.webSocketDebuggerUrl)
      .map((target) => ({
        id: target.id ?? "",
        title: target.title ?? "",
        url: target.url ?? "",
        type: target.type ?? "",
        webSocketDebuggerUrl: target.webSocketDebuggerUrl ?? ""
      }));
  } catch {
    return [];
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

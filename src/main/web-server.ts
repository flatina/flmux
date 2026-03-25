import { existsSync } from "node:fs";
import { join, normalize, resolve } from "node:path";

export interface FlmuxWebServer {
  url: string;
  port: number;
  stop: () => void;
}

export interface StartWebServerOptions {
  staticRoot?: string | null;
}

export function startWebServer(options: StartWebServerOptions = {}): FlmuxWebServer {
  const staticRoot = options.staticRoot ? resolve(options.staticRoot) : null;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/about") {
        return new Response(aboutPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/health") {
        return Response.json({ ok: true, uptime: process.uptime() });
      }

      if (url.pathname === "/api/status") {
        return Response.json({
          app: "flmux",
          pid: process.pid,
          platform: process.platform,
          uptime: process.uptime()
        });
      }

      const staticResponse = serveStaticFile(url.pathname, staticRoot);
      if (staticResponse) {
        return staticResponse;
      }

      return new Response("Not Found", { status: 404 });
    }
  });

  const port = server.port ?? 0;
  const serverUrl = `http://127.0.0.1:${port}`;

  return {
    url: serverUrl,
    port,
    stop: () => server.stop()
  };
}

function serveStaticFile(pathname: string, staticRoot: string | null): Response | null {
  if (!staticRoot) {
    return null;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidates = [
    resolve(join(staticRoot, normalize(relativePath))),
    resolve(join(staticRoot, normalize(relativePath), "index.html")),
    resolve(join(staticRoot, normalize(`${relativePath}.html`)))
  ];

  for (const candidate of candidates) {
    if (!candidate.startsWith(staticRoot)) {
      return new Response("Not Found", { status: 404 });
    }

    if (!existsSync(candidate)) {
      continue;
    }

    return new Response(Bun.file(candidate));
  }

  return null;
}

function aboutPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>flmux</title>
  <style>
    * { margin: 0; box-sizing: border-box; }
    body {
      font-family: "Segoe UI", system-ui, sans-serif;
      background: #11151c;
      color: #e8edf2;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 2rem;
    }
    .card {
      max-width: 480px;
      padding: 2rem;
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 12px;
      background: linear-gradient(180deg, #18202b, #202b38);
    }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    .muted { color: #98a6b7; font-size: 0.875rem; }
    .row { display: flex; justify-content: space-between; padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .row:last-child { border: none; }
    .label { color: #98a6b7; }
    a { color: #ffad5a; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <h1>flmux</h1>
    <p class="muted">Desktop workspace built on Electrobun and Dockview.</p>
    <div style="margin-top:1.5rem">
      <div class="row"><span class="label">PID</span><span>${process.pid}</span></div>
      <div class="row"><span class="label">Platform</span><span>${process.platform}</span></div>
      <div class="row"><span class="label">Bun</span><span>${Bun.version}</span></div>
      <div class="row"><span class="label">Health</span><a href="/health">/health</a></div>
      <div class="row"><span class="label">Status API</span><a href="/api/status">/api/status</a></div>
    </div>
  </div>
</body>
</html>`;
}

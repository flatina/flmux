export interface FlmuxWebServer {
  url: string;
  port: number;
  stop: () => void;
}

export function startWebServer(): FlmuxWebServer {
  const server = Bun.serve({
    port: 0, // OS picks a free port
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/" || url.pathname === "/about") {
        return new Response(aboutPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (url.pathname === "/automation") {
        return new Response(automationPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
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

function automationPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Automation Fixture</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Segoe UI", system-ui, sans-serif;
      background: radial-gradient(circle at top, #1f2a38, #0f141b 60%);
      color: #e8edf2;
      display: grid;
      place-items: center;
      padding: 2rem;
    }
    .card {
      width: min(680px, 100%);
      padding: 24px;
      border-radius: 16px;
      border: 1px solid rgba(255,255,255,0.08);
      background: rgba(11, 16, 22, 0.92);
      box-shadow: 0 24px 80px rgba(0,0,0,0.35);
    }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { margin: 0 0 20px; color: #9db0c3; line-height: 1.6; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
      margin-bottom: 16px;
    }
    label {
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 14px;
      color: #cfd8e3;
    }
    input {
      width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid rgba(255,255,255,0.12);
      background: #131a23;
      color: #f4f7fa;
      font: inherit;
    }
    button {
      padding: 10px 14px;
      border: none;
      border-radius: 10px;
      background: #ffb45e;
      color: #0f141b;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    .toolbar {
      display: flex;
      gap: 10px;
      margin-bottom: 16px;
    }
    .status {
      padding: 12px;
      border-radius: 10px;
      background: rgba(255,255,255,0.04);
      color: #cfd8e3;
      min-height: 48px;
    }
    .result {
      margin-top: 16px;
      padding: 14px;
      border-radius: 12px;
      background: rgba(127, 209, 185, 0.08);
      border: 1px solid rgba(127, 209, 185, 0.18);
      color: #dff7ef;
      min-height: 52px;
    }
  </style>
</head>
<body>
  <main class="card">
    <h1>Automation Fixture</h1>
    <p>Use this page to verify fill, value, attr, press, and wait-target browser automation flows.</p>
    <div class="toolbar">
      <button id="reveal-button" data-testid="reveal-button" type="button">Reveal Result</button>
      <button id="focus-button" data-testid="focus-button" type="button">Focus Name</button>
    </div>
    <div class="grid">
      <label>Name
        <input id="name-input" data-testid="name-input" name="name" placeholder="Type a name" />
      </label>
      <label>Email
        <input id="email-input" data-testid="email-input" name="email" type="email" placeholder="name@example.com" />
      </label>
    </div>
    <div class="status" id="status" data-testid="status">Waiting for input...</div>
    <div class="result" id="result" data-testid="result" hidden></div>
  </main>
  <script>
    const nameInput = document.getElementById("name-input");
    const emailInput = document.getElementById("email-input");
    const status = document.getElementById("status");
    const result = document.getElementById("result");
    const reveal = document.getElementById("reveal-button");
    const focusButton = document.getElementById("focus-button");

    function renderStatus() {
      status.textContent = \`name=\${nameInput.value || "(empty)"} / email=\${emailInput.value || "(empty)"}\`;
    }

    reveal.addEventListener("click", () => {
      result.hidden = false;
      result.textContent = \`submitted:\${nameInput.value}|\${emailInput.value}\`;
    });

    focusButton.addEventListener("click", () => nameInput.focus());
    nameInput.addEventListener("input", renderStatus);
    emailInput.addEventListener("input", renderStatus);
    nameInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        reveal.click();
      }
    });
    renderStatus();
  </script>
</body>
</html>`;
}

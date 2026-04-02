import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AppRpcClient } from "../../src/flmux/client/rpc-client";
import { createAppRpcClient } from "../../src/flmux/client/rpc-client";
import { resolveSession } from "../../src/flmux/client/session-discovery";
import type { PropertyChangeEvent } from "../../src/types/property";

export const projectRoot = resolve(import.meta.dir, "../..");

/** Poll until the app is reachable, max waitMs. */
export async function waitForApp(waitMs = 5000, intervalMs = 100): Promise<AppRpcClient> {
  const deadline = Date.now() + waitMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const session = await resolveSession();
      const client = createAppRpcClient({ ipcPath: session.ipcPath });
      await client.call("system.ping", undefined);
      await client.call("app.summary", undefined);
      return client;
    } catch (e) {
      lastError = e;
      await sleep(intervalMs);
    }
  }

  throw new Error(`App not reachable after ${waitMs}ms: ${lastError}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS — ${label}`);
  } else {
    console.error(`  FAIL — ${label}`);
    process.exitCode = 1;
  }
}

/** Spawn `bun <args>` synchronously from project root and capture output. */
export function runCli(args: string[], env: Record<string, string | undefined>) {
  const result = Bun.spawnSync(["bun", ...args], {
    cwd: projectRoot,
    env,
    stdout: "pipe",
    stderr: "pipe"
  });

  return {
    code: result.exitCode,
    stdout: Buffer.from(result.stdout).toString().trim(),
    stderr: Buffer.from(result.stderr).toString().trim()
  };
}

/** Capture the flmux app window to a PNG file in .tmp/.
 *  Uses FLMUX_TEST_APP_PID env (set by e2e runner) to find the correct window. */
export function captureAppWindow(name: string): string {
  const dir = resolve(projectRoot, ".tmp");
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, `${name}.png`);
  const pid = process.env.FLMUX_TEST_APP_PID;
  if (!pid) {
    console.log(`  Screenshot skipped (no FLMUX_TEST_APP_PID)`);
    return outPath;
  }
  const ps = `
Add-Type @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public class WinCapture {
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint nFlags);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static void CaptureByPids(HashSet<int> pids, string path) {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hWnd, _) => {
            uint wpid; GetWindowThreadProcessId(hWnd, out wpid);
            if (pids.Contains((int)wpid) && IsWindowVisible(hWnd)) {
                RECT r; GetWindowRect(hWnd, out r);
                if (r.Right - r.Left > 200 && r.Bottom - r.Top > 200) {
                    found = hWnd; return false;
                }
            }
            return true;
        }, IntPtr.Zero);
        if (found == IntPtr.Zero) return;
        RECT rect; GetWindowRect(found, out rect);
        int w = rect.Right - rect.Left, h = rect.Bottom - rect.Top;
        using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
            using (var g = Graphics.FromImage(bmp)) {
                IntPtr hdc = g.GetHdc();
                PrintWindow(found, hdc, 2);
                g.ReleaseHdc(hdc);
            }
            bmp.Save(path, ImageFormat.Png);
        }
    }
}
'@ -ReferencedAssemblies System.Drawing
$pids = New-Object 'System.Collections.Generic.HashSet[int]'
$pids.Add(${pid}) | Out-Null
Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq ${pid} } | ForEach-Object { $pids.Add([int]$_.ProcessId) | Out-Null }
[WinCapture]::CaptureByPids($pids, '${outPath.replace(/\\/g, "\\\\")}')
`;
  Bun.spawnSync(["powershell.exe", "-NoProfile", "-Command", ps], { stdout: "ignore", stderr: "ignore" });
  console.log(`  Screenshot: ${outPath}`);
  return outPath;
}

const VISION_API_URL = process.env.VISION_API_URL;
const VISION_API_KEY = process.env.VISION_API_KEY;
const VISION_MODEL = process.env.VISION_MODEL ?? "default";

/** Describe a screenshot using an OpenAI-compatible vision API.
 *  Requires VISION_API_URL env var. Optional: VISION_API_KEY, VISION_MODEL. */
export async function describeScreenshot(imagePath: string, prompt = "Describe what you see in this application window screenshot. Focus on: visible panes, their content (loaded page vs white/blank), URL bar text, tab labels, and any visual anomalies."): Promise<string> {
  if (!VISION_API_URL) return "(skipped — VISION_API_URL not set)";

  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(imagePath)) return "(screenshot file not found)";

  const base64 = readFileSync(imagePath).toString("base64");
  try {
    const response = await fetch(`${VISION_API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(VISION_API_KEY ? { Authorization: `Bearer ${VISION_API_KEY}` } : {}) },
      body: JSON.stringify({
        model: VISION_MODEL,
        messages: [{
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
            { type: "text", text: prompt }
          ]
        }],
        max_tokens: 512
      })
    });
    if (!response.ok) return `(vision API error: ${response.status})`;
    const json = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    return json.choices?.[0]?.message?.content ?? "(no response)";
  } catch (e) {
    return `(vision API unavailable: ${e})`;
  }
}

/** Poll an event array until a matching PropertyChangeEvent appears. */
export async function waitForPropertyEvent(
  events: PropertyChangeEvent[],
  predicate: (event: PropertyChangeEvent) => boolean,
  timeoutMs = 5000
): Promise<PropertyChangeEvent> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = events.find(predicate);
    if (match) {
      return match;
    }
    await sleep(50);
  }
  throw new Error("Timed out waiting for property change event");
}

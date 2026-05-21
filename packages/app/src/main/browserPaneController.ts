import type { Connection } from "bunite-core/rpc";
import { ModelPathError, type BrowserPaneCallable, type BrowserPaneController } from "@flmux/core/shell";
import { paneBrowserCap, type PaneBrowserCap } from "../shared/rendererBridge";
import type { BrowserAgentSurface } from "./browserAgentSurface";

/**
 * Bridges core's path layer to the renderer-served `paneBrowserCap`. One
 * controller per authority. Holds the most-recent renderer connection;
 * desktop has exactly one. Web mode multi-tab: last bind wins (v1 — adequate
 * for single-user-per-authority usage; multi-tab automation routing is v2).
 */
export interface AuthorityBrowserPaneController extends BrowserPaneController {
  setConnection(conn: Connection | null): void;
  clearConnectionIf(conn: Connection): void;
  /** Subscribe to connection rebind events. Triggered on every `setConnection`
   * (including null→conn, conn→conn-prime, conn→null) and on `clearConnectionIf`
   * when it matches. Consumers (`BrowserAgentSurface`) use this to restart
   * pane-scoped streams + cap-bootstrap caches. Returns an unsubscribe fn. */
  onConnectionChanged(handler: (conn: Connection | null) => void): () => void;
  /** Expose primCap promise to consumers (agent surface, etc.). Resolves
   * to current cap proxy; throws if no connection. Re-resolved on each
   * connection change (capPromise invalidated). */
  primCap(): Promise<PaneBrowserCap>;
  /** Inject agent surface for composition op routing. Authority wires this
   * after construction (cycle: controller ↔ agent surface). */
  setAgentSurface(agent: BrowserAgentSurface | null): void;
}

export function createBrowserPaneController(): AuthorityBrowserPaneController {
  let conn: Connection | null = null;
  let capPromise: Promise<PaneBrowserCap> | null = null;
  let agentSurface: BrowserAgentSurface | null = null;
  const connListeners = new Set<(conn: Connection | null) => void>();

  function notifyConn(next: Connection | null) {
    for (const fn of connListeners) {
      try {
        fn(next);
      } catch (err) {
        console.error("[browserPaneController] onConnectionChanged handler threw", err);
      }
    }
  }

  function getCap(): Promise<PaneBrowserCap> {
    if (!conn) {
      // No PathErrorCode for "server transiently unavailable"; INVALID_VALUE
      // is the closest caller-actionable code (retry once renderer connects).
      throw new ModelPathError("INVALID_VALUE", "browser pane automation: no renderer connection bound");
    }
    if (!capPromise) capPromise = conn.bootstrap(paneBrowserCap);
    return capPromise;
  }

  function clearConnectionIf(target: Connection) {
    if (conn === target) {
      conn = null;
      capPromise = null;
      notifyConn(null);
    }
  }

  async function dispatch(
    paneId: string,
    op: BrowserPaneCallable,
    args: Record<string, unknown>
  ): Promise<{ value: unknown }> {
    if (agentSurface && agentSurface.handles(op)) {
      return await agentSurface.call(paneId, op, args);
    }
    const cap = await getCap();
    switch (op) {
      case "evaluate": {
        const script = expectString(args, "script");
        const result = await cap.evaluate({ paneId, script });
        return { value: result };
      }
      case "click": {
        const x = expectNumber(args, "x");
        const y = expectNumber(args, "y");
        await cap.click({
          paneId,
          x,
          y,
          button: optionalButton(args.button),
          clickCount: optionalNumber(args.clickCount),
          modifiers: optionalModifiers(args.modifiers)
        });
        return { value: null };
      }
      case "type": {
        const text = expectString(args, "text");
        await cap.type({ paneId, text });
        return { value: null };
      }
      case "press": {
        const key = expectString(args, "key");
        await cap.press({ paneId, key, modifiers: optionalModifiers(args.modifiers) });
        return { value: null };
      }
      case "scroll": {
        const dx = expectNumber(args, "dx");
        const dy = expectNumber(args, "dy");
        await cap.scroll({
          paneId,
          dx,
          dy,
          x: optionalNumber(args.x),
          y: optionalNumber(args.y),
          modifiers: optionalModifiers(args.modifiers)
        });
        return { value: null };
      }
      case "screenshot": {
        const result = await cap.screenshot({
          paneId,
          format: optionalScreenshotFormat(args.format),
          quality: optionalNumber(args.quality)
        });
        // JSON.stringify(Uint8Array) produces a numeric-key object, not an
        // array — base64-encode so the CLI consumer reads a stable string.
        if (result.ok) {
          return {
            value: {
              ok: true,
              data: bytesToBase64(result.data),
              mime: result.mime,
              format: result.format
            }
          };
        }
        return { value: result };
      }
      case "capabilities":
        return { value: await cap.capabilities({ paneId }) };
      case "goBack":
        await cap.goBack({ paneId });
        return { value: null };
      case "reload":
        await cap.reload({ paneId });
        return { value: null };
      default:
        throw new Error(`browser pane controller: unknown op '${op}'`);
    }
  }

  return {
    setConnection(next) {
      if (conn === next) return;
      conn = next;
      capPromise = null;
      notifyConn(next);
    },
    clearConnectionIf,
    onConnectionChanged(handler) {
      connListeners.add(handler);
      return () => connListeners.delete(handler);
    },
    primCap: getCap,
    setAgentSurface(agent) {
      agentSurface = agent;
    },
    call: (paneId, op, args) => dispatch(paneId, op, args),
    getStatus: () => undefined
  };
}

function invalidValue(message: string): never {
  throw new ModelPathError("INVALID_VALUE", message);
}

function expectString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") invalidValue(`browser automation: '${key}' must be a string`);
  return value;
}

function expectNumber(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidValue(`browser automation: '${key}' must be a finite number`);
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    invalidValue("browser automation: optional number must be finite");
  }
  return value;
}

function optionalButton(value: unknown): "left" | "middle" | "right" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "left" || value === "middle" || value === "right") return value;
  invalidValue(`browser automation: 'button' must be 'left' | 'middle' | 'right'`);
}

function optionalScreenshotFormat(value: unknown): "png" | "jpeg" | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === "png" || value === "jpeg") return value;
  invalidValue(`browser automation: 'format' must be 'png' | 'jpeg'`);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

const MODIFIER_NAMES = new Set(["alt", "ctrl", "meta", "shift"]);

function optionalModifiers(value: unknown): Array<"alt" | "ctrl" | "meta" | "shift"> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) invalidValue("browser automation: 'modifiers' must be an array");
  const out: Array<"alt" | "ctrl" | "meta" | "shift"> = [];
  for (const m of value) {
    if (typeof m !== "string" || !MODIFIER_NAMES.has(m)) {
      invalidValue(`browser automation: modifier must be one of 'alt'|'ctrl'|'meta'|'shift'`);
    }
    out.push(m as "alt" | "ctrl" | "meta" | "shift");
  }
  return out;
}

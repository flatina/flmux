#!/usr/bin/env bun
import { resolve } from "node:path";
import { Browser, CDPClient, discoverTargets, findTarget } from "@flatina/browser-ctl";
import { getBrowserCtlRefsPath } from "../shared/paths";

const CDP_PORT = Number(process.env.FLMUX_CDP_PORT ?? "9222");
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const REFS_PATH = resolve(getBrowserCtlRefsPath());

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(): { target: string | null; cmd: string; args: string[]; flags: Record<string, string | true> } {
  const raw = process.argv.slice(2);
  let target: string | null = null;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--target" && i + 1 < raw.length) target = raw[++i];
    else if (a === "--compact") flags.compact = true;
    else if (a === "--selector" && i + 1 < raw.length) flags.selector = raw[++i];
    else if (a === "--roles" && i + 1 < raw.length) flags.roles = raw[++i];
    else if (a.startsWith("--")) flags[a.slice(2)] = true;
    else positional.push(a);
  }
  return { target, cmd: positional[0] ?? "help", args: positional.slice(1), flags };
}

async function connectBrowser(hint: string | null): Promise<Browser> {
  const targets = await discoverTargets(CDP_BASE);
  const target = findTarget(targets, (t) => {
    if (t.url.startsWith("views://")) return false;
    if (!hint) return true;
    return t.title.toLowerCase().includes(hint.toLowerCase()) || t.url.includes(hint);
  });
  if (!target) {
    die(
      `No browser target found.\n${targets
        .filter((t) => t.type === "page")
        .map((t) => `  ${t.title} — ${t.url}`)
        .join("\n")}`
    );
  }
  const client = await CDPClient.connect(target.webSocketDebuggerUrl);
  return new Browser(client, target.url, REFS_PATH);
}

const { target: hint, cmd, args, flags } = parseArgs();

if (cmd === "help" || cmd === "--help") {
  console.log(`flmux-browser — browser pane controller

Target:  --target <hint>   Match by title/URL (default: first browser target)

Snapshot:
  snapshot [--compact] [--selector <sel>] [--roles <r1,r2>]

Navigation:
  navigate <url>          Navigate to URL
  back / forward / reload

Interaction:
  click @e1               Click element
  dblclick @e1            Double-click
  hover @e1               Hover over element
  focus @e1               Focus element
  fill @e2 "text"         Clear + set input value
  type "text"             Type at current focus
  press Enter             Key press / combo (Control+a, Shift+Tab, …)
  select @e1 val1 val2    Select dropdown option(s)
  check @e1 / uncheck @e1
  scroll [ref] <dx> <dy>  Scroll (page or element)

Query:
  get text|html|value|url|title|attr|box @e1 [attr-name]
  is visible|enabled|checked @e1

Page:
  screenshot [path]       Capture PNG
  eval <js>               Evaluate JavaScript
  dialog accept|dismiss [text]

Wait:
  wait <ms|selector>
  wait load
  wait idle [idleMs]

Other:
  list                    List CDP targets`);
  process.exit(0);
}

if (cmd === "list") {
  for (const t of (await discoverTargets(CDP_BASE)).filter((t) => t.type === "page")) {
    console.log(`[${t.url.startsWith("views://") ? "renderer" : "browser"}] ${t.title} — ${t.url}`);
  }
  process.exit(0);
}

const b = await connectBrowser(hint);
try {
  switch (cmd) {
    case "snapshot":
      console.log(
        await b.snapshot({
          compact: !!flags.compact,
          selector: typeof flags.selector === "string" ? flags.selector : undefined,
          roles: typeof flags.roles === "string" ? flags.roles.split(",") : undefined
        })
      );
      break;

    // Navigation
    case "navigate":
      if (!args[0]) die("Usage: navigate <url>");
      await b.navigate(args[0]);
      console.log(`navigated to ${args[0]}`);
      break;
    case "back":
      await b.back();
      break;
    case "forward":
      await b.forward();
      break;
    case "reload":
      await b.reload();
      break;

    // Interaction
    case "click":
      if (!args[0]) die("Usage: click @e1");
      await b.click(args[0]);
      console.log(`clicked ${args[0]}`);
      break;
    case "dblclick":
      if (!args[0]) die("Usage: dblclick @e1");
      await b.dblclick(args[0]);
      console.log(`dblclicked ${args[0]}`);
      break;
    case "hover":
      if (!args[0]) die("Usage: hover @e1");
      await b.hover(args[0]);
      break;
    case "focus":
      if (!args[0]) die("Usage: focus @e1");
      await b.focus(args[0]);
      break;
    case "fill":
      if (!args[0] || !args[1]) die('Usage: fill @e2 "text"');
      await b.fill(args[0], args.slice(1).join(" "));
      console.log(`filled ${args[0]}`);
      break;
    case "type":
      if (!args[0]) die('Usage: type "text"');
      await b.type(args.join(" "));
      break;
    case "press":
      if (!args[0]) die("Usage: press Enter");
      await b.press(args[0]);
      break;
    case "select":
      if (!args[0] || !args[1]) die("Usage: select @e1 val1 val2");
      await b.select(args[0], ...args.slice(1));
      break;
    case "check":
      if (!args[0]) die("Usage: check @e1");
      await b.check(args[0], true);
      break;
    case "uncheck":
      if (!args[0]) die("Usage: uncheck @e1");
      await b.check(args[0], false);
      break;
    case "scroll": {
      const hasRef = args[0]?.startsWith("@");
      const ref = hasRef ? args[0] : null;
      const nums = hasRef ? args.slice(1) : args;
      const dx = Number(nums[0] ?? 0);
      const dy = Number(nums[1] ?? 400);
      await b.scroll(ref, dx, dy);
      break;
    }

    // Query
    case "get":
      if (!args[0]) die("Usage: get text|html|value|url|title|attr|box @e1");
      switch (args[0]) {
        case "url":
          console.log(await b.getUrl());
          break;
        case "title":
          console.log(await b.getTitle());
          break;
        case "text":
          if (!args[1]) die("Usage: get text @e1");
          console.log(await b.getText(args[1]));
          break;
        case "html":
          if (!args[1]) die("Usage: get html @e1");
          console.log(await b.getHtml(args[1]));
          break;
        case "value":
          if (!args[1]) die("Usage: get value @e1");
          console.log(await b.getValue(args[1]));
          break;
        case "attr":
          if (!args[1] || !args[2]) die("Usage: get attr @e1 name");
          console.log(await b.getAttr(args[1], args[2]));
          break;
        case "box":
          if (!args[1]) die("Usage: get box @e1");
          console.log(JSON.stringify(await b.getBox(args[1])));
          break;
        default:
          die(`Unknown: get ${args[0]}`);
      }
      break;
    case "is":
      if (!args[0] || !args[1]) die("Usage: is visible|enabled|checked @e1");
      switch (args[0]) {
        case "visible":
          console.log(await b.isVisible(args[1]));
          break;
        case "enabled":
          console.log(await b.isEnabled(args[1]));
          break;
        case "checked":
          console.log(await b.isChecked(args[1]));
          break;
        default:
          die(`Unknown: is ${args[0]}`);
      }
      break;

    // Page
    case "screenshot": {
      const path = args[0] ?? "screenshot.png";
      await Bun.write(path, Buffer.from(await b.screenshot(), "base64"));
      console.log(`saved ${path}`);
      break;
    }
    case "eval": {
      if (!args[0]) die("Usage: eval <js>");
      const result = await b.eval(args.join(" "));
      if (result !== undefined) console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
      break;
    }
    case "dialog":
      if (!args[0]) die("Usage: dialog accept|dismiss [text]");
      await b.dialog(args[0] as "accept" | "dismiss", args[1]);
      break;

    // Wait
    case "wait":
      if (!args[0]) die("Usage: wait <ms|selector|load|idle>");
      if (args[0] === "load") await b.waitForLoad();
      else if (args[0] === "idle") await b.waitForNetworkIdle(Number(args[1]) || 500);
      else {
        const ms = Number(args[0]);
        await b.wait(Number.isFinite(ms) && ms > 0 ? ms : args[0]);
      }
      break;

    default:
      die(`Unknown: ${cmd}. Run 'flmux-browser help'`);
  }
} finally {
  await b.close();
}

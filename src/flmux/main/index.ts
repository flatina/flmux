// Enable WebView2 remote debugging for CDP-based browser automation.
// Must be in the process environment before CreateCoreWebView2EnvironmentWithOptions.
if (process.platform === "win32" && !process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) {
  process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222";
}

async function main(): Promise<void> {
  if (process.argv.includes("--ptyd")) {
    const { runPtydDaemonProcess } = await import("../../ptyd/daemon");
    await runPtydDaemonProcess();
    return;
  }

  const { runAppMain } = await import("./app-main");
  await runAppMain();
}

void main();

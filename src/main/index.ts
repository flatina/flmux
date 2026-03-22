async function main(): Promise<void> {
  if (process.argv.includes("--ptyd")) {
    const { runPtydDaemonProcess } = await import("./ptyd-daemon");
    await runPtydDaemonProcess();
    return;
  }

  const { runAppMain } = await import("./app-main");
  await runAppMain();
}

void main();

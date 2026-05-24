// Compiled-binary dispatcher: FLMUX_INTERNAL_MODE picks ptyd / cli; default = main.

export {};

const mode = process.env.FLMUX_INTERNAL_MODE;

if (mode === "ptyd") {
  delete process.env.FLMUX_INTERNAL_MODE;
  await import("./main/ptyd/daemonMain");
} else if (mode === "cli") {
  delete process.env.FLMUX_INTERNAL_MODE;
  await import("./cli");
} else {
  await import("./main");
}

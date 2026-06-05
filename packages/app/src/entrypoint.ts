// Compiled-binary dispatcher: FLMUX_INTERNAL_MODE picks ptyd / cli; default = main.

// MUST stay first: @simplewebauthn/server → @peculiar/x509 uses tsyringe, whose
// decorator metadata needs the reflect-metadata polyfill at import time. The
// compiled binary has no ambient polyfill, so load it before the dynamic imports
// below pull that graph in. (A non-compiled `bun run` happens to work without
// it — which is why this only surfaced in the deployed binary.)
import "reflect-metadata";

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

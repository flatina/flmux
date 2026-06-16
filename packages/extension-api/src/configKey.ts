import { existsSync, readFileSync } from "node:fs";
import { CONFIG_KEY_BYTES } from "./configCrypto";

// Decrypt-side host key load. The key is a host-scoped systemd credential
// (`configkey`); the service exposes it at this tmpfs path via
// LoadCredentialEncrypted. A raw-32-byte FLMUX_CONFIG_KEY file is honored only
// when the credential is absent AND dev mode is on — never a silent prod
// downgrade or env-injected key. The encrypt side (flmux config encrypt) reads
// the same key via `systemd-creds decrypt` instead.
const SERVICE_CRED_PATH = "/run/credentials/flmux.service/configkey";

export function loadHostConfigKey(): Buffer {
  if (existsSync(SERVICE_CRED_PATH)) return requireKeyBytes(readFileSync(SERVICE_CRED_PATH), SERVICE_CRED_PATH);
  const devFile = process.env.FLMUX_CONFIG_KEY;
  if (devFile && process.env.FLMUX_DEV_MODE === "1") {
    if (!existsSync(devFile)) throw new Error(`FLMUX_CONFIG_KEY file not found: ${devFile}`);
    return requireKeyBytes(readFileSync(devFile), devFile);
  }
  throw new Error("host config key unavailable (no systemd credential 'configkey')");
}

function requireKeyBytes(buf: Buffer, src: string): Buffer {
  if (buf.length !== CONFIG_KEY_BYTES) {
    throw new Error(`config key at ${src} must be ${CONFIG_KEY_BYTES} raw bytes (got ${buf.length})`);
  }
  return buf;
}

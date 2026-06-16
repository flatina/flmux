// Standalone pre-auth pages served before the workbench bundle loads. Minimal
// hand-rolled base64url + navigator.credentials glue (not security-critical —
// the server verifies every ceremony).

const CLIENT_GLUE = /* js */ `
const b64uToBuf = (s) => {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob((s + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
};
const bufToB64u = (buf) => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
};
// PublicKeyCredentialCreationOptionsJSON -> DOM options
const toCreate = (o) => ({
  ...o,
  challenge: b64uToBuf(o.challenge),
  user: { ...o.user, id: b64uToBuf(o.user.id) },
  excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }))
});
const toGet = (o) => ({
  ...o,
  challenge: b64uToBuf(o.challenge),
  allowCredentials: (o.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) }))
});
const regToJSON = (c) => ({
  id: c.id,
  rawId: bufToB64u(c.rawId),
  type: c.type,
  response: {
    clientDataJSON: bufToB64u(c.response.clientDataJSON),
    attestationObject: bufToB64u(c.response.attestationObject),
    transports: c.response.getTransports ? c.response.getTransports() : []
  },
  clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}
});
const authToJSON = (c) => ({
  id: c.id,
  rawId: bufToB64u(c.rawId),
  type: c.type,
  response: {
    clientDataJSON: bufToB64u(c.response.clientDataJSON),
    authenticatorData: bufToB64u(c.response.authenticatorData),
    signature: bufToB64u(c.response.signature),
    userHandle: c.response.userHandle ? bufToB64u(c.response.userHandle) : undefined
  },
  clientExtensionResults: c.getClientExtensionResults ? c.getClientExtensionResults() : {}
});
const postJSON = async (url, body) => {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body || {})
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || ("HTTP " + r.status));
  return data;
};
const setStatus = (msg, isError) => {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = isError ? "err" : "";
};
`;

const PAGE_STYLE = /* css */ `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #e6eefc;
    background: #0f1726; font: 15px/1.5 system-ui, sans-serif; }
  main { width: min(380px, 90vw); padding: 28px; border: 1px solid #32445f; border-radius: 14px; background: #111c2d; }
  h1 { margin: 0 0 6px; font-size: 20px; }
  p { margin: 0 0 18px; color: #9fb3d1; }
  button { width: 100%; padding: 11px 16px; border: 0; border-radius: 10px; cursor: pointer;
    background: #2f6df0; color: white; font-size: 15px; font-weight: 600; }
  button:disabled { opacity: 0.6; cursor: default; }
  input { width: 100%; box-sizing: border-box; padding: 11px 14px; margin-bottom: 10px;
    border: 1px solid #32445f; border-radius: 10px; background: #0f1726; color: #e6eefc; font-size: 15px; }
  .sep { text-align: center; color: #6b7f9e; margin: 14px 0; font-size: 13px; }
  a.link { display: inline-block; margin-top: 10px; color: #7fa8ff; font-size: 13px; cursor: pointer; }
  #status { margin-top: 14px; font-size: 13px; min-height: 18px; }
  #status.err { color: #ff9a9a; }
`;

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const renderLoginPage = (appName: string, methods: string[] = ["passkey"]) => {
  const brand = escapeHtml(appName);
  const passkey = methods.includes("passkey");
  const totp = methods.includes("totp");
  const passkeyBlock = passkey ? `<button id="go">Sign in with passkey</button>` : "";
  const sep = passkey && totp ? `<div class="sep">— or —</div>` : "";
  const totpBlock = totp
    ? `<form id="totp-form" autocomplete="off">
    <input id="totp-user" placeholder="Username" autocomplete="username" required />
    <input id="totp-code" inputmode="numeric" autocomplete="one-time-code" placeholder="Authenticator code" required />
    <button type="submit">Sign in with code</button>
  </form>
  <a href="#" id="rec-toggle" class="link">Lost your device? Use a recovery code</a>`
    : "";
  const passkeyScript = passkey
    ? `const btn = document.getElementById("go");
async function login() {
  btn.disabled = true;
  setStatus("Waiting for your passkey…");
  try {
    const options = await postJSON("/api/auth/passkey/authenticate/options");
    const cred = await navigator.credentials.get({ publicKey: toGet(options) });
    await postJSON("/api/auth/passkey/authenticate/verify", authToJSON(cred));
    setStatus("Signed in. Redirecting…");
    location.href = "/";
  } catch (e) { setStatus(e.message || "Sign-in failed", true); btn.disabled = false; }
}
btn.addEventListener("click", login);`
    : "";
  const totpScript = totp
    ? `const form = document.getElementById("totp-form");
const codeInput = document.getElementById("totp-code");
const recToggle = document.getElementById("rec-toggle");
let recovery = false;
recToggle.addEventListener("click", (e) => {
  e.preventDefault();
  recovery = !recovery;
  codeInput.value = "";
  codeInput.placeholder = recovery ? "Recovery code" : "Authenticator code";
  recToggle.textContent = recovery ? "Use your authenticator code instead" : "Lost your device? Use a recovery code";
});
form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const username = document.getElementById("totp-user").value.trim();
  const code = codeInput.value.trim();
  setStatus("Verifying…");
  try {
    await postJSON(recovery ? "/api/auth/totp/recovery" : "/api/auth/totp/authenticate", { username, code });
    setStatus("Signed in. Redirecting…");
    location.href = "/";
  } catch (e) { setStatus(e.message || "Sign-in failed", true); }
});`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brand} — Sign in</title><style>${PAGE_STYLE}</style></head>
<body><main>
  <h1>Sign in to ${brand}</h1>
  ${passkeyBlock}
  ${sep}
  ${totpBlock}
  <div id="status"></div>
</main>
<script type="module">
${CLIENT_GLUE}
${passkeyScript}
${totpScript}
</script></body></html>`;
};

export const renderEnrollPage = (appName: string) => {
  const brand = escapeHtml(appName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${brand} — Register passkey</title><style>${PAGE_STYLE}</style></head>
<body><main>
  <h1>Register your passkey</h1>
  <p>Create a passkey for this ${brand} account on this device.</p>
  <button id="go">Register passkey</button>
  <div id="status"></div>
</main>
<script type="module">
${CLIENT_GLUE}
const params = new URLSearchParams(location.search);
const token = params.get("token") || "";
const btn = document.getElementById("go");
if (!token) { setStatus("Missing enrollment token in the link.", true); btn.disabled = true; }
async function enroll() {
  btn.disabled = true;
  setStatus("Creating your passkey…");
  try {
    const options = await postJSON("/api/auth/passkey/register/options", { token });
    const cred = await navigator.credentials.create({ publicKey: toCreate(options) });
    await postJSON("/api/auth/passkey/register/verify", { token, response: regToJSON(cred) });
    setStatus("Passkey registered. You can sign in now.");
    setTimeout(() => (location.href = "/login"), 1200);
  } catch (e) {
    setStatus(e.message || "Registration failed", true);
    btn.disabled = false;
  }
}
btn.addEventListener("click", enroll);
</script></body></html>`;
};

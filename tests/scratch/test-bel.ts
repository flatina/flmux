import { spawn } from "bun-pty";

const pty = spawn("powershell.exe", ["-NoProfile", "-Command", 'Write-Host "`a"'], {
  env: process.env,
  cwd: process.cwd(),
  cols: 80,
  rows: 24
});

let found = false;
pty.onData((data: string) => {
  for (let i = 0; i < data.length; i++) {
    if (data.charCodeAt(i) === 7) {
      found = true;
      console.log("BEL character found at offset", i);
    }
  }
});

pty.onExit(() => {
  console.log("BEL found:", found);
  process.exit(0);
});

setTimeout(() => {
  console.log("timeout, BEL found:", found);
  process.exit(0);
}, 5000);

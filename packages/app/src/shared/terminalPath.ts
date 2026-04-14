export function normalizeTerminalRootDir(value: string) {
  return normalizeTerminalPath(value, prefersWindowsPath(value));
}

export function resolveTerminalCwdFromRoot(rootDir: string, inputCwd: string | undefined) {
  const normalizedRootDir = normalizeTerminalRootDir(rootDir);
  if (!inputCwd || inputCwd === "." || inputCwd === ".\\" || inputCwd === "./") {
    return normalizedRootDir;
  }

  const windows = prefersWindowsPath(normalizedRootDir) || prefersWindowsPath(inputCwd);
  const normalizedInput = normalizeSeparators(inputCwd, windows);
  if (isAbsoluteTerminalPath(normalizedInput, windows)) {
    return normalizeTerminalPath(normalizedInput, windows);
  }

  return normalizeTerminalPath(joinTerminalPath(normalizedRootDir, normalizedInput, windows), windows);
}

function prefersWindowsPath(value: string) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.includes("\\");
}

function isAbsoluteTerminalPath(value: string, windows: boolean) {
  return windows
    ? /^[A-Za-z]:\\/.test(value) || value.startsWith("\\\\") || value.startsWith("\\")
    : value.startsWith("/");
}

function normalizeTerminalPath(value: string, windows: boolean) {
  const normalized = normalizeSeparators(value, windows);
  return windows ? normalizeWindowsPath(normalized) : normalizePosixPath(normalized);
}

function normalizeSeparators(value: string, windows: boolean) {
  return windows ? value.replace(/\//g, "\\") : value.replace(/\\/g, "/");
}

function joinTerminalPath(rootDir: string, inputCwd: string, windows: boolean) {
  const sep = windows ? "\\" : "/";
  const normalizedRootDir = rootDir.endsWith(sep) ? rootDir.slice(0, -1) : rootDir;
  let normalizedInput = inputCwd;
  while (normalizedInput.startsWith(sep)) {
    normalizedInput = normalizedInput.slice(1);
  }
  return `${normalizedRootDir}${sep}${normalizedInput}`;
}

function normalizeWindowsPath(value: string) {
  if (value.startsWith("\\\\")) {
    const parts = value.slice(2).split("\\").filter(Boolean);
    const server = parts.shift();
    const share = parts.shift();
    if (!server || !share) {
      return "\\\\";
    }

    const tail = collapseSegments(parts, true, "\\");
    return tail.length > 0 ? `\\\\${server}\\${share}\\${tail.join("\\")}` : `\\\\${server}\\${share}`;
  }

  const driveMatch = value.match(/^([A-Za-z]:)(\\?)(.*)$/);
  if (driveMatch) {
    const [, drive, slash, rest] = driveMatch;
    const absolute = slash === "\\";
    const tail = collapseSegments(rest.split("\\").filter(Boolean), absolute, "\\");
    if (!absolute) {
      return tail.length > 0 ? `${drive}${tail.join("\\")}` : drive;
    }

    return tail.length > 0 ? `${drive}\\${tail.join("\\")}` : `${drive}\\`;
  }

  if (value.startsWith("\\")) {
    const tail = collapseSegments(value.split("\\").filter(Boolean), true, "\\");
    return tail.length > 0 ? `\\${tail.join("\\")}` : "\\";
  }

  const relative = collapseSegments(value.split("\\").filter(Boolean), false, "\\");
  return relative.length > 0 ? relative.join("\\") : ".";
}

function normalizePosixPath(value: string) {
  const absolute = value.startsWith("/");
  const tail = collapseSegments(value.split("/").filter(Boolean), absolute, "/");
  if (absolute) {
    return tail.length > 0 ? `/${tail.join("/")}` : "/";
  }

  return tail.length > 0 ? tail.join("/") : ".";
}

function collapseSegments(segments: string[], absolute: boolean, separator: "\\" | "/") {
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === "." || segment === "") {
      continue;
    }

    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
        continue;
      }

      if (!absolute) {
        stack.push(segment);
      }
      continue;
    }

    stack.push(segment.replace(/[\\/]/g, separator));
  }

  return stack;
}

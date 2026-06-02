// Minimal `.gitignore`-style matcher for extension ship-exclusion
// (`.flmux-ext-ignore`). Supported subset: `#` comments, blank lines, `!`
// negation, leading-`/` root anchor, trailing-`/` dir-only, `*` (within a
// segment), `**` (any depth), `?`, `[class]`. Last matching rule wins. This is
// NOT full gitignore (no escaped-space / no per-line `\` escapes) — kept small
// to honor extension-devkit's zero-dependency contract.

interface IgnoreRule {
  re: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

/** Compile ignore-file text into `(relPath, isDir) => excluded`. relPath is
 *  root-relative (posix or native separators ok). */
export function compileIgnore(text: string): (relPath: string, isDir: boolean) => boolean {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let body = line;
    let negate = false;
    if (body.startsWith("!")) {
      negate = true;
      body = body.slice(1);
    }
    let dirOnly = false;
    if (body.endsWith("/")) {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    const anchored = body.startsWith("/");
    if (anchored) body = body.slice(1);
    if (!body) continue;
    // A pattern with a (non-trailing) slash is anchored to the root; otherwise
    // it matches by basename at any depth (gitignore semantics).
    rules.push({ re: toRegExp(body, anchored || body.includes("/")), negate, dirOnly });
  }
  return (relPath, isDir) => {
    const p = relPath.replace(/\\/g, "/");
    let excluded = false;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) continue;
      if (rule.re.test(p)) excluded = !rule.negate;
    }
    return excluded;
  };
}

function toRegExp(pattern: string, anchored: boolean): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (pattern[i + 1] === "/") {
          i++;
          re += "(?:.*/)?"; // `**/` → zero or more dirs
        } else {
          re += ".*"; // `**` → anything incl. `/`
        }
      } else {
        re += "[^/]*"; // `*` → within one segment
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      let cls = "[";
      let j = i + 1;
      if (pattern[j] === "!") {
        cls += "^";
        j++;
      }
      while (j < pattern.length && pattern[j] !== "]") {
        cls += pattern[j];
        j++;
      }
      i = j;
      re += `${cls}]`;
    } else {
      re += c.replace(/[.+^${}()|\\\]]/g, "\\$&");
    }
  }
  // Trailing `(?:/.*)?` lets a matched dir also cover its descendants.
  return new RegExp(`${anchored ? "^" : "(?:^|/)"}${re}(?:/.*)?$`);
}

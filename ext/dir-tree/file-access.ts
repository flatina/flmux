export interface CoreFsEntry {
  name: string;
  path: string;
  isDir: boolean;
  size?: number;
}

export async function readTextFile(path: string): Promise<string> {
  const { readFile } = await loadFs();
  return readFile(path, "utf-8");
}

export async function writeTextFile(path: string, content: string): Promise<void> {
  const { writeFile } = await loadFs();
  await writeFile(path, content, "utf-8");
}

export async function readDirEntries(dirPath: string, dirsOnly = false): Promise<CoreFsEntry[]> {
  const { readdir, stat } = await loadFs();
  const { join } = await loadPath();
  const items = await readdir(dirPath, { withFileTypes: true });
  const entries = await Promise.all(
    items
      .filter((item) => !dirsOnly || item.isDirectory())
      .map(async (item) => {
        const itemPath = join(dirPath, item.name);
        if (item.isDirectory()) {
          return {
            name: item.name,
            path: itemPath,
            isDir: true
          };
        }

        const itemStat = await stat(itemPath);
        return {
          name: item.name,
          path: itemPath,
          isDir: false,
          size: itemStat.size
        };
      })
  );

  return entries.sort((left, right) => {
    if (left.isDir !== right.isDir) {
      return left.isDir ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

async function loadFs() {
  try {
    return await import("node:fs/promises");
  } catch {
    throw new Error("Renderer file system access is unavailable");
  }
}

async function loadPath() {
  try {
    return await import("node:path");
  } catch {
    throw new Error("Renderer path utilities are unavailable");
  }
}

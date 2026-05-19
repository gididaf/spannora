import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FsEntry {
  name: string;
  hidden: boolean;
}

export interface FsListResult {
  path: string;
  parent: string | null;
  entries: FsEntry[];
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

export function normalizePath(p: string | undefined | null): string {
  if (!p || !p.trim()) return os.homedir();
  return path.resolve(expandHome(p.trim()));
}

const normalize = normalizePath;

export async function validateCwd(p: string): Promise<string> {
  const abs = normalizePath(p);
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) throw new Error(`Not a directory: ${abs}`);
  return abs;
}

export async function listDir(p: string | undefined | null): Promise<FsListResult> {
  const abs = normalize(p);
  const stat = await fs.stat(abs);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${abs}`);
  }
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const d of dirents) {
    let isDir = d.isDirectory();
    if (!isDir && d.isSymbolicLink()) {
      try {
        const target = await fs.stat(path.join(abs, d.name));
        isDir = target.isDirectory();
      } catch {
        isDir = false;
      }
    }
    if (!isDir) continue;
    entries.push({ name: d.name, hidden: d.name.startsWith(".") });
  }
  entries.sort((a, b) => {
    if (a.hidden !== b.hidden) return a.hidden ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? null : parent,
    entries,
  };
}

export async function mkdirIn(parent: string, name: string): Promise<{ path: string }> {
  if (!name || !name.trim()) throw new Error("Folder name required");
  if (/[\/\\\x00]/.test(name)) throw new Error("Folder name may not contain path separators");
  if (name === "." || name === "..") throw new Error("Invalid folder name");
  const absParent = normalize(parent);
  const target = path.join(absParent, name);
  await fs.mkdir(target, { recursive: false });
  return { path: target };
}

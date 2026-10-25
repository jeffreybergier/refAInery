import { mkdir, open, readdir, readFile, realpath, link, unlink, rename } from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

export const now = () => new Date().toISOString();
export const identity = (prefix: string) => `${prefix}-${randomUUID()}`;
export const numbered = (n: number) => String(n).padStart(6, "0");
export function requireText(value: unknown, max = 65536): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid text");
  return value;
}
export async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Persist each newly created directory entry as well as its contents. */
async function durableDirectory(path: string): Promise<void> {
  try { await mkdir(path, { mode: 0o700 }); await syncDirectory(dirname(path)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (code !== "ENOENT") throw error;
    await durableDirectory(dirname(path));
    await durableDirectory(path);
  }
}

/** Immutable durable publication. A final name can never replace a prior record. */
export async function publish(path: string, content: string) {
  await durableDirectory(dirname(path));
  const temp = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
  try { await link(temp, path); await syncDirectory(dirname(path)); }
  finally { await unlink(temp); }
}
export const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export async function readJSON<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}
export async function names(path: string): Promise<string[]> {
  try { return (await readdir(path)).filter((name) => !name.endsWith(".tmp")).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

/** Backend roots are application-owned; referenced files must not escape via links. */
export async function safeRead(root: string, path: string): Promise<string> {
  const base = await realpath(root);
  const target = await realpath(resolve(base, path));
  const child = relative(base, target);
  if (!child || child.startsWith("..") || isAbsolute(child)) throw new Error("Invalid document location");
  return readFile(target, "utf8");
}

export class Store {
  readonly root: string;
  private locked = false;
  constructor(root: string) { this.root = resolve(root); }
  path(...parts: string[]) { return resolve(this.root, ...parts); }
  async acquire() {
    await durableDirectory(this.root);
    // Deliberately no automatic stale-lock deletion: an uncertain prior worker
    // must be stopped and its records inspected before another dispatch.
    await mkdir(this.path(".writer-lock"), { mode: 0o700 });
    this.locked = true;
    await publish(this.path(".writer-lock", "owner.json"), json({ pid: process.pid, at: now() }));
    await syncDirectory(this.root);
  }
  async release() {
    if (!this.locked) return;
    const { rm } = await import("node:fs/promises");
    await rm(this.path(".writer-lock"), { recursive: true });
    await syncDirectory(this.root);
    this.locked = false;
  }
  async save(path: string, value: unknown) { await publish(this.path(path), json(value)); }
  async document(path: string, content: string) { await publish(this.path(path), content); }
  async replaceIndex(path: string, value: unknown) {
    const full = this.path(path);
    await durableDirectory(dirname(full));
    const temp = `${full}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try { await handle.writeFile(json(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, full);
    await syncDirectory(dirname(full));
  }
}

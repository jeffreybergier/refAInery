import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { relative, join, dirname, basename } from "node:path";
import { createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition } from "@earendil-works/pi-coding-agent";

/** Allocate once per request. Existing directories fail rather than being reused. */
export async function createWorkspace(workspace: string) {
  await mkdir(dirname(workspace), { recursive: true });
  await mkdir(workspace, { mode: 0o777 });
}

/** No shell on the host, credentials in the child environment, or agent-chosen Docker flags. */
async function docker(args: string[], input = "", timeout = 45000): Promise<{ text: string; code: number }> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "TMPDIR"]
      .flatMap((key) => process.env[key] ? [[key, process.env[key]!]] : []));
    const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = []; let size = 0; let failed = false;
    const timer = setTimeout(() => { failed = true; child.kill("SIGKILL"); }, timeout);
    const collect = (data: Buffer) => {
      size += data.length;
      if (size > 2 * 1024 * 1024) { failed = true; child.kill("SIGKILL"); }
      else chunks.push(data);
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    child.on("error", () => { clearTimeout(timer); reject(new Error("Sandbox process failed")); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) reject(new Error("Sandbox command exceeded resource limit"));
      else resolve({ text: Buffer.concat(chunks).toString("utf8"), code: code ?? 1 });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}
const fileScript = `
const fs = require('node:fs/promises'), p = require('node:path');
(async () => {
  let data = ''; for await (const chunk of process.stdin) data += chunk;
  const {op, path, content, workspace} = JSON.parse(data);
  const full = p.resolve(workspace, path);
  if (full !== workspace && !full.startsWith(workspace + '/')) throw Error('outside workspace');
  let ancestor = full;
  while (true) {
    try { const real = await fs.realpath(ancestor);
      if (real !== workspace && !real.startsWith(workspace + '/')) throw Error('outside workspace'); break;
    } catch (e) { if (e.code !== 'ENOENT') throw e; ancestor = p.dirname(ancestor); }
  }
  if (op === 'read') process.stdout.write((await fs.readFile(full)).toString('base64'));
  else if (op === 'access') await fs.access(full);
  else if (op === 'mkdir') await fs.mkdir(full, {recursive: true});
  else if (op === 'write') await fs.writeFile(full, content);
  else throw Error('unknown operation');
})().catch((error) => { process.stderr.write('Sandbox file operation failed: ' + error.message); process.exitCode = 1; });
`;

export class Sandbox {
  private started = false;
  private imageId?: string;
  readonly name: string;
  readonly workspace: string;
  readonly workerWorkspace: string;
  readonly image: string;
  constructor(name: string, workspace: string,
    image = "ghcr.io/jeffreybergier/altivec-intelligence:latest") {
    this.name = name; this.workspace = workspace; this.image = image;
    this.workerWorkspace = `/workspace/${basename(workspace)}`;
  }
  async start() {
    const { chmod } = await import("node:fs/promises");
    await chmod(this.workspace, 0o777);
    if (!this.imageId) {
      const inspect = await docker(["image", "inspect", "--format", "{{.Id}}", this.image]);
      if (inspect.code) throw new Error("Sandbox image unavailable; pull it explicitly first");
      this.imageId = inspect.text.trim();
    }
    // Pin every worker in this run to the first inspected image; never pull here.
    const imageId = this.imageId;
    // Docker resolves bind sources on the host, not inside this controller.
    const hostWorkspace = process.env.REFAINERY_HOST_STORAGE
      ? join(process.env.REFAINERY_HOST_STORAGE, relative("/app/storage", this.workspace))
      : this.workspace;
    const result = await docker(["run", "-d", "--name", this.name, "--network", "none", "--read-only",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "64",
      "--memory", "512m", "--cpus", "1", "--user", "65534:65534", "--tmpfs", "/tmp:rw,size=64m",
      "--mount", `type=bind,source=${hostWorkspace},target=${this.workerWorkspace}`, "-w", this.workerWorkspace,
      "--entrypoint", "node", imageId, "-e", "setInterval(() => {}, 1000)"]);
    if (result.code) throw new Error("Could not start isolated sandbox");
    this.started = true;
    return imageId;
  }
  async stop() {
    if (!this.started) return;
    const result = await docker(["rm", "-f", this.name]);
    if (result.code) throw new Error("Sandbox cleanup failed; inspect before another run");
    this.started = false;
  }
  async file(op: string, path: string, content?: string) {
    if (!this.started) throw new Error("Sandbox is stopped");
    // Pi resolves relative tool paths against the session's controller cwd.
    // Translate that same workspace into the worker's mount namespace.
    const workerPath = path === this.workspace || path.startsWith(this.workspace + "/")
      ? join(this.workerWorkspace, relative(this.workspace, path)) : path;
    const result = await docker(["exec", "-i", this.name, "node", "-e", fileScript], JSON.stringify({ op, path: workerPath, content, workspace: this.workerWorkspace }));
    if (result.code) throw new Error(`Sandbox file operation failed: ${result.text}`);
    return result.text;
  }
  tools(allowed: string[]) {
    const access = async (path: string) => { await this.file("access", path); };
    const readFile = async (path: string) => Buffer.from(await this.file("read", path), "base64");
    const writeFile = async (path: string, content: string) => { await this.file("write", path, content); };
    const mkdir = async (path: string) => { await this.file("mkdir", path); };
    return [
      createReadToolDefinition(this.workerWorkspace, { operations: { access, readFile, detectImageMimeType: async () => null } }),
      createWriteToolDefinition(this.workerWorkspace, { operations: { writeFile, mkdir } }),
      createEditToolDefinition(this.workerWorkspace, { operations: { access, readFile, writeFile } }),
      createBashToolDefinition(this.workerWorkspace, { exposeSessionEnvironment: false, operations: {
        exec: async (command, _cwd, options) => {
          if (options.signal?.aborted || !this.started) throw new Error("Sandbox stopped");
          const seconds = Math.max(1, Math.min(options.timeout ?? 20, 30));
          const result = await docker(["exec", this.name, "timeout", "-k", "1s", `${seconds}s`, "bash", "-c", command], "", (seconds + 5) * 1000);
          options.onData(Buffer.from(result.text));
          return { exitCode: result.code };
        },
      } }),
    ].filter((tool) => allowed.includes(tool.name));
  }
}

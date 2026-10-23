import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

export interface PreviewDirectories {
  config: string;
  storage: string;
}

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a fixture object.");
  }
  return value as RecordValue;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Expected non-empty fixture text.");
  }
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a fixture list.");
  return value;
}
function status(value: unknown): string {
  const result = text(value);
  if (!["queued", "running", "awaiting-review", "completed", "failed", "cancelled"].includes(result)) {
    throw new Error("Unsupported fixture status.");
  }
  return result;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error("Duplicate fixture ID.");
}

async function readFixture(directory: string, filename: string) {
  const root = resolve(directory);
  // Test mode cannot be redirected to prod or through a directory/file symlink.
  if (basename(root) !== "test" || await realpath(root) !== root) {
    throw new Error("Preview requires a real test directory.");
  }
  const file = join(root, filename);
  if (dirname(await realpath(file)) !== root) {
    throw new Error("Fixture must remain inside its test directory.");
  }
  const data = object(JSON.parse(await readFile(file, "utf8")));
  if (data.fixtureVersion !== 1 || data.environment !== "test") {
    throw new Error("Expected version 1 test fixtures.");
  }
  return data;
}

/** Read-only design fixtures, NOT production configuration or checkpoints.
 * Returns only explicitly selected presentation fields, never raw repository data.
 */
export async function loadPreview(directories: PreviewDirectories) {
  const config = await readFixture(directories.config, "config.json");
  const storage = await readFixture(directories.storage, "workshop.json");
  const agents = list(config.agents).map((value) => {
    const agent = object(value);
    return { id: text(agent.id), name: text(agent.name), role: text(agent.role) };
  });
  unique(agents.map((agent) => agent.id));
  const runs = list(storage.runs).map((value) => {
    const run = object(value);
    const tasks = list(run.tasks).map((value) => {
      const task = object(value);
      const agentId = text(task.agentId);
      if (!agents.some((agent) => agent.id === agentId)) {
        throw new Error("Task references an unknown fixture agent.");
      }
      return {
        id: text(task.id), agentId, title: text(task.title), status: status(task.status),
      };
    });
    unique(tasks.map((task) => task.id));
    return {
      id: text(run.id), title: text(run.title), summary: text(run.summary),
      status: status(run.status), tasks,
    };
  });
  unique(runs.map((run) => run.id));
  return { mode: "test", workshopName: text(config.workshopName), agents, runs };
}

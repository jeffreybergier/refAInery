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
function id(value: unknown): string {
  const result = text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(result)) {
    throw new Error("Invalid fixture ID.");
  }
  return result;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected a fixture list.");
  return value;
}
function choice(value: unknown, choices: string[]): string {
  const result = text(value);
  if (!choices.includes(result)) throw new Error("Unsupported fixture value.");
  return result;
}
function status(value: unknown): string {
  return choice(value, ["queued", "running", "awaiting-review", "completed", "failed", "cancelled"]);
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("Expected a non-negative integer.");
  }
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result) ||
      !Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString() !== result.replace("Z", ".000Z")) {
    throw new Error("Expected a valid UTC timestamp.");
  }
  return result;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error("Duplicate fixture ID.");
}

async function testRoot(directory: string) {
  const root = resolve(directory);
  if (basename(root) !== "test" || await realpath(root) !== root) {
    throw new Error("Preview requires a real test directory.");
  }
  return root;
}
async function readFixture(directory: string, filename: string, version: number) {
  const root = await testRoot(directory);
  const file = join(root, filename);
  if (dirname(await realpath(file)) !== root) {
    throw new Error("Fixture must remain inside its test directory.");
  }
  const data = object(JSON.parse(await readFile(file, "utf8")));
  if (data.fixtureVersion !== version || data.environment !== "test") {
    throw new Error("Unsupported test fixture version or environment.");
  }
  return data;
}
async function transcriptPath(directory: string, transcriptId: string) {
  const root = await testRoot(directory);
  const path = join(root, "transcripts", `${id(transcriptId)}.html`);
  // Reject both file and ancestor symlinks, including a redirected transcripts dir.
  if (await realpath(path) !== path) throw new Error("Transcript path escape.");
  return path;
}

/** Read-only presentation fixtures, NOT production schemas or checkpoints.
 * Only explicitly selected fields are sent to the browser.
 */
export async function loadPreview(directories: PreviewDirectories) {
  const config = await readFixture(directories.config, "config.json", 1);
  const storage = await readFixture(directories.storage, "workshop.json", 2);
  const agents = list(config.agents).map((value) => {
    const agent = object(value);
    return { id: id(agent.id), name: text(agent.name), role: text(agent.role) };
  });
  unique(agents.map((agent) => agent.id));
  const operations = object(storage.operations);
  const asOf = timestamp(operations.asOf);
  const state = choice(operations.state, ["running", "idle", "stopped"]);
  const tokenUsage = list(operations.tokenUsage).map((value) => {
    const sample = object(value);
    return { at: timestamp(sample.at), input: count(sample.input), output: count(sample.output) };
  });
  for (let index = 0; index < tokenUsage.length; index++) {
    if (tokenUsage[index].at > asOf ||
        (index > 0 && tokenUsage[index].at <= tokenUsage[index - 1].at)) {
      throw new Error("Token samples must be ordered, unique, and not in the future.");
    }
  }

  const runs = list(storage.runs).map((value) => {
    const run = object(value);
    const tasks = list(run.tasks).map((value) => {
      const task = object(value);
      const agentId = id(task.agentId);
      if (!agents.some((agent) => agent.id === agentId)) {
        throw new Error("Task references an unknown fixture agent.");
      }
      const taskStatus = status(task.status);
      const startedAt = task.startedAt === null ? null : timestamp(task.startedAt);
      const endedAt = task.endedAt === null ? null : timestamp(task.endedAt);
      if ((endedAt && (!startedAt || endedAt < startedAt || endedAt > asOf)) ||
          (startedAt && startedAt > asOf) ||
          (taskStatus === "queued" && (startedAt || endedAt)) ||
          (taskStatus === "running" && (!startedAt || endedAt)) ||
          (["completed", "failed", "awaiting-review"].includes(taskStatus) && (!startedAt || !endedAt)) ||
          (taskStatus === "cancelled" && startedAt && !endedAt)) {
        throw new Error("Execution timestamps do not match the status.");
      }
      const transcriptId = task.transcriptId === null ? null : id(task.transcriptId);
      if (transcriptId && !endedAt) throw new Error("Only finished executions can have transcripts.");
      return {
        id: id(task.id), agentId, title: text(task.title), status: taskStatus,
        kind: choice(task.kind, ["orchestrator", "subagent"]),
        stage: count(task.stage), startedAt, endedAt, transcriptId,
        transcriptUrl: transcriptId ? `/preview/transcripts/${transcriptId}.html` : null,
      };
    });
    unique(tasks.map((task) => task.id));
    return {
      id: id(run.id), title: text(run.title), summary: text(run.summary),
      status: status(run.status), tasks,
    };
  });
  unique(runs.map((run) => run.id));
  const tasks = runs.flatMap((run) => run.tasks);
  for (const transcriptId of new Set(tasks.map((task) => task.transcriptId))) {
    if (transcriptId) await transcriptPath(directories.storage, transcriptId);
  }
  const active = tasks.filter((task) => task.status === "running").length;
  if ((state === "running") !== (active > 0)) {
    throw new Error("Factory state must match the simulated active executions.");
  }
  const subagents = tasks.filter((task) => task.kind === "subagent");
  const succeeded = subagents.filter((task) => task.status === "completed").length;
  const failed = subagents.filter((task) => task.status === "failed").length;
  return {
    mode: "test", workshopName: text(config.workshopName), agents, runs,
    operations: {
      state, asOf, tokenUsage,
      counts: {
        active, queued: tasks.filter((task) => task.status === "queued").length,
        completed: tasks.filter((task) => task.status === "completed").length,
        failed: tasks.filter((task) => task.status === "failed").length,
      },
      outcomes: { succeeded, failed, other: subagents.length - succeeded - failed },
    },
  };
}

/** Only serve files explicitly referenced by validated test executions. */
export async function readPreviewTranscript(directories: PreviewDirectories, transcriptId: string) {
  const preview = await loadPreview(directories);
  if (!preview.runs.some((run) => run.tasks.some((task) => task.transcriptId === transcriptId))) {
    return null;
  }
  return readFile(await transcriptPath(directories.storage, transcriptId));
}

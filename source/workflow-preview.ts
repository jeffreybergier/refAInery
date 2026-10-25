import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadIntakePreview } from "./intake-preview.ts";

// Provisional presentation records for SPEC.md's agreed workflow, NOT new
// production schemas. Explicit execution times are fixture observations;
// checkpoint-save times must never be substituted for execution times.
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object.");
  return value as Record<string, unknown>;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Expected array.");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected text.");
  return value;
}
function id(value: unknown): string {
  const result = text(value);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(result)) throw new Error("Invalid identity.");
  return result;
}
function choice(value: unknown, allowed: string[]): string {
  const result = text(value);
  if (!allowed.includes(result)) throw new Error("Invalid choice.");
  return result;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error("Invalid sequence.");
  return value as number;
}
function time(value: unknown): string {
  const result = text(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result) ||
      !Number.isFinite(Date.parse(result)) ||
      new Date(result).toISOString() !== result.replace("Z", ".000Z")) throw new Error("Invalid time.");
  return result;
}
function unique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error("Duplicate identity.");
}
function path(value: unknown, kind: string): string {
  const result = text(value);
  const extension = kind === "exports" ? "html" : kind === "sessions" ? "jsonl" : "md";
  if (!new RegExp(`^${kind}/[a-zA-Z0-9_-]+\\.${extension}$`).test(result)) throw new Error("Invalid document path.");
  return result;
}
function exported(value: unknown) {
  const data = object(value);
  const state = choice(data.state, ["not-due", "pending", "saved", "failed"]);
  const location = data.path === null ? null : path(data.path, "exports");
  const error = data.error === null ? null : text(data.error);
  if ((state === "saved") !== (location !== null) ||
      (state === "failed") !== (error !== null)) throw new Error("Invalid export state.");
  return { state, path: location, error };
}
function execution(value: unknown, savedAt: string, runStart: string) {
  const data = object(value);
  const status = choice(data.status, ["running", "completed", "failed", "interrupted", "cancelled"]);
  const startedAt = time(data.startedAt);
  const endedAt = data.endedAt === null ? null : time(data.endedAt);
  if (startedAt < runStart || startedAt > savedAt ||
      (status === "running") !== (endedAt === null) ||
      (endedAt && (endedAt < startedAt || endedAt > savedAt))) throw new Error("Invalid execution lifetime.");
  return { id: id(data.id), status, startedAt, endedAt };
}
function checkpoint(value: unknown, asOf: string) {
  const data = object(value);
  const savedAt = time(data.savedAt);
  const startedAt = time(data.startedAt);
  const endedAt = data.endedAt === null ? null : time(data.endedAt);
  const status = choice(data.status, ["running", "completed", "failed", "cancelled"]);
  const phase = choice(data.phase, ["planning", "dispatching", "executing", "exporting", "awaiting-review", "reviewing", "ended"]);
  if (savedAt > asOf || startedAt > savedAt ||
      (status === "running") !== (endedAt === null) ||
      (phase === "ended") !== (status !== "running") ||
      (endedAt && (endedAt < startedAt || endedAt > savedAt))) throw new Error("Invalid run lifetime.");
  const config = object(data.configuration);
  const models = list(config.models).map((value) => {
    const model = object(value);
    if (model.contextWindow !== 250000) throw new Error("V1 context capacity must be frozen at 250000.");
    return { id: id(model.id), provider: text(model.provider), modelId: text(model.modelId), contextWindow: 250000 };
  });
  unique(models.map((model) => model.id));
  const modelId = (value: unknown) => {
    const result = id(value);
    if (!models.some((model) => model.id === result)) throw new Error("Model outside frozen allowlist.");
    return result;
  };
  const configuration = { id: id(config.id), models, orchestratorModel: modelId(config.orchestratorModel) };
  const orchestratorData = object(data.orchestrator);
  const orchestrator = {
    sessionId: id(orchestratorData.sessionId), sessionPath: path(orchestratorData.sessionPath, "sessions"),
    export: exported(orchestratorData.export),
    turns: list(orchestratorData.turns).map((value) => ({
      ...execution(value, savedAt, startedAt), title: text(object(value).title),
    })),
  };
  if ((status === "running" && orchestrator.export.state !== "not-due") ||
      (status !== "running" && orchestrator.export.state === "not-due")) throw new Error("Orchestrator exports only at run end.");
  unique(orchestrator.turns.map((turn) => turn.id));
  const tasks = list(data.tasks).map((value) => {
    const task = object(value);
    const attempts = list(task.attempts).map((value) => {
      const attempt = object(value);
      const timing = execution(attempt, savedAt, startedAt);
      const handover = attempt.handover === null ? null : path(attempt.handover, "handovers");
      const report = exported(attempt.export);
      const stopReason = attempt.stopReason === null ? null : text(attempt.stopReason);
      const review = choice(attempt.review, ["not-submitted", "pending", "accepted", "rejected"]);
      const reviewedAt = attempt.reviewedAt === null ? null : time(attempt.reviewedAt);
      if ((["accepted", "rejected"].includes(review)) !== (reviewedAt !== null) ||
          (reviewedAt && (!timing.endedAt || reviewedAt < timing.endedAt || reviewedAt > savedAt)) ||
          (review !== "not-submitted" && (!handover || report.state !== "saved")) ||
          (timing.status === "completed" && (!handover || !["completed", "context-limit"].includes(stopReason ?? "") || report.state === "not-due")) ||
          (timing.status !== "completed" && (handover || report.state !== "not-due" || review !== "not-submitted")) ||
          (timing.status === "running" && stopReason !== null)) throw new Error("Invalid handback or review.");
      return { ...timing, number: number(attempt.number), model: modelId(attempt.model),
        sessionId: id(attempt.sessionId), sessionPath: path(attempt.sessionPath, "sessions"),
        stopReason, handover, export: report, review, reviewedAt,
        retryReason: attempt.retryReason === null ? null : text(attempt.retryReason) };
    });
    unique(attempts.map((attempt) => String(attempt.number)));
    for (let index = 1; index < attempts.length; index++) {
      if (attempts[index].number <= attempts[index - 1].number ||
          !attempts[index].retryReason) throw new Error("Attempt continuation must be ordered and explicit.");
    }
    return { id: id(task.id), title: text(task.title), model: modelId(task.model), attempts };
  });
  unique(tasks.map((task) => task.id));
  const attempts = tasks.flatMap((task) => task.attempts);
  unique(attempts.map((attempt) => attempt.id));
  unique([orchestrator.sessionId, ...attempts.map((attempt) => attempt.sessionId)]);
  const executions = [...orchestrator.turns, ...attempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (let index = 0; index < executions.length; index++) {
    const current = executions[index];
    const previous = executions[index - 1];
    if ((previous && (!previous.endedAt || previous.endedAt > current.startedAt)) ||
        (endedAt && (!current.endedAt || current.endedAt > endedAt))) throw new Error("V1 work must be sequential and stopped before run end.");
  }
  for (const attempt of attempts) {
    // A normal handback returns control to the orchestrator; subsequent
    // subagents cannot bypass review or start while export/review is pending.
    if (attempt.status === "completed" && attempts.some((next) =>
      next.startedAt > attempt.startedAt &&
      (!attempt.reviewedAt || next.startedAt < attempt.reviewedAt))) {
      throw new Error("Subagent dispatch before handback review.");
    }
  }
  if (phase === "awaiting-review" &&
      (!attempts.some((attempt) => attempt.review === "pending") || executions.some((item) => !item.endedAt))) {
    throw new Error("Review waiting is not execution.");
  }
  const decisions = list(data.decisions).map((value) => {
    const decision = object(value);
    const attemptId = id(decision.attemptId);
    const at = time(decision.at);
    const review = choice(decision.review, ["accepted", "rejected"]);
    const attempt = attempts.find((attempt) => attempt.id === attemptId);
    if (!attempt || attempt.review !== review || attempt.reviewedAt !== at) throw new Error("Decision must match reviewed attempt.");
    return { attemptId, at, review, summary: text(decision.summary) };
  });
  unique(decisions.map((decision) => decision.attemptId));
  if (attempts.some((attempt) => attempt.reviewedAt && !decisions.some((decision) => decision.attemptId === attempt.id))) throw new Error("Missing applied review decision.");
  return { number: number(data.number), savedAt, status, phase, startedAt, endedAt,
    configuration, plan: path(data.plan, "plans"), orchestrator, tasks, decisions };
}

type Requests = Awaited<ReturnType<typeof loadIntakePreview>>["requests"];
export function validateWorkflowFixtures(value: unknown, requests: Requests) {
  const data = object(value);
  if (data.fixtureVersion !== 1 || data.environment !== "test") throw new Error("Not a v1 workflow fixture.");
  const asOf = time(data.asOf);
  const requestById = new Map(requests.map((request) => [request.id, request]));
  if (requests.some((request) => Date.parse(request.receivedAt) > Date.parse(asOf))) throw new Error("Future intake.");
  const runs = list(data.runs).map((value) => {
    const run = object(value);
    const requestId = id(run.requestId);
    const request = requestById.get(requestId);
    if (!request) throw new Error("Unknown request.");
    const checkpoints = list(run.checkpoints).map((value) => checkpoint(value, asOf));
    if (!checkpoints.length) throw new Error("Missing checkpoint.");
    const initial = checkpoints[0];
    if (Date.parse(initial.startedAt) < Date.parse(request.receivedAt)) throw new Error("Run before receipt.");
    for (let index = 1; index < checkpoints.length; index++) {
      const current = checkpoints[index], previous = checkpoints[index - 1];
      if (current.number <= previous.number || current.savedAt <= previous.savedAt ||
          current.startedAt !== initial.startedAt ||
          JSON.stringify(current.configuration) !== JSON.stringify(initial.configuration) ||
          current.orchestrator.sessionId !== initial.orchestrator.sessionId ||
          current.orchestrator.sessionPath !== initial.orchestrator.sessionPath ||
          (previous.endedAt && (current.endedAt !== previous.endedAt || current.status !== previous.status))) throw new Error("Invalid checkpoint progression or frozen configuration.");
      const oldExecutions = [...previous.orchestrator.turns, ...previous.tasks.flatMap((task) => task.attempts)];
      const newExecutions = [...current.orchestrator.turns, ...current.tasks.flatMap((task) => task.attempts)];
      for (const old of oldExecutions) {
        if (!newExecutions.some((item) => item.id === old.id && item.startedAt === old.startedAt &&
            (!old.endedAt || (item.endedAt === old.endedAt && item.status === old.status)))) throw new Error("Checkpoint lost execution history.");
      }
      for (const decision of previous.decisions) {
        if (!current.decisions.some((item) => JSON.stringify(item) === JSON.stringify(decision))) throw new Error("Checkpoint lost applied decision.");
      }
      for (const task of previous.tasks) for (const old of task.attempts) {
        const next = current.tasks.find((item) => item.id === task.id)?.attempts.find((item) => item.id === old.id);
        if (!next || next.number !== old.number || next.model !== old.model ||
            next.sessionId !== old.sessionId || next.sessionPath !== old.sessionPath ||
            (old.handover && next.handover !== old.handover) ||
            (old.export.state === "saved" && next.export.path !== old.export.path)) throw new Error("Checkpoint changed attempt identity or saved files.");
      }
      if (previous.orchestrator.export.state === "saved" &&
          current.orchestrator.export.path !== previous.orchestrator.export.path) throw new Error("Checkpoint lost final export.");
    }
    return { id: id(run.id), requestId, title: text(run.title), checkpoints };
  });
  unique(runs.map((run) => run.id));
  unique(runs.map((run) => run.requestId));
  const latest = runs.map((run) => ({ run, checkpoint: run.checkpoints.at(-1)! }))
    .sort((a, b) => a.checkpoint.startedAt.localeCompare(b.checkpoint.startedAt));
  for (let index = 1; index < latest.length; index++) {
    const previous = latest[index - 1], current = latest[index];
    if (!previous.checkpoint.endedAt || previous.checkpoint.endedAt > current.checkpoint.startedAt ||
        Date.parse(requestById.get(previous.run.requestId)!.receivedAt) > Date.parse(requestById.get(current.run.requestId)!.receivedAt)) throw new Error("Only one FIFO run may be active.");
  }
  const queue = list(data.queue).map(id);
  unique(queue);
  for (let index = 0; index < queue.length; index++) {
    const request = requestById.get(queue[index]);
    if (!request || runs.some((run) => run.requestId === request.id) ||
        (index && Date.parse(requestById.get(queue[index - 1])!.receivedAt) > Date.parse(request.receivedAt)) ||
        latest.some(({ run }) => Date.parse(requestById.get(run.requestId)!.receivedAt) > Date.parse(request.receivedAt))) throw new Error("Invalid FIFO request queue.");
  }
  return { asOf, queue, runs };
}

type Workflow = ReturnType<typeof validateWorkflowFixtures>;
function references(workflow: Workflow) {
  const result = new Map<string, { runId: string; path: string; kind: string }>();
  for (const run of workflow.runs) for (const checkpoint of run.checkpoints) {
    const add = (path: string | null, kind: string) => {
      if (path) result.set(`${run.id}/${path}`, { runId: run.id, path, kind });
    };
    add(checkpoint.plan, "markdown");
    add(checkpoint.orchestrator.sessionPath, "session");
    add(checkpoint.orchestrator.export.path, "html");
    for (const task of checkpoint.tasks) for (const attempt of task.attempts) {
      add(attempt.handover, "markdown");
      add(attempt.export.path, "html");
      add(attempt.sessionPath, "session");
    }
  }
  return result;
}

const root = new URL("../storage/legacy/v1/", import.meta.url);
async function checkedRead(url: URL) {
  const filename = fileURLToPath(url);
  if (await realpath(filename) !== filename) throw new Error("Fixture symlink rejected.");
  return readFile(filename, "utf8");
}
export async function loadWorkflowPreview(directory = root) {
  const intake = await loadIntakePreview();
  const data: unknown = JSON.parse(await checkedRead(new URL("workflow-v1.json", directory)));
  const workflow = validateWorkflowFixtures(data, intake.requests);
  const documents = [];
  // Validate ALL referenced files, not just those in the latest snapshot. Never
  // silently fall back to an older checkpoint when a referenced file is missing.
  for (const [key, reference] of references(workflow)) {
    const content = await checkedRead(new URL(`workflow-v1/${key}`, directory));
    if (reference.kind !== "session") documents.push({ ...reference,
      url: `/preview/v1/documents/${key}`,
      text: reference.kind === "markdown" ? content : null });
  }
  return { ...intake, ...workflow, documents };
}

export async function readWorkflowDocument(key: string) {
  const preview = await loadWorkflowPreview();
  const document = preview.documents.find((document) => `${document.runId}/${document.path}` === key);
  if (!document) return null;
  return { kind: document.kind, content: await checkedRead(new URL(`workflow-v1/${key}`, root)) };
}

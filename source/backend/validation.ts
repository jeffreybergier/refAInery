import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import type { Checkpoint, RequestRecord } from "./workflow.ts";

const ajv = new Ajv2020({ strict: true });
const addFormats = addFormatsModule as unknown as (instance: Ajv2020) => void;
addFormats(ajv);
const schema = (name: string) => JSON.parse(readFileSync(new URL(`../../schemas/storage/v1/${name}.schema.json`, import.meta.url), "utf8"));
const request = ajv.compile<RequestRecord>(schema("request"));
const checkpoint = ajv.compile<Checkpoint>(schema("checkpoint"));
export function validateRequest(value: unknown): asserts value is RequestRecord {
  if (!request(value)) throw new Error("Invalid production request");
}
export function validateCheckpoint(value: unknown, previous?: Checkpoint): asserts value is Checkpoint {
  if (!checkpoint(value)) throw new Error("Invalid production checkpoint");
  const state = value;
  const allowed = state.configuration.subagentIds;
  if (state.configuration.toolCatalogVersion === "refainery-tools-v4" && !allowed) {
    throw new Error("Missing frozen subagent allowlist");
  }
  if (allowed) {
    const personalities = state.configuration.personalities;
    const subagents = personalities.filter(p => p.role === "subagent");
    if (new Set(personalities.map(p => p.id)).size !== personalities.length ||
        personalities.filter(p => p.role === "orchestrator").length !== 1 ||
        subagents.length !== allowed.length || allowed.includes("orchestrator") ||
        allowed.some(id => !subagents.some(p => p.id === id))) {
      throw new Error("Invalid frozen subagent allowlist");
    }
  }
  for (const task of state.tasks) {
    if (allowed ? !task.personality || !allowed.includes(task.personality)
      : task.personality !== undefined && task.personality !== "worker") {
      throw new Error("Task outside frozen subagent allowlist");
    }
    for (const attempt of task.attempts) {
      if (attempt.personality !== (task.personality ?? "worker")) {
        throw new Error("Attempt personality differs from task selection");
      }
    }
  }
  const before = (a: string, b: string) => Date.parse(a) <= Date.parse(b);
  if (!before(state.startedAt, state.savedAt) ||
      (state.endedAt && !before(state.endedAt, state.savedAt)) ||
      ((state.phase === "ended") !== ["completed", "failed"].includes(state.status)) ||
      (state.phase === "ended" && (!state.endedAt || state.orchestrator.export.state !== "saved")) ||
      ((state.phase === "waiting-for-user") !== (state.status === "waiting-for-user")) ||
      (state.status === "waiting-for-user" && (state.endedAt !== null ||
        state.orchestrator.export.state !== "saved" || !state.resultSummary?.trim() ||
        state.pendingAction !== null || state.failure !== null ||
        state.orchestrator.turns.some((turn) => !turn.endedAt) ||
        state.tasks.some((task) => task.attempts.some((attempt) => !attempt.endedAt))))) {
    throw new Error("Invalid run boundary");
  }
  const paths = new Set(state.plans.map((plan) => plan.path));
  if (paths.size !== state.plans.length || (state.plan !== null && !paths.has(state.plan))) throw new Error("Invalid plan history");
  const attempts = state.tasks.flatMap((task) => task.attempts);
  const executions = [...state.orchestrator.turns, ...attempts].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (let index = 0; index < executions.length; index++) {
    const e = executions[index], previousExecution = executions[index - 1];
    if ((e.status === "running") !== (e.endedAt === null) ||
        !before(e.startedAt, state.savedAt) || (e.endedAt && (!before(e.startedAt, e.endedAt) || !before(e.endedAt, state.savedAt))) ||
        (previousExecution && (!previousExecution.endedAt || !before(previousExecution.endedAt, e.startedAt)))) throw new Error("Invalid sequential execution");
  }
  for (const exported of [state.orchestrator.export, ...attempts.map((a) => a.export)]) {
    if ((exported.state === "saved") !== (exported.path !== null) ||
        (exported.state === "failed") !== (exported.error !== null)) throw new Error("Invalid export state");
  }
  for (const a of attempts) {
    if ((a.planRevision !== null && !paths.has(a.planRevision)) ||
        (a.status === "completed" && (!a.handover || !a.stopReason || a.export.state === "not-due")) ||
        (a.review !== "not-submitted" && (!a.handover || !a.endedAt || a.export.state !== "saved")) ||
        (a.review === "decided") !== (a.reviewedAt !== null) ||
        (a.review === "decided" && !state.decisions.some((d) => d.attemptId === a.id)) ||
        a.sessionId === state.orchestrator.sessionId || a.sessionPath === state.orchestrator.sessionPath) {
      throw new Error("Invalid handback state");
    }
  }
  if (previous) {
    if (state.number !== previous.number + 1 || state.requestId !== previous.requestId || state.runId !== previous.runId ||
        state.startedAt !== previous.startedAt || !before(previous.savedAt, state.savedAt) ||
        JSON.stringify(state.configuration) !== JSON.stringify(previous.configuration) ||
        (previous.phase === "ended" && (state.status !== previous.status || state.endedAt !== previous.endedAt))) throw new Error("Invalid checkpoint chain");
    for (const old of previous.tasks) {
      const current = state.tasks.find(task => task.id === old.id);
      if (!current || current.personality !== old.personality) throw new Error("Changed task personality");
    }
    const oldExecutions = [...previous.orchestrator.turns, ...previous.tasks.flatMap((t) => t.attempts)];
    for (const old of oldExecutions) {
      const current = executions.find((e) => e.id === old.id);
      if (!current || current.startedAt !== old.startedAt || (old.endedAt && (current.endedAt !== old.endedAt || current.status !== old.status))) throw new Error("Lost execution history");
    }
    if (previous.plans.some((plan, i) => JSON.stringify(plan) !== JSON.stringify(state.plans[i]))) throw new Error("Lost plan history");
  }
}

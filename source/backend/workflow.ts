import { createHash } from "node:crypto";
import { Store, now, identity, numbered, requireText, readJSON, names, safeRead } from "./storage.ts";
import type { Configuration } from "./config.ts";
import { validateCheckpoint, validateRequest } from "./validation.ts";

export type ExportState = { state: "not-due" | "pending" | "saved" | "failed"; path: string | null; error: string | null };
export const notDue = (): ExportState => ({ state: "not-due", path: null, error: null });
export interface Execution {
  id: string; title: string; status: string; startedAt: string; endedAt: string | null;
}
export interface Attempt extends Execution {
  number: number; model: string; personality: string; sessionId: string; sessionPath: string;
  handover: string | null; export: ExportState; stopReason: string | null;
  review: string; reviewedAt: string | null; retryReason: null; planRevision: string;
}
export interface Checkpoint {
  schemaVersion: 1; runId: string; requestId: string; number: number; savedAt: string;
  status: string; phase: string; startedAt: string; endedAt: string | null;
  configuration: Configuration & { id: string; models: { id: string; provider: string; modelId: string; contextWindow: number }[]; orchestratorModel: string };
  plan: string | null; plans: { path: string; turnId: string; at: string }[];
  orchestrator: { sessionId: string; sessionPath: string; export: ExportState; turns: Execution[] };
  tasks: { id: string; title: string; model: string; assignment: string; attempts: Attempt[] }[];
  decisions: { attemptId: string | null; at: string; action: string; summary: string; plan: string }[];
  receipts: Record<string, { action: string; argsHash: string; result: unknown }>;
  pendingAction: { kind: "assign" | "finish"; outcome?: string; summary?: string } | null;
  failure: string | null;
  resultSummary: string | null;
}
export interface RequestRecord { schemaVersion: 1; id: string; prompt: string; receivedAt: string; source: "manual" }

export class Workflow {
  state: Checkpoint;
  private poisoned = false;
  private committed?: Checkpoint;
  readonly store: Store;
  constructor(store: Store, request: RequestRecord, configuration: Checkpoint["configuration"], runId = identity("run")) {
    this.store = store;
    const at = now();
    this.state = { schemaVersion: 1, runId, requestId: request.id, number: 0, savedAt: at,
      status: "running", phase: "created", startedAt: at, endedAt: null, configuration,
      plan: null, plans: [], orchestrator: { sessionId: "", sessionPath: "", export: notDue(), turns: [] },
      tasks: [], decisions: [], receipts: {}, pendingAction: null, failure: null, resultSummary: null };
  }
  get prefix() { return `runs/${this.state.runId}`; }
  async save() {
    if (this.poisoned) throw new Error("Storage degraded; dispatch forbidden");
    const next = { ...structuredClone(this.state), number: this.state.number + 1, savedAt: now() };
    try {
      validateCheckpoint(next, this.committed);
      await this.store.save(`${this.prefix}/checkpoints/${numbered(next.number)}.json`, next);
    }
    catch (error) { this.poisoned = true; throw error; }
    this.state = next;
    this.committed = structuredClone(next);
  }
  async beginTurn() {
    if (this.state.status !== "running") throw new Error("Run is not active");
    if (this.state.pendingAction) throw new Error("Unconsumed action");
    this.state.phase = "planning";
    this.state.orchestrator.turns.push({ id: identity("turn"), title: this.state.tasks.length ? "Review handover" : "Plan request",
      status: "running", startedAt: now(), endedAt: null });
    await this.save();
  }
  async endTurn() {
    const turn = this.state.orchestrator.turns.at(-1)!;
    turn.endedAt = now(); turn.status = "completed";
    await this.save();
  }
  /** Publish a durable outcome only after the orchestrator has stopped/exported.
   * A question pauses the run; resumption remains an explicit operator action.
   */
  async finishRequest() {
    const decision = this.state.pendingAction;
    if (this.state.status !== "running" || decision?.kind !== "finish" ||
        this.state.orchestrator.turns.at(-1)?.endedAt == null ||
        this.state.orchestrator.export.state !== "saved") {
      throw new Error("Request outcome is not durable");
    }
    const statuses: Record<string, string> = {
      success: "completed", failure: "failed", question: "waiting-for-user",
    };
    const status = statuses[decision.outcome ?? ""];
    if (!status) throw new Error("Invalid outcome");
    this.state.status = status;
    this.state.resultSummary = decision.summary!;
    this.state.phase = status === "waiting-for-user" ? "waiting-for-user" : "ended";
    this.state.endedAt = status === "waiting-for-user" ? null : now();
    this.state.pendingAction = null;
    await this.save();
  }
  async action(role: "orchestrator" | "subagent", sessionId: string, callId: string, name: string, args: Record<string, unknown>) {
    if (this.poisoned) throw new Error("Storage degraded");
    const key = `${sessionId}:${callId}`;
    const argsHash = createHash("sha256").update(JSON.stringify(args)).digest("hex");
    const previous = this.state.receipts[key];
    if (previous) {
      if (previous.action !== name || previous.argsHash !== argsHash) throw new Error("Call identity reused");
      return previous.result;
    }
    if (this.state.status !== "running") throw new Error("Run is not active");
    let result: unknown;
    if (role === "orchestrator") {
      const turn = this.state.orchestrator.turns.at(-1);
      if (sessionId !== this.state.orchestrator.sessionId || this.state.phase !== "planning" ||
          !turn || turn.endedAt || this.state.pendingAction) throw new Error("Not an active planning turn");
      if (name === "update_plan") {
        const markdown = requireText(args.markdown);
        const path = `plans/${numbered(this.state.plans.length + 1)}.md`;
        await this.store.document(`${this.prefix}/${path}`, markdown);
        this.state.plan = path;
        this.state.plans.push({ path, turnId: turn.id, at: now() });
        result = { saved: true, planRevision: path };
      } else if (name === "spawn_subagent" || name === "finish_request") {
        if (this.state.plans.at(-1)?.turnId !== turn.id) throw new Error("Call update_plan in this turn first");
        const summary = requireText(args.rationale);
        const last = this.state.tasks.at(-1)?.attempts.at(-1);
        if (last && (last.export.state !== "saved" || !last.endedAt)) throw new Error("Handback is not durable");
        if (name === "spawn_subagent") {
          if (args.personality !== "worker" || args.model !== "default") throw new Error("Selection outside frozen allowlist");
          // This milestone intentionally permits one worker only, not an unattended factory.
          if (this.state.tasks.length >= 1) throw new Error("Milestone assignment budget exhausted; finish with an honest outcome");
          const title = requireText(args.title, 512), assignment = requireText(args.assignment);
          this.state.tasks.push({ id: identity("task"), title, model: "default", assignment, attempts: [] });
          this.state.pendingAction = { kind: "assign" };
        } else {
          if (!["success", "failure", "question"].includes(String(args.outcome))) throw new Error("Invalid outcome");
          if (!last && args.outcome === "success") throw new Error("Milestone requires a worker handover before success");
          this.state.pendingAction = { kind: "finish", outcome: String(args.outcome), summary: requireText(args.summary) };
        }
        if (last) { last.review = "decided"; last.reviewedAt = now(); }
        this.state.decisions.push({ attemptId: last?.id ?? null, at: now(), action: name, summary, plan: this.state.plan! });
        result = { saved: true, action: name, planRevision: this.state.plan, yield: true };
      } else throw new Error("Tool not authorized for orchestrator");
    } else {
      const attempt = this.state.tasks.at(-1)?.attempts.at(-1);
      if (name !== "finish_task" || !attempt || attempt.sessionId !== sessionId ||
          this.state.phase !== "executing" || attempt.handover) throw new Error("Tool not authorized for this attempt");
      const markdown = requireText(args.markdown);
      for (const section of ["## Goal", "## Constraints & Preferences", "## Progress", "### Done", "### In Progress", "### Blocked", "## Key Decisions", "## Next Steps", "## Critical Context", "<read-files>", "</read-files>", "<modified-files>", "</modified-files>"]) {
        if (!markdown.includes(section)) throw new Error("Missing required handover section");
      }
      if (!["success", "failure", "context-limit"].includes(String(args.stopReason))) throw new Error("Invalid stop reason");
      const path = `handovers/${attempt.id}.md`;
      await this.store.document(`${this.prefix}/${path}`, markdown);
      attempt.handover = path; attempt.stopReason = String(args.stopReason);
      this.state.phase = "stopping-worker";
      result = { saved: true, handover: path, yield: true };
    }
    this.state.receipts[key] = { action: name, argsHash, result };
    await this.save();
    return result;
  }
}

export async function enqueue(store: Store, prompt: string): Promise<RequestRecord> {
  const request: RequestRecord = { schemaVersion: 1, id: identity("request"), prompt: requireText(prompt), receivedAt: now(), source: "manual" };
  validateRequest(request);
  await store.save(`requests/${request.id}.json`, request);
  return request;
}
/** Immutable intake plus committed run references define FIFO membership. No replay. */
export async function queuedRequests(store: Store): Promise<RequestRecord[]> {
  const data = await loadProduction(store);
  for (const run of data.runs) {
    const state = run.checkpoints.at(-1)!;
    if (!["completed", "failed"].includes(state.status) || state.phase !== "ended") throw new Error("Unfinished run requires explicit recovery");
  }
  const used = new Set(data.runs.map((run) => run.requestId));
  return data.requests.filter((r) => !used.has(r.id)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id));
}

export async function loadProduction(store: Store) {
  const requests = await Promise.all((await names(store.path("requests"))).filter((p) => p.endsWith(".json"))
    .map((p) => readJSON<RequestRecord>(store.path("requests", p))));
  for (const request of requests) validateRequest(request);
  if (new Set(requests.map((r) => r.id)).size !== requests.length) throw new Error("Duplicate requests");
  const runs = [], documents = [], inferences = [];
  for (const id of await names(store.path("runs"))) {
    if (!/^run-[a-zA-Z0-9-]+$/.test(id)) throw new Error("Invalid run directory");
    const files = (await names(store.path("runs", id, "checkpoints"))).filter((p) => /^\d{6}\.json$/.test(p));
    if (!files.length) throw new Error("Missing committed checkpoint");
    const checkpoints: Checkpoint[] = [];
    for (let index = 0; index < files.length; index++) {
      const state = JSON.parse(await safeRead(store.root, `runs/${id}/checkpoints/${files[index]}`)) as Checkpoint;
      if (state.schemaVersion !== 1 || state.runId !== id || state.number !== index + 1 ||
          !requests.some((r) => r.id === state.requestId)) throw new Error("Invalid checkpoint chain");
      validateCheckpoint(state, checkpoints.at(-1));
      checkpoints.push(state);
    }
    const state = checkpoints.at(-1)!;
    const sessions = [
      ...(state.orchestrator.turns.some((turn) => turn.endedAt) ? [state.orchestrator.sessionPath] : []),
      ...state.tasks.flatMap((task) => task.attempts.filter((attempt) => attempt.endedAt).map((attempt) => attempt.sessionPath)),
    ];
    for (const session of sessions) {
      if (!/^sessions\/[a-zA-Z0-9_.-]+\.jsonl$/.test(session)) throw new Error("Invalid session reference");
      await safeRead(store.root, `runs/${id}/${session}`); // existence/isolation only; Pi owns the format
    }
    const paths = new Set(checkpoints.flatMap((c) => [c.plan, c.orchestrator.export.path,
      ...c.tasks.flatMap((t) => t.attempts.flatMap((a) => [a.handover, a.export.path]))]).filter((p): p is string => !!p));
    for (const path of paths) {
      if (!/^(plans|handovers|exports)\/[a-zA-Z0-9_-]+\.(md|html)$/.test(path)) throw new Error("Invalid document reference");
      const content = await safeRead(store.root, `runs/${id}/${path}`);
      documents.push({ runId: id, path, kind: path.endsWith(".md") ? "markdown" : "html",
        text: path.endsWith(".md") ? content : null, url: `/production/v1/documents/${id}/${path}` });
    }
    for (const call of await names(store.path("runs", id, "inferences"))) {
      const revisions = (await names(store.path("runs", id, "inferences", call))).filter((p) => /^\d{6}\.json$/.test(p));
      if (!revisions.length) throw new Error("Invalid inference record");
      inferences.push(JSON.parse(await safeRead(store.root, `runs/${id}/inferences/${call}/${revisions.at(-1)}`)));
    }
    runs.push({ id, requestId: state.requestId, title: `Request ${state.requestId}`, checkpoints });
  }
  inferences.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const used = new Set(runs.map((run) => run.requestId));
  if (used.size !== runs.length) throw new Error("Duplicate run linkage");
  let registry: unknown = null;
  if ((await names(store.path("registry"))).includes("status.json")) {
    registry = await readJSON(store.path("registry/status.json"));
  }
  return { mode: "production", schemaVersion: 1, asOf: now(), requests, runs, documents, inferences, registry,
    queue: requests.filter((r) => !used.has(r.id)).sort((a, b) => a.receivedAt.localeCompare(b.receivedAt) || a.id.localeCompare(b.id)).map((r) => r.id) };
}

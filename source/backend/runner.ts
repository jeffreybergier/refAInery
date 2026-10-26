import { Store, identity, localIdentity, now, safeRead, readJSON } from "./storage.ts";
import { loadConfiguration } from "./config.ts";
import { Registry } from "./registry.ts";
import { Workflow, enqueue, queuedRequests, notDue, type Checkpoint } from "./workflow.ts";
import { PiAdapter, exportSession } from "./pi.ts";
import { Sandbox, createWorkspace } from "./sandbox.ts";
import { ScriptedResponses, type Scenario } from "./scenario.ts";
import { firstPrompt as orchestratorFirstPrompt, subagentReview } from "../agents/orchestrator.ts";
import { firstPrompt as subagentFirstPrompt } from "../agents/subagent.ts";
import { workspaceInstructions } from "../agents/shared.ts";

export interface RunOptions {
  storage: string; config: string; prompt: string; selectedModel: string;
  registryURL: string; apiKey: string; signal?: AbortSignal;
  scenario?: Scenario;
  onProgress?: (stage: string) => void;
}

/** Single-request scheduler with sequential workers. Never replays uncertain work. */
export async function runOnce(options: RunOptions) {
  const store = new Store(options.storage);
  const scripted = options.scenario ? new ScriptedResponses(options.scenario) : undefined;
  const registry = scripted
    ? new Registry(store, options.registryURL,
      async () => Response.json(await readJSON(options.registryURL)), "faux")
    : new Registry(store, options.registryURL);
  await store.acquire();
  let sandbox: Sandbox | undefined;
  let engine: Workflow | undefined;
  let orchestrator: Awaited<ReturnType<PiAdapter["create"]>> | undefined;
  let worker: Awaited<ReturnType<PiAdapter["create"]>> | undefined;
  const abort = () => { orchestrator?.session.agent.abort(); worker?.session.agent.abort(); };
  options.signal?.addEventListener("abort", abort);
  const stage = (name: string) => {
    if (options.signal?.aborted) throw new Error("Cancelled");
    options.onProgress?.(name);
  };
  try {
    stage("preflight");
    // Block before accepting more intake when prior execution needs recovery.
    const queued = await queuedRequests(store);
    if (queued.length) throw new Error("Queued intake requires explicit operator selection; no automatic dispatch");
    const config = await loadConfiguration(options.config);
    await registry.start();
    if (!registry.current || registry.reference().registryFreshness !== "fresh") throw new Error("Fresh registry required for milestone");
    const selected = registry.current.models.find((m) => m.id === options.selectedModel);
    if (!selected || selected.context_length < 250000) throw new Error("Selected model capacity unavailable");
    const request = await enqueue(store, options.prompt);
    const workspace = store.path("workspaces", request.id);
    await createWorkspace(workspace);
    for (const personality of config.personalities) {
      personality.instructions += `\n\n${workspaceInstructions(`/workspace/${request.id}`)}`;
    }
    engine = new Workflow(store, request, { ...config, id: identity("config"),
      models: [{ id: "default", provider: scripted ? "faux" : "openrouter", modelId: options.selectedModel, contextWindow: 250000 }], orchestratorModel: "default" });
    await engine.save();
    for (const extension of config.extensions) {
      await store.document(`${engine.prefix}/config/extensions/${extension.name}.ts`, extension.code);
    }
    await store.save(`${engine.prefix}/config/frozen.json`, engine.state.configuration);
    sandbox = new Sandbox(`refainery-${engine.state.runId}`, workspace);
    stage("starting-isolated-workspace");
    const sandboxImage = await sandbox.start();
    await store.save(`${engine.prefix}/sandbox.json`, { image: sandboxImage, name: sandbox.name, network: "none", hostMount: "workspace-only", workspace: sandbox.workspace, workerWorkspace: sandbox.workerWorkspace });
    const adapter = new PiAdapter(store, engine, registry, options.selectedModel, options.apiKey, sandbox,
      12, 217232, scripted);
    await adapter.initialize();
    options.apiKey = "";
    orchestrator = await adapter.create(config.personalities.find((p) => p.role === "orchestrator")!);
    engine.state.orchestrator.sessionId = orchestrator.sessionId;
    engine.state.orchestrator.sessionPath = orchestrator.path;
    await engine.save();
    stage("orchestrator-planning");
    await engine.beginTurn();
    await orchestrator.prompt(orchestratorFirstPrompt(request.prompt,
      config.agentText.orchestrator.firstPrompt, config.agentText.orchestrator.planTemplate));
    await engine.endTurn();
    while (engine.state.pendingAction?.kind === "assign") {
      stage("worker-starting");
      // Each worker gets a fresh process environment and the same persisted files.
      if (engine.state.tasks.length > 1) await sandbox.start();
      engine.state.phase = "dispatching";
      await engine.save();
      worker = await adapter.create(config.personalities.find((p) => p.role === "subagent")!);
      const task = engine.state.tasks.at(-1)!;
      const assignment = task.assignment;
      const attemptNumber = task.attempts.length + 1;
      // Qualify the local attempt ID: decisions, handovers and exports are run-wide.
      task.attempts.push({ id: `${task.id}-${localIdentity("attempt", attemptNumber)}`, title: task.title, number: attemptNumber, model: "default", personality: "worker",
        sessionId: worker.sessionId, sessionPath: worker.path, status: "running", startedAt: now(), endedAt: null,
        handover: null, export: notDue(), stopReason: null, review: "not-submitted", reviewedAt: null,
        retryReason: null, planRevision: engine.state.plan });
      engine.state.pendingAction = null;
      engine.state.phase = "executing";
      await engine.save(); // Dispatch intent saved before calling Pi.
      stage("worker-executing");
      const plan = engine.state.plan === null ? ""
        : await safeRead(store.root, `${engine.prefix}/${engine.state.plan}`);
      await worker.prompt(subagentFirstPrompt(assignment, config.agentText.subagent.firstPrompt, {
        request: request.prompt, plan, handoverTemplate: config.agentText.subagent.handover,
      }));
      let attempt = engine.state.tasks.at(-1)!.attempts.at(-1)!;
      attempt.endedAt = now();
      if (!attempt.handover) throw new Error("Worker stopped without a handover");
      attempt.status = "completed";
      attempt.export = { state: "pending", path: null, error: null };
      engine.state.phase = "exporting";
      await engine.save();
      stage("saving-worker-export");
      try { engine.state.tasks.at(-1)!.attempts.at(-1)!.export = await exportSession(store, engine.prefix, worker.session, attempt.id); }
      catch { engine.state.tasks.at(-1)!.attempts.at(-1)!.export = { state: "failed", path: null, error: "export-failed" }; throw new Error("Worker export failed"); }
      worker.session.dispose(); worker = undefined;
      // Workers and their background processes are stopped before orchestration resumes.
      await sandbox.stop();
      attempt = engine.state.tasks.at(-1)!.attempts.at(-1)!;
      attempt.review = "pending";
      engine.state.phase = "awaiting-review";
      await engine.save();
      const handover = await safeRead(store.root, `${engine.prefix}/${attempt.handover}`);
      stage("orchestrator-reviewing");
      await engine.beginTurn();
      await orchestrator.prompt(subagentReview(attempt, handover, config.agentText.orchestrator.subagentReview));
      await engine.endTurn();
    }
    const decision = engine.state.pendingAction as Checkpoint["pendingAction"];
    if (decision?.kind !== "finish") throw new Error("Orchestrator did not finish the run");
    scripted?.assertComplete();
    stage("saving-final-export");
    engine.state.phase = "finalizing";
    engine.state.orchestrator.export = { state: "pending", path: null, error: null };
    await engine.save();
    try { engine.state.orchestrator.export = await exportSession(store, engine.prefix, orchestrator.session, "orchestrator"); }
    catch { engine.state.orchestrator.export = { state: "failed", path: null, error: "export-failed" }; throw new Error("Orchestrator export failed"); }
    await engine.finishRequest();
    stage(engine.state.status === "waiting-for-user" ? "waiting-for-user" : "complete");
    return { runId: engine.state.runId, requestId: request.id, outcome: engine.state.status, storage: store.root };
  } catch (cause) {
    abort();
    await orchestrator?.session.agent.waitForIdle();
    await worker?.session.agent.waitForIdle();
    if (engine) {
      engine.state.status = "interrupted"; engine.state.phase = "recovery-required";
      engine.state.failure = "Execution stopped; inspect records before explicit recovery. No automatic replay.";
      for (const execution of [...engine.state.orchestrator.turns, ...engine.state.tasks.flatMap((t) => t.attempts)]) {
        if (!execution.endedAt || execution.status === "running") {
          execution.endedAt ??= now(); execution.status = "interrupted";
        }
      }
      try { await engine.save(); } catch { /* last committed checkpoint remains authoritative */ }
    }
    throw new Error("Milestone incomplete; inspect saved state. No automatic retry.", { cause });
  } finally {
    options.signal?.removeEventListener("abort", abort);
    orchestrator?.session.dispose(); worker?.session.dispose();
    try { await registry.stop(); }
    finally {
      // A sandbox cleanup failure intentionally preserves the writer lock.
      // Even a registry failure must not strand an executing worker.
      await sandbox?.stop();
      await store.release();
    }
  }
}

// Adapter from provisional SPEC.md checkpoint fixtures to the shared timeline.
// Select the last validated complete snapshot; never accumulate duplicate work
// by counting every checkpoint as another execution.
export function workflowPresentation(data) {
  const savedWorkflow = data.recordSource === "saved" || data.mode === "production";
  const agents = [
    { id: "orchestrator", name: "Orchestrator", role: "Plans, assigns, reviews, and owns run completion" },
    { id: "subagent", name: "Subagent", role: "One assignment at a time; hands back and stops" },
  ];
  const document = (runId, path) => data.documents.find((item) => item.runId === runId && item.path === path);
  const runs = data.runs.map((run) => {
    const checkpoint = run.checkpoints.at(-1);
    const config = checkpoint.configuration;
    const model = (id) => config.models.find((item) => item.id === id);
    const tasks = [];
    for (const turn of checkpoint.orchestrator.turns) {
      const selectedModel = model(config.orchestratorModel);
      tasks.push({ ...turn, id: `orchestrator-${turn.id}`, kind: "orchestrator", agentId: "orchestrator",
        transcriptUrl: document(run.id, checkpoint.orchestrator.export.path)?.url ?? null,
        export: checkpoint.orchestrator.export, sessionPath: checkpoint.orchestrator.sessionPath,
        runId: run.id, handover: null, contextWindow: selectedModel.contextWindow,
        details: { turnId: turn.id, sessionId: checkpoint.orchestrator.sessionId,
          model: selectedModel.modelId, provider: selectedModel.provider,
          configuration: config.id, review: "not-applicable" } });
    }
    for (const task of checkpoint.tasks) {
      if (!task.attempts.length) {
        const selectedModel = model(task.model);
        tasks.push({ id: `pending-${task.id}`, title: task.title, kind: "subagent", agentId: "subagent",
          status: "queued", startedAt: null, endedAt: null, transcriptUrl: null,
          runId: run.id, handover: null, export: { state: "not-due", path: null, error: null },
          contextWindow: selectedModel.contextWindow,
          details: { taskId: task.id, model: selectedModel.modelId, provider: selectedModel.provider,
            configuration: config.id, review: "not-submitted", reason: "Planned inside this run; no attempt dispatched." } });
      }
      for (const attempt of task.attempts) {
        const selectedModel = model(attempt.model);
        const decision = checkpoint.decisions.find((item) => item.attemptId === attempt.id);
        tasks.push({ id: `attempt-${attempt.id}`, title: task.title, kind: "subagent", agentId: "subagent",
          status: attempt.review === "pending" ? "awaiting-review" : attempt.status,
          executionStatus: attempt.status, startedAt: attempt.startedAt, endedAt: attempt.endedAt,
          transcriptUrl: document(run.id, attempt.export.path)?.url ?? null,
          export: attempt.export, sessionPath: attempt.sessionPath, handover: document(run.id, attempt.handover),
          runId: run.id, contextWindow: selectedModel.contextWindow,
          details: { taskId: task.id, attemptNumber: attempt.number, sessionId: attempt.sessionId,
            model: selectedModel.modelId, provider: selectedModel.provider, configuration: config.id,
            review: attempt.review, reviewedAt: attempt.reviewedAt, reason: attempt.stopReason,
            retryReason: attempt.retryReason, summary: decision?.summary } });
      }
    }
    return { ...run, checkpoint, status: checkpoint.phase === "awaiting-review" ? "awaiting-review" : checkpoint.status,
      summary: `Request ${run.requestId} · Phase: ${checkpoint.phase} · Latest checkpoint ${String(checkpoint.number).padStart(6, "0")}`,
      tasks, plan: document(run.id, checkpoint.plan),
      plans: (checkpoint.plans ?? []).map((entry) => ({ ...entry, document: document(run.id, entry.path) })),
      inferences: (data.inferences ?? []).filter((call) => call.runId === run.id),
      production: savedWorkflow,
      request: data.requests.find((request) => request.id === run.requestId) };
  });
  const attempts = runs.flatMap((run) => run.tasks).filter((task) => task.kind === "subagent" && task.startedAt);
  const outcomes = {};
  for (const review of ["accepted", "rejected", "pending", "not-submitted", ...(savedWorkflow ? ["decided"] : [])]) {
    outcomes[review] = attempts.filter((task) => task.details.review === review).length;
  }
  const executions = runs.flatMap((run) => run.tasks);
  return { ...data, savedWorkflow, agents, runs, operations: { asOf: data.asOf,
    activeRuns: runs.filter((run) => run.checkpoint.status === "running").length,
    active: executions.filter((task) => task.status === "running").length,
    queuedRequests: data.queue.length,
    pendingTasks: executions.filter((task) => !task.startedAt).length,
    finished: attempts.filter((task) => task.executionStatus === "completed").length,
    failed: attempts.filter((task) => task.executionStatus === "failed").length,
    interrupted: attempts.filter((task) => task.executionStatus === "interrupted").length,
    completedRuns: runs.filter((run) => run.checkpoint.status === "completed").length,
    failedRuns: runs.filter((run) => run.checkpoint.status === "failed").length,
    outcomes } };
}

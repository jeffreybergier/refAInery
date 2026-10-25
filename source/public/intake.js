import { mountFloor, disposeFloor } from "./floor.js";
import { taskCard } from "./preview.js";
import { workflowPresentation } from "./workflow.js";

export function orderedRequests(requests) {
  return requests.slice().sort((a, b) =>
    Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.id.localeCompare(b.id));
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function disclosure(title, content) {
  const details = element("details", "small my-3");
  details.append(element("summary", "", title),
    element("pre", "request-prompt text-break mt-2", content));
  return details;
}
const utc = (value) => value.replace("T", " ").replace("Z", " UTC");

export function renderRequests(requests, container, preview = null) {
  container.replaceChildren();
  for (const request of orderedRequests(requests)) {
    const card = element("article", "panel p-4");
    card.append(element("h3", "h6 text-break", request.id),
      element("p", "small text-body-secondary", `Schema ${request.schemaVersion} · Source: ${request.source}`));
    const receipt = element("p", "small", "Received: ");
    const time = element("time", "", utc(request.receivedAt));
    time.dateTime = request.receivedAt;
    receipt.append(time);
    const position = preview?.queue.indexOf(request.id) ?? -1;
    const run = preview?.runs.find((run) => run.requestId === request.id);
    const state = position >= 0 ? `FIFO queue position ${position + 1} · Not started` :
      run ? `Run ${run.id} · ${run.checkpoint.status} · ${run.checkpoint.phase}` : "Workflow membership not recorded";
    card.append(receipt, element("p", "small", state), element("p", "eyebrow", "Original prompt"),
      element("pre", "request-prompt text-break mb-0", request.prompt));
    container.append(card);
  }
}

function renderOperations(preview) {
  const operations = preview.operations;
  const container = document.querySelector("#operation-stats");
  container.replaceChildren();
  const activeRun = preview.runs.find((run) => run.checkpoint.phase !== "ended");
  const cards = [
    ["Workflow phase", activeRun?.checkpoint.phase ?? "No active run", "Saved state, not a worker heartbeat"],
    ["Active runs", operations.activeRuns, "At most one top-level request"],
    ["Active executions", operations.active, preview.savedWorkflow ? "Last saved execution state; not a heartbeat" : "Observed at the frozen snapshot"],
    ["Queued requests", operations.queuedRequests, "FIFO · separate from subwork"],
    ["Pending subagent tasks", operations.pendingTasks, "Inside existing runs"],
    ["Finished attempts", operations.finished, "Includes context handbacks; not acceptance"],
    ["Failed / interrupted", `${operations.failed} / ${operations.interrupted}`, "Subagent attempts, not original requests"],
    ["Completed / failed runs", `${operations.completedRuns} / ${operations.failedRuns}`, "Original request outcomes"],
  ];
  for (const [label, value, note] of cards) {
    const column = element("div", "col-6 col-lg-3");
    const card = element("article", "panel metric-card h-100 p-4");
    card.append(element("h2", "eyebrow mb-3", label),
      element("p", "h3 text-break", String(value)), element("p", "metric-note mb-0", note));
    column.append(card);
    container.append(column);
  }
  renderOutcomes(operations.outcomes, preview.savedWorkflow);
}
function renderOutcomes(outcomes, production = false) {
  if (production) {
    document.querySelector("#outcome-chart").replaceChildren(element("p", "small",
      `${outcomes.decided} decisions recorded · ${outcomes.pending} awaiting decision · ${outcomes["not-submitted"]} not submitted`));
    document.querySelector("#outcome-note").textContent = "Decisions are saved next actions, not accepted/rejected reviews or independently verified success.";
    return;
  }
  const total = outcomes.accepted + outcomes.rejected;
  const rate = total ? Math.round(outcomes.accepted / total * 100) : null;
  const svg = (tag, attributes, text) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const chart = svg("svg", { viewBox: "0 0 240 165", class: "outcome-svg", role: "img",
    "aria-label": `Attempt handover reviews: ${outcomes.accepted} accepted, ${outcomes.rejected} rejected, ${outcomes.pending} pending, ${outcomes["not-submitted"]} not submitted.` });
  chart.append(svg("circle", { cx: 120, cy: 78, r: 56, class: "ring-background" }));
  let offset = 0;
  const circumference = 2 * Math.PI * 56;
  for (const [count, color] of [[outcomes.accepted, "#8ad0ab"], [outcomes.rejected, "#f3998d"]]) {
    if (total && count) chart.append(svg("circle", { cx: 120, cy: 78, r: 56, fill: "none", stroke: color,
      "stroke-width": 12, "stroke-dasharray": `${count / total * circumference} ${circumference}`,
      "stroke-dashoffset": -offset, transform: "rotate(-90 120 78)" }));
    offset += total ? count / total * circumference : 0;
  }
  chart.append(svg("text", { x: 120, y: 80, "text-anchor": "middle", class: "ring-value" }, rate === null ? "—" : `${rate}%`),
    svg("text", { x: 120, y: 101, "text-anchor": "middle", class: "chart-label" }, total ? "accepted reviews" : "no decisions yet"));
  document.querySelector("#outcome-chart").replaceChildren(chart,
    element("p", "small", `${outcomes.accepted} accepted · ${outcomes.rejected} rejected · ${outcomes.pending} pending · ${outcomes["not-submitted"]} not submitted`));
  document.querySelector("#outcome-note").textContent =
    "Denominator: accepted + rejected attempt handovers only. Accepting a context-limit handover is not completion of the task or original request. Orchestrator turns are excluded.";
}
function executionCard(task, agents, asOf) {
  const unavailable = task.kind === "orchestrator" ?
    (task.export.state === "not-due" ? "Orchestrator transcript only after the overall run ends." :
      `Final orchestrator export ${task.export.state}: ${task.export.error ?? "not saved yet"}`) :
    `Subagent export: ${task.export.state}${task.export.error ? ` — ${task.export.error}` : ""}.`;
  const card = taskCard(task, agents, asOf, {
    transcriptUnavailable: unavailable,
    artifactTitle: "Output artifacts · unavailable",
    artifactNote: "General output-artifact metadata is undefined in v1. Plans, handovers, and session exports are shown separately below.",
  });
  card.append(element("p", "small mt-3", `Configured context capacity: ${task.contextWindow.toLocaleString("en-US")} tokens (not usage).`),
    element("p", "small text-break", `Session file: ${task.sessionPath ?? "No attempt dispatched"}`));
  if (task.kind === "orchestrator" && task.transcriptUrl) {
    card.append(element("p", "small", "This is the shared final orchestrator session, not a per-turn export."));
  }
  if (task.handover) {
    card.append(disclosure(`Markdown handover · ${task.handover.path}`, task.handover.text));
    card.append(element("p", "small text-body-secondary", "Next steps and file lists are agent-reported, not dispatch commands or a verified change audit."));
  } else if (task.kind === "subagent") {
    card.append(element("p", "small", "No handover recorded. An interruption is not a completed result."));
  }
  return card;
}
function runDetails(run) {
  const section = element("section", "small mt-3");
  const checkpoint = run.checkpoint;
  section.append(element("h4", "h6", "Saved run state"),
    element("p", "", `${run.requestId} · ${run.id} · ${checkpoint.status} / ${checkpoint.phase}`),
    element("p", "", `Latest checkpoint ${String(checkpoint.number).padStart(6, "0")} saved ${utc(checkpoint.savedAt)}. This is not an execution timestamp.`),
    disclosure("Original request", run.request.prompt));
  if (run.plan) section.append(disclosure(`Current Markdown plan · ${run.plan.path}`, run.plan.text));
  const decisions = element("details", "my-3");
  decisions.append(element("summary", "", `Applied orchestrator decisions (${checkpoint.decisions.length})`));
  for (const decision of checkpoint.decisions) decisions.append(element("p", "mt-2",
    `${utc(decision.at)} · ${decision.attemptId ?? "Initial plan"} · ${decision.action ?? decision.review}: ${decision.summary}`));
  section.append(decisions);
  const history = element("details", "checkpoint-history my-3");
  history.append(element("summary", "", `Saved checkpoints (${run.checkpoints.length}${run.production ? " durable snapshots" : " illustrative snapshots"})`));
  for (const saved of run.checkpoints) history.append(disclosure(
    `${String(saved.number).padStart(6, "0")}.json · ${utc(saved.savedAt)} · ${saved.phase}`,
    JSON.stringify(saved, null, 2)));
  section.append(history);
  if (run.production) {
    if (checkpoint.failure) section.append(element("p", "text-warning", checkpoint.failure));
    if (checkpoint.resultSummary) section.append(disclosure("Final outcome summary", checkpoint.resultSummary));
    const plans = element("details", "my-3");
    plans.append(element("summary", "", `Plan history (${run.plans.length})`));
    for (const plan of run.plans) plans.append(disclosure(`${plan.path} · ${plan.turnId}`, plan.document?.text ?? "Unavailable"));
    section.append(plans);
    const calls = element("details", "my-3");
    calls.append(element("summary", "", `Inference records (${run.inferences.length})`));
    for (const call of run.inferences) {
      calls.append(element("p", "small text-break", `${call.personalityId} · ${call.status} · Requested: ${call.requestedModel} · Actual (provider-reported): ${call.actualModel ?? "unknown"}`),
        disclosure(`${call.id} · model, usage and pricing provenance`, JSON.stringify(call, null, 2)));
    }
    section.append(calls);
  }
  return section;
}
function renderConfiguration(preview) {
  const container = document.querySelector("#configuration-models");
  container.replaceChildren();
  document.querySelector("#configuration-empty").hidden = preview.runs.length > 0;
  for (const run of preview.runs) {
    const config = run.checkpoint.configuration;
    const column = element("div", "col-md-6");
    const card = element("article", "config-agent h-100 p-3");
    card.append(element("h3", "h6", `${run.title} · ${config.id}`),
      element("p", "small", `Orchestrator selection: ${config.orchestratorModel}`));
    for (const model of config.models) card.append(element("p", "small text-break",
      `${model.id}: ${model.provider} / ${model.modelId} · ${model.contextWindow.toLocaleString("en-US")} tokens`));
    for (const agent of config.personalities ?? []) card.append(element("p", "small text-break", `${agent.name} (${agent.role}): ${agent.availableTools.join(", ") || "no tools"}`));
    card.append(element("p", "small text-body-secondary mb-0", "Frozen for this run and recovery. Subagents select from this allowlist; no silent fallback."));
    column.append(card);
    container.append(column);
  }
}
function clearWorkflow(message) {
  disposeFloor();
  for (const id of ["floor-runs", "request-list", "configuration-models", "operation-stats", "outcome-chart"]) {
    document.getElementById(id).replaceChildren();
  }
  document.querySelector("#outcome-note").textContent = "";
  document.querySelector("#workflow-data").hidden = true;
  document.querySelector("#request-count").textContent = "—";
  document.querySelector("#snapshot-time").textContent = "Workflow unavailable";
  for (const id of ["operations-empty", "floor-empty", "requests-state", "configuration-empty", "queue-state"]) {
    const node = document.getElementById(id);
    node.hidden = false;
    node.textContent = message;
  }
}
async function refresh() {
  const button = document.querySelector("#refresh-preview");
  const error = document.querySelector("#preview-error");
  button.disabled = true;
  try {
    const response = await fetch("/api/v1/preview");
    if (!response.ok) throw new Error("Workflow unavailable");
    const data = await response.json();
    error.hidden = true;
    document.querySelector("#test-notice").hidden = data.mode !== "test";
    const production = (data.recordSource === "saved" || data.mode === "production") && data.schemaVersion === 1;
    const label = data.mode === "test" ? "TEST" : "PRODUCTION";
    if (production && data.mode === "test") document.querySelector("#test-notice").textContent =
      "TEST FACTORY / Scripted model responses with real Pi sessions and tool execution. No OpenRouter calls.";
    button.hidden = data.mode !== "test" && !production;
    button.textContent = production ? "Refresh saved workflow" : "Refresh fixtures";
    if (data.mode !== "test" && !production) {
      clearWorkflow("No saved workflow is connected. Start refinery.py test serve or prod serve.");
      return;
    }
    if (production) {
      const notes = {
        "workflow-contract-note": `${label} supervised workflow: one request, one worker, explicit plan revisions and saved decisions. No automatic recovery or queue draining.`,
        "token-history-note": "Interval charts are not implemented. Per-call usage and reported costs are available in the run inspector.",
        "telemetry-note": "Saved state is not a worker heartbeat. Context capacity is 250,000 tokens; long-context handback still needs live validation.",
        "queue-contract-note": "Unclaimed intake records define queue membership; dispatch is explicit and blocked by unfinished runs.",
        "configuration-note": "Frozen model/personality definitions for each run. Test uses a local catalog and scripted Pi provider; production uses OpenRouter.",
        "storage-contract-note": "Immutable requests, plans, handovers, checkpoint revisions and inference records. Pi owns session files and generates the native HTML exports.",
        "dashboard-footer": `refAInery / ${label} saved workflow`,
      };
      for (const [id, text] of Object.entries(notes)) document.getElementById(id).textContent = text;
    }
    const preview = workflowPresentation(data);
    renderOperations(preview);
    renderConfiguration(preview);
    renderRequests(preview.requests, document.querySelector("#request-list"), preview);
    mountFloor(preview, document.querySelector("#floor-runs"), executionCard, { runDetails,
      note: production ? `${label} · Saved workflow observed ${utc(data.asOf)}. Supervised single-request execution; no automatic recovery or queue draining. Blue fill = selected.` :
        `TEST snapshot: ${utc(data.asOf)}. Provisional observed execution timestamps, not checkpoint-save times or CPU activity. One run at a time; sequential subagents. Review waiting does not extend bars. Finished is not accepted. Blue fill = selected.` });
    document.querySelector("#request-count").textContent = preview.requests.length.toLocaleString("en-US");
    document.querySelector("#snapshot-time").textContent = `${production ? `${label} saved workflow` : "Frozen workflow snapshot"} · ${utc(data.asOf)}`;
    if (production && data.registry) {
      const last = data.registry.lastSuccessAt;
      const state = data.registry.provider === "faux" ? "local test fixture" :
        !last ? "unavailable" : Date.parse(data.asOf) - Date.parse(last) >= 3600000 ? "STALE" : "recently fetched";
      document.querySelector("#snapshot-time").textContent += ` · Prices ${state}${data.registry.error ? " · refresh degraded" : ""}`;
    }
    document.querySelector("#workflow-data").hidden = false;
    document.querySelector("#operations-empty").hidden = true;
    const empty = document.querySelector("#floor-empty");
    empty.hidden = preview.runs.length > 0;
    empty.textContent = "No runs in this snapshot. Queued requests are not past executions.";
    const requestsState = document.querySelector("#requests-state");
    requestsState.hidden = preview.requests.length > 0;
    requestsState.textContent = production ? "No requests in this collection. This does not establish that the factory is idle." :
      "No request fixtures in this collection. This does not establish that the factory is idle.";
    document.querySelector("#queue-state").textContent = preview.queue.length ?
      `FIFO request queue: ${preview.queue.join(" → ")}. Starts only after the current run ends and workers stop.` : "No queued requests recorded. Factory idle/stopped state remains unknown.";
  } catch {
    clearWorkflow("Workflow records unavailable. No older-checkpoint or production fallback was attempted.");
    error.textContent = "V1 workflow could not be loaded. Check request/checkpoint records and referenced documents, then refresh.";
    error.hidden = false;
    button.hidden = false;
  } finally {
    button.disabled = false;
  }
}
if (typeof document !== "undefined" && document.body.dataset.dashboard === "v1") {
  document.querySelector("#refresh-preview").addEventListener("click", refresh);
  refresh();
}

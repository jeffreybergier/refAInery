import assert from "node:assert/strict";
import { once } from "node:events";
import { cp, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { loadIntakePreview } from "../source/intake-preview.ts";
import { loadWorkflowPreview, validateWorkflowFixtures } from "../source/workflow-preview.ts";
import { workflowPresentation } from "../source/public/workflow.js";
import { timelineLayout } from "../source/public/floor.js";
import { createAppServer } from "../source/server.ts";

const raw = JSON.parse(await readFile(new URL("../storage/legacy/v1/workflow-v1.json", import.meta.url), "utf8"));
const { requests } = await loadIntakePreview();
const latest = (data, index = 1) => data.runs[index].checkpoints.at(-1);
const attempt = (data) => latest(data).tasks[0].attempts[1];

test("v1 projects the latest complete checkpoint without duplicating history", async () => {
  const data = await loadWorkflowPreview();
  const preview = workflowPresentation(data);
  assert.deepEqual(preview.operations, {
    asOf: raw.asOf, activeRuns: 1, active: 0, queuedRequests: 1, pendingTasks: 1,
    finished: 3, failed: 0, interrupted: 1, completedRuns: 1, failedRuns: 0,
    outcomes: { accepted: 2, rejected: 0, pending: 1, "not-submitted": 1 },
  });
  assert.equal(preview.runs[0].tasks.length, 5);
  assert.equal(preview.runs[1].tasks.length, 5); // Includes one unstarted task.
  assert.equal(preview.runs[1].status, "awaiting-review");
  assert.equal(preview.runs[1].checkpoint.status, "running");
  assert.equal(preview.runs[0].tasks.find((t) => t.details.attemptNumber === 1).details.reason, "context-limit");
  assert.equal(preview.runs[0].tasks.find((t) => t.details.attemptNumber === 2).details.taskId, "implement");
  assert.equal(preview.runs[1].tasks.find((t) => t.details.attemptNumber === 1).handover, undefined);
});

test("timeline keeps execution observations separate from receipt, checkpoint, and review times", async () => {
  const preview = workflowPresentation(await loadWorkflowPreview());
  const layout = timelineLayout(preview.runs, preview.operations.asOf);
  assert.equal(layout.start, Date.parse("2026-10-24T14:01:00Z"));
  assert.equal(layout.runs.flatMap((run) => run.executions).length, 9);
  assert.ok(layout.runs.every((run) => run.executions.every((execution) => execution.row === 0)));
  const waiting = layout.runs[1].executions.find((item) => item.task.status === "awaiting-review");
  assert.equal(waiting.task.endedAt, "2026-10-24T14:30:00Z");
  assert.equal(waiting.width, 4 / 31); // Not 14:30:06 checkpoint or 14:32 snapshot.
  assert.equal(preview.runs[1].checkpoint.savedAt, "2026-10-24T14:30:06Z");
});

test("running observations render to the snapshot without inventing usage or activity", async () => {
  const data = structuredClone(raw);
  Object.assign(attempt(data), { status: "running", endedAt: null, stopReason: null,
    handover: null, export: { state: "not-due", path: null, error: null }, review: "not-submitted" });
  latest(data).phase = "executing";
  const preview = workflowPresentation({ ...await loadIntakePreview(), ...validateWorkflowFixtures(data, requests), documents: [] });
  assert.equal(preview.operations.active, 1);
  const task = preview.runs[1].tasks.find((task) => task.status === "running");
  assert.equal(task.details.usage, undefined);
  assert.equal(task.details.activity, undefined);
  assert.equal(task.transcriptUrl, null);
  assert.equal(timelineLayout(preview.runs, data.asOf).runs[1].executions.at(-1).width, 6 / 31);
});

test("a finished attempt can be rejected without changing execution completion", async () => {
  const data = structuredClone(raw);
  const checkpoint = latest(data);
  checkpoint.phase = "planning";
  checkpoint.savedAt = "2026-10-24T14:31:05Z";
  Object.assign(attempt(data), { review: "rejected", reviewedAt: "2026-10-24T14:31:00Z" });
  checkpoint.orchestrator.turns.push({ id: "review", title: "Review handback", status: "completed",
    startedAt: "2026-10-24T14:30:10Z", endedAt: "2026-10-24T14:31:00Z" });
  checkpoint.decisions.push({ attemptId: "edit-2", at: "2026-10-24T14:31:00Z",
    review: "rejected", summary: "Terminology needs another pass." });
  const preview = workflowPresentation({ ...await loadIntakePreview(), ...validateWorkflowFixtures(data, requests), documents: [] });
  assert.equal(preview.operations.finished, 3);
  assert.equal(preview.operations.outcomes.accepted, 2);
  assert.equal(preview.operations.outcomes.rejected, 1);
  assert.equal(preview.operations.outcomes.pending, 0);
  assert.equal(preview.operations.completedRuns, 1);
});

test("exports respect boundaries and all orchestrator turns share only the final export", async () => {
  const preview = workflowPresentation(await loadWorkflowPreview());
  const finished = preview.runs[0].tasks.filter((task) => task.kind === "orchestrator");
  assert.ok(finished.every((task) => task.transcriptUrl === "/preview/v1/documents/run-search/exports/search-final.html"));
  const active = preview.runs[1].tasks.filter((task) => task.kind === "orchestrator");
  assert.ok(active.every((task) => task.transcriptUrl === null));
  const pendingReview = preview.runs[1].tasks.find((task) => task.status === "awaiting-review");
  assert.match(pendingReview.handover.text, /## Goal/);
  assert.match(pendingReview.transcriptUrl, /exports\/release.html$/);
});

test("failed exports remain explicit with no link or implied review success", async () => {
  const data = structuredClone(raw);
  attempt(data).export = { state: "failed", path: null, error: "Fictional export failure; retry export only." };
  attempt(data).review = "not-submitted";
  latest(data).phase = "exporting";
  const preview = workflowPresentation({ ...await loadIntakePreview(), ...validateWorkflowFixtures(data, requests), documents: [] });
  const task = preview.runs[1].tasks.find((task) => task.details.attemptNumber === 2);
  assert.equal(task.status, "completed");
  assert.equal(task.transcriptUrl, null);
  assert.match(task.export.error, /retry export only/);
  assert.equal(preview.operations.outcomes.pending, 0);
});

test("rejects impossible sequential workflow, invalid identities, models, timing and review", () => {
  const cases = [
    (data) => { data.environment = "production"; },
    (data) => { data.runs[1].requestId = "missing"; },
    (data) => { data.queue.push(data.queue[0]); },
    (data) => { data.queue = ["request-demo-001"]; },
    (data) => { data.runs[1].checkpoints[0].startedAt = "2026-10-24T14:10:00Z"; latest(data).startedAt = "2026-10-24T14:10:00Z"; },
    (data) => { attempt(data).startedAt = "2026-10-24T14:23:00Z"; },
    (data) => { attempt(data).model = "not-allowed"; },
    (data) => { latest(data).configuration.models[0].contextWindow = 123; },
    (data) => { latest(data).configuration.models[0].modelId = "silently-changed"; },
    (data) => { latest(data).orchestrator.export = { state: "saved", path: "exports/premature.html", error: null }; },
    (data) => { latest(data).savedAt = "2026-02-30T14:30:06Z"; },
    (data) => { attempt(data).endedAt = "2026-10-24T14:33:00Z"; },
    (data) => { attempt(data).handover = null; },
    (data) => { attempt(data).handover = "../escape.md"; },
    (data) => { attempt(data).review = "accepted"; },
    (data) => { attempt(data).export.path = null; },
    (data) => { attempt(data).number = 1; },
    (data) => { attempt(data).sessionId = "session-release"; },
    (data) => { latest(data, 0).decisions = []; },
    (data) => { latest(data, 0).tasks[0].attempts[0].reviewedAt = "2026-10-24T14:09:00Z";
      latest(data, 0).decisions[0].at = "2026-10-24T14:09:00Z"; },
  ];
  for (const [index, mutate] of cases.entries()) {
    const data = structuredClone(raw);
    mutate(data);
    assert.throws(() => validateWorkflowFixtures(data, requests), `invalid fixture ${index}`);
  }
});

test("checkpoint history cannot be silently discarded or roll back frozen configuration", () => {
  const data = structuredClone(raw);
  const previous = structuredClone(latest(data, 0));
  previous.number = 4;
  previous.savedAt = "2026-10-24T14:20:06Z";
  data.runs[0].checkpoints.push(previous);
  validateWorkflowFixtures(data, requests);
  previous.tasks[0].attempts = [];
  previous.decisions = [];
  assert.throws(() => validateWorkflowFixtures(data, requests), /lost execution history/);
});

test("empty workflow and queue-only data do not invent runs", async () => {
  const empty = validateWorkflowFixtures({ fixtureVersion: 1, environment: "test", asOf: raw.asOf, queue: [], runs: [] }, []);
  const view = workflowPresentation({ ...empty, requests: [], documents: [] });
  assert.equal(view.runs.length, 0);
  assert.equal(view.operations.activeRuns, 0);
  assert.equal(view.operations.outcomes.accepted, 0);
  const queued = validateWorkflowFixtures({ fixtureVersion: 1, environment: "test", asOf: raw.asOf,
    queue: requests.map((request) => request.id), runs: [] }, requests);
  assert.equal(queued.queue.length, 3);
  assert.equal(queued.runs.length, 0);
});

test("missing referenced files and symlinks fail the entire preview without rollback", async (t) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "refainery-v1-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(new URL("../storage/legacy/v1/", import.meta.url), directory, { recursive: true });
  const root = pathToFileURL(directory + "/");
  await loadWorkflowPreview(root);
  const filename = join(directory, "workflow-v1/run-search/exports/search-final.html");
  await rm(filename);
  await assert.rejects(loadWorkflowPreview(root));
  await symlink(join(directory, "workflow-v1/run-search/exports/search-done.html"), filename);
  await assert.rejects(loadWorkflowPreview(root), /symlink/);
});

test("only referenced v1 documents are served, with sandboxing and no production access", async (t) => {
  async function listen(preview) {
    const server = createAppServer(preview);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const origin = await listen({ config: "/unused/test", storage: "/unused/test" });
  const prefix = "/preview/v1/documents/";
  const html = prefix + "run-search/exports/search-final.html";
  const response = await fetch(origin + html);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy"), /^sandbox; default-src 'none'/);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(await response.text(), /TEST sample, not a Pi export/);
  assert.equal(await (await fetch(origin + html, { method: "HEAD" })).text(), "");
  const markdown = await fetch(origin + prefix + "run-release/handovers/release.md");
  assert.match(markdown.headers.get("content-type"), /text\/plain/);
  assert.match(await markdown.text(), /## Goal/);
  for (const file of ["run-search/exports/not-referenced.html", "run-release/exports/search-final.html",
    "run-release/sessions/release.jsonl", "../requests-v1.json"]) {
    assert.equal((await fetch(origin + prefix + file)).status, 404, file);
  }
  const production = await listen();
  assert.equal((await fetch(production + html)).status, 404);
  assert.deepEqual(await (await fetch(production + "/api/v1/preview")).json(), { mode: "production" });
});

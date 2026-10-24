import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPreview } from "../source/preview.ts";
import { createAppServer } from "../source/server.ts";

async function fixtures(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "refainery-preview-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directories = { config: join(root, "config/test"), storage: join(root, "storage/test") };
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
  const config = {
    fixtureVersion: 1, environment: "test", workshopName: "Fake workshop",
    agents: [{ id: "reviewer", name: "Inspector", role: "Review" }],
    privateField: "never send this field",
  };
  const storage = {
    fixtureVersion: 2, environment: "test",
    operations: { state: "running", asOf: "2026-10-23T13:30:00Z",
      tokenUsage: [{ at: "2026-10-23T13:20:00Z", input: 1000, output: 200 }] },
    runs: [{ id: "run-1", title: "Fictional run", summary: "Example", status: "running",
      tasks: [{ id: "task-1", title: "Review", agentId: "reviewer", status: "running",
        kind: "subagent", stage: 0, startedAt: "2026-10-23T13:20:00Z",
        endedAt: null, transcriptId: null }] }],
  };
  const save = async () => {
    await writeFile(join(directories.config, "config.json"), JSON.stringify(config));
    await writeFile(join(directories.storage, "workshop.json"), JSON.stringify(storage));
  };
  await save();
  return { root, directories, config, storage, save };
}

async function listen(t, directories) {
  const server = createAppServer(directories);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

test("preview returns only display fields and never changes fixtures", async (t) => {
  const { directories } = await fixtures(t);
  const path = join(directories.storage, "workshop.json");
  const before = await readFile(path, "utf8");
  const preview = await loadPreview(directories);
  assert.equal(preview.mode, "test");
  assert.equal(preview.runs[0].tasks[0].agentId, "reviewer");
  assert.equal(preview.privateField, undefined);
  assert.equal(await readFile(path, "utf8"), before);
});

test("optional inspector metadata is allowlisted and preserves unknown counters", async (t) => {
  const fixture = await fixtures(t);
  const task = fixture.storage.runs[0].tasks[0];
  task.details = { taskId: "logical", attemptNumber: 2, review: "not-submitted",
    model: "sample", provider: "local", activity: "Running bash",
    lastActivityAt: "2026-10-23T13:29:57Z", artifacts: ["report.txt"],
    usage: { input: 0, output: null, cachedInput: 0, coverage: "partial" },
    secret: "NEVER EXPOSE" };
  await fixture.save();
  const details = (await loadPreview(fixture.directories)).runs[0].tasks[0].details;
  assert.equal(details.attemptNumber, 2);
  assert.deepEqual(details.usage, task.details.usage);
  assert.deepEqual(details.artifacts, ["report.txt"]);
  assert.equal(details.secret, undefined);
  assert.equal(details.sessionId, null);
});

test("invalid inspector identities, times, reviews and usage fail closed", async (t) => {
  const fixture = await fixtures(t);
  const task = fixture.storage.runs[0].tasks[0];
  for (const details of [
    { attemptNumber: 1 }, { taskId: "logical", attemptNumber: 0 },
    { turnId: "turn" }, { review: "accepted" }, { review: "invented" },
    { lastActivityAt: "2026-10-23T13:31:00Z" },
    { lastActivityAt: "2026-10-23T13:19:00Z" },
    { queuedAt: "2026-10-23T13:21:00Z" },
    { reviewedAt: "2026-10-23T13:25:00Z" },
    { usage: { input: -1, coverage: "partial" } },
    { usage: { input: 1, cachedInput: 2, coverage: "final" } },
    { usage: { input: 0, coverage: "unavailable" } },
    { artifacts: [123] },
  ]) {
    task.details = details;
    await fixture.save();
    await assert.rejects(loadPreview(fixture.directories));
  }
});

test("finished execution and rejected result remain independent", async (t) => {
  const fixture = await fixtures(t);
  const task = fixture.storage.runs[0].tasks[0];
  task.status = "completed";
  task.endedAt = "2026-10-23T13:25:00Z";
  task.details = { review: "rejected", reviewedAt: "2026-10-23T13:27:00Z",
    queuedAt: "2026-10-23T13:19:00Z", lastActivityAt: task.endedAt };
  fixture.storage.operations.state = "idle";
  await fixture.save();
  const execution = (await loadPreview(fixture.directories)).runs[0].tasks[0];
  assert.equal(execution.status, "completed");
  assert.equal(execution.details.review, "rejected");
  assert.equal(execution.endedAt, "2026-10-23T13:25:00Z");
  task.status = "awaiting-review";
  await fixture.save();
  await assert.rejects(loadPreview(fixture.directories));
});

test("attempt history retains interrupted executions and rejects duplicate attempt identities", async (t) => {
  const fixture = await fixtures(t);
  const task = fixture.storage.runs[0].tasks[0];
  task.details = { taskId: "logical", attemptNumber: 2 };
  fixture.storage.runs[0].tasks.push({ ...task, id: "previous", status: "interrupted",
    endedAt: "2026-10-23T13:25:00Z", details: { taskId: "logical", attemptNumber: 1 } });
  await fixture.save();
  assert.equal((await loadPreview(fixture.directories)).runs[0].tasks[1].status, "interrupted");
  fixture.storage.runs[0].tasks[1].details.attemptNumber = 2;
  await fixture.save();
  await assert.rejects(loadPreview(fixture.directories));
});

test("edits become visible on the next request without restart", async (t) => {
  const fixture = await fixtures(t);
  const origin = await listen(t, fixture.directories);
  assert.equal((await (await fetch(`${origin}/api/preview`)).json()).workshopName, "Fake workshop");
  fixture.config.workshopName = "Changed workshop";
  await fixture.save();
  assert.equal((await (await fetch(`${origin}/api/preview`)).json()).workshopName, "Changed workshop");
});

test("production server does not expose fixtures", async (t) => {
  const origin = await listen(t);
  assert.deepEqual(await (await fetch(`${origin}/api/preview`)).json(), { mode: "production" });
});

test("unsupported schemas, production data, duplicate IDs, and bad references fail", async (t) => {
  const fixture = await fixtures(t);
  for (const mutate of [
    () => { fixture.config.fixtureVersion = 2; },
    () => { fixture.storage.environment = "production"; },
    () => { fixture.config.agents.push(fixture.config.agents[0]); },
    () => { fixture.storage.runs[0].tasks[0].agentId = "missing"; },
    () => { fixture.storage.runs[0].status = "unknown"; },
    () => { fixture.storage.fixtureVersion = 1; },
    () => { fixture.storage.operations.state = "stopped"; },
    () => { fixture.storage.operations.tokenUsage[0].input = -1; },
    () => { fixture.storage.operations.tokenUsage[0].output = 1.5; },
    () => { fixture.storage.operations.tokenUsage.push(fixture.storage.operations.tokenUsage[0]); },
    () => { fixture.storage.operations.tokenUsage[0].at = "2026-10-23T14:30:00Z"; },
    () => { fixture.storage.operations.asOf = "2026-02-30T13:30:00Z"; },
    () => { fixture.storage.runs[0].tasks[0].startedAt = "2026-10-23T14:30:00Z"; },
    () => { fixture.storage.runs[0].tasks[0].stage = -1; },
    () => { fixture.storage.runs[0].tasks[0].kind = "unknown"; },
    () => { fixture.storage.runs[0].tasks[0].transcriptId = "../secret"; },
    () => { fixture.storage.runs[0].tasks[0].transcriptId = "running-report"; },
  ]) {
    const config = structuredClone(fixture.config);
    const storage = structuredClone(fixture.storage);
    mutate();
    await fixture.save();
    await assert.rejects(loadPreview(fixture.directories));
    Object.assign(fixture.config, config);
    Object.assign(fixture.storage, storage);
  }
});

test("prod directories and fixture symlink escapes are rejected", async (t) => {
  const fixture = await fixtures(t);
  const prod = join(fixture.root, "prod");
  await mkdir(prod);
  await assert.rejects(loadPreview({ ...fixture.directories, config: prod }));
  const outside = join(prod, "config.json");
  await writeFile(outside, JSON.stringify(fixture.config));
  const file = join(fixture.directories.config, "config.json");
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(loadPreview(fixture.directories));
});

test("invalid live edits return a redacted error, never production fallback", async (t) => {
  const fixture = await fixtures(t);
  const origin = await listen(t, fixture.directories);
  await writeFile(join(fixture.directories.storage, "workshop.json"), "PRIVATE malformed data");
  const response = await fetch(`${origin}/api/preview`);
  assert.equal(response.status, 503);
  const error = await response.text();
  assert.doesNotMatch(error, /PRIVATE|production|refainery-preview-/);
  assert.match(error, /Test fixtures unavailable/);
});

test("metrics derive from tasks and exclude orchestrators from subagent success", async (t) => {
  const fixture = await fixtures(t);
  const base = fixture.storage.runs[0].tasks[0];
  const task = (id, status, kind = "subagent") => ({
    ...base, id, status, kind,
    endedAt: ["completed", "failed", "awaiting-review"].includes(status) ? "2026-10-23T13:25:00Z" : null,
    startedAt: ["queued", "cancelled"].includes(status) ? null : base.startedAt,
  });
  fixture.storage.runs[0].tasks.push(task("ok", "completed"), task("bad", "failed"),
    task("orchestrator", "completed", "orchestrator"), task("queued", "queued"),
    task("cancelled", "cancelled"), task("review", "awaiting-review"));
  await fixture.save();
  const preview = await loadPreview(fixture.directories);
  assert.deepEqual(preview.operations.counts, { active: 1, queued: 1, completed: 2, failed: 1 });
  assert.deepEqual(preview.operations.outcomes, { succeeded: 1, failed: 1, other: 4 });
});

test("empty idle and stopped factories have zero counts and no made-up samples", async (t) => {
  const fixture = await fixtures(t);
  fixture.storage.runs = [];
  fixture.storage.operations.tokenUsage = [];
  for (const state of ["idle", "stopped"]) {
    fixture.storage.operations.state = state;
    await fixture.save();
    const preview = await loadPreview(fixture.directories);
    assert.equal(preview.operations.state, state);
    assert.deepEqual(preview.operations.counts, { active: 0, queued: 0, completed: 0, failed: 0 });
    assert.deepEqual(preview.operations.outcomes, { succeeded: 0, failed: 0, other: 0 });
    assert.deepEqual(preview.operations.tokenUsage, []);
  }
});

async function addTranscript(fixture) {
  const task = fixture.storage.runs[0].tasks[0];
  task.status = "completed";
  task.endedAt = "2026-10-23T13:25:00Z";
  task.transcriptId = "sample";
  fixture.storage.operations.state = "idle";
  const folder = join(fixture.directories.storage, "transcripts");
  await mkdir(folder);
  await writeFile(join(folder, "sample.html"), '<!doctype html><h1>TEST FIXTURE</h1><script>window.bad = true</script>');
  await fixture.save();
  return folder;
}

test("referenced HTML transcripts have a script-free opaque-origin sandbox", async (t) => {
  const fixture = await fixtures(t);
  await addTranscript(fixture);
  const origin = await listen(t, fixture.directories);
  const preview = await loadPreview(fixture.directories);
  const url = preview.runs[0].tasks[0].transcriptUrl;
  assert.equal(url, "/preview/transcripts/sample.html");
  const response = await fetch(origin + url);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const csp = response.headers.get("content-security-policy");
  assert.match(csp, /^sandbox;/);
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /allow-scripts|allow-same-origin/);
  assert.match(await response.text(), /TEST FIXTURE/);
  assert.equal(await (await fetch(origin + url, { method: "HEAD" })).text(), "");
  assert.equal((await fetch(`${origin}/preview/transcripts/unknown.html`)).status, 404);
  assert.equal((await fetch(`${origin}/preview/transcripts/sample.html`, { method: "POST" })).status, 405);
  const production = await listen(t);
  assert.equal((await fetch(production + url)).status, 404);
});

test("missing reports, unreferenced files, and symlink escapes are not served", async (t) => {
  const fixture = await fixtures(t);
  const folder = await addTranscript(fixture);
  const origin = await listen(t, fixture.directories);
  await writeFile(join(folder, "unreferenced.html"), "PRIVATE");
  assert.equal((await fetch(`${origin}/preview/transcripts/unreferenced.html`)).status, 404);
  await rm(join(folder, "sample.html"));
  await assert.rejects(loadPreview(fixture.directories));
  const outside = join(fixture.root, "private.html");
  await writeFile(outside, "PRIVATE");
  await symlink(outside, join(folder, "sample.html"));
  await assert.rejects(loadPreview(fixture.directories));
  const response = await fetch(`${origin}/preview/transcripts/sample.html`);
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /PRIVATE|private.html/);
});

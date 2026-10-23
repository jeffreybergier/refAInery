import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, executionStages, tokenPoints } from "../source/public/preview.js";

const task = (id, stage, status, startedAt, endedAt = null) => ({ id, stage, status, startedAt, endedAt });

test("execution history keeps parallel groups together and current work at the right", () => {
  const stages = executionStages([
    task("running", 2, "running", "2026-10-23T13:10:00Z"),
    task("queued", 3, "queued", null),
    task("cancelled", 3, "cancelled", null),
    task("parallel-b", 1, "completed", "2026-10-23T13:02:00Z"),
    task("first", 0, "completed", "2026-10-23T13:00:00Z"),
    task("parallel-a", 1, "failed", "2026-10-23T13:01:00Z"),
  ]);
  assert.deepEqual(stages.map((stage) => stage.stage), [0, 1, 2]);
  assert.equal(stages.at(-1).current, true);
  assert.deepEqual(stages[1].tasks.map((task) => task.id), ["parallel-a", "parallel-b"]);
  assert.equal(stages.flatMap((stage) => stage.tasks).length, 4);
});

test("running groups stay on the right even when another group finished later", () => {
  const stages = executionStages([
    task("running", 0, "running", "2026-10-23T13:00:00Z"),
    task("later", 1, "completed", "2026-10-23T13:10:00Z"),
  ]);
  assert.deepEqual(stages.map((stage) => stage.stage), [1, 0]);
});

test("durations use the frozen snapshot, not the viewer's clock", () => {
  assert.equal(duration(task("running", 0, "running", "2026-10-23T13:20:00Z"), "2026-10-23T13:30:00Z"), "10m 0s elapsed");
  assert.equal(duration(task("done", 0, "completed", "2026-10-23T13:20:00Z", "2026-10-23T13:22:04Z"), "2026-10-23T14:00:00Z"), "2m 4s");
  assert.equal(duration(task("queued", 0, "queued", null), "2026-10-23T13:30:00Z"), "Not started");
});

test("token chart uses actual time spacing and handles empty, single, and zero samples", () => {
  const samples = [
    { at: "2026-10-23T13:00:00Z", input: 100, output: 20 },
    { at: "2026-10-23T13:10:00Z", input: 50, output: 10 },
    { at: "2026-10-23T13:40:00Z", input: 0, output: 0 },
  ];
  assert.equal(tokenPoints(samples, "input", 100), "55,35 205,115 655,195");
  assert.equal(tokenPoints([], "input", 0), "");
  assert.equal(tokenPoints([samples[2]], "input", 0), "355,195");
});

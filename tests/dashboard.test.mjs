import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, tokenPoints } from "../source/public/preview.js";
import { timelineLayout } from "../source/public/floor.js";

const task = (id, stage, status, startedAt, endedAt = null) => ({ id, stage, status, startedAt, endedAt });

const at = (minute) => `2026-10-23T13:${String(minute).padStart(2, "0")}:00Z`;

test("timeline uses one actual-time scale across jobs and excludes unstarted tasks", () => {
  const runs = [{ id: "one", tasks: [
    task("running", 99, "running", at(10)),
    task("queued", 0, "queued", null),
    task("cancelled", 0, "cancelled", null),
    task("first", 2, "completed", at(0), at(5)),
  ] }, { id: "two", tasks: [task("parallel", 0, "completed", at(10), at(15))] }];
  const before = JSON.stringify(runs);
  const result = timelineLayout(runs, at(20));
  assert.equal(result.start, Date.parse(at(0)));
  assert.equal(result.end, Date.parse(at(20)));
  assert.deepEqual(result.runs[0].executions.map((item) => item.task.id), ["first", "running"]);
  assert.equal(result.runs[0].executions[1].left, .5);
  assert.equal(result.runs[0].executions[1].width, .5);
  assert.equal(result.runs[1].executions[0].left, .5);
  assert.equal(result.runs[1].executions[0].width, .25);
  assert.equal(JSON.stringify(runs), before);
});

test("overlap packing follows timestamps, reuses ended slots, and counts overflow", () => {
  const tasks = [0, 1, 2, 3].map((index) => task(`parallel-${index}`, index, "completed", at(0), at(10)));
  tasks.push(task("after", 0, "running", at(10)));
  const { executions, hidden } = timelineLayout([{ tasks }], at(20)).runs[0];
  assert.deepEqual(executions.map((item) => item.row), [0, 1, 2, 3, 0]);
  assert.equal(hidden, 1);
  assert.equal(executions.length, 5); // Overflow remains available in the inspector.
});

test("empty, queued-only, instantaneous and snapshot-started executions have finite positions", () => {
  assert.deepEqual(timelineLayout([], at(20)).runs, []);
  const result = timelineLayout([{ tasks: [task("q", 0, "queued", null)] },
    { tasks: [task("instant", 0, "completed", at(20), at(20)), task("live", 0, "running", at(20))] }], at(20));
  assert.equal(result.end - result.start, 60000);
  assert.deepEqual(result.runs[0].executions, []);
  assert.deepEqual(result.runs[1].executions.map(({ row, left, width }) => ({ row, left, width })),
    [{ row: 0, left: 1, width: 0 }, { row: 1, left: 1, width: 0 }]);
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

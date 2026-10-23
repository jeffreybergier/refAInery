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
    fixtureVersion: 1, environment: "test",
    runs: [{ id: "run-1", title: "Fictional run", summary: "Example", status: "running",
      tasks: [{ id: "task-1", title: "Review", agentId: "reviewer", status: "queued" }] }],
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

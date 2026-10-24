import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createAppServer } from "../source/server.ts";
import { loadIntakePreview, validateRequestFixtures } from "../source/intake-preview.ts";
import { orderedRequests } from "../source/public/intake.js";

// V1 is independent of the v2 fixture/configuration directories.
const server = createAppServer({ config: "/missing/test", storage: "/missing/test" });
let origin;
before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve, reject) => {
  server.close((error) => error ? reject(error) : resolve());
  server.closeAllConnections();
}));

test("root and trailing slash redirects preserve explicit version routes", async () => {
  for (const method of ["GET", "HEAD"]) {
    for (const [path, location] of [["/", "/v1"], ["/?test=1", "/v1"],
      ["/v1/", "/v1"], ["/v2/", "/v2"]]) {
      const response = await fetch(origin + path, { method, redirect: "manual" });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), location);
      assert.equal(await response.text(), "");
    }
  }
  for (const version of ["v1", "v2"]) {
    const response = await fetch(`${origin}/${version}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), new RegExp(`href="/${version === "v1" ? "v2" : "v1"}"`));
  }
});

test("v1 page has intake and explicit placeholders, not fabricated executions", async () => {
  const response = await fetch(origin);
  assert.equal(response.url, `${origin}/v1`);
  const page = await response.text();
  for (const text of ["Request intake", "not queue depth", "Subagent outcomes",
    "Tokens over time", "Execution timeline unavailable", "Execution inspector unavailable",
    "Factory Specification"]) assert.ok(page.includes(text), text);
  assert.doesNotMatch(page, /src="\/assets\/(preview|floor)\.js"/);
  for (const [, path] of page.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)) {
    assert.equal((await fetch(origin + path)).status, 200);
  }
});

test("v1 API supplies only compliant request records and works without v2 data", async () => {
  const response = await fetch(`${origin}/api/v1/preview`);
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.mode, "test");
  assert.deepEqual(Object.keys(data).sort(), ["mode", "requests"]);
  assert.deepEqual(data, await loadIntakePreview());
  assert.equal((await fetch(`${origin}/api/preview`)).status, 503);
  const head = await fetch(`${origin}/api/v1/preview`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${origin}/api/v1/preview`, { method: "POST" })).status, 405);
  // Fixture storage is not a public filesystem route.
  assert.equal((await fetch(`${origin}/source/fixtures/requests-v1.json`)).status, 404);
});

test("bundled records satisfy every constraint of the checked-in request schema", async () => {
  const schema = JSON.parse(await readFile(new URL(
    "../schemas/storage/v1/request.schema.json", import.meta.url), "utf8"));
  const { requests } = await loadIntakePreview();
  assert.ok(requests.length > 0);
  assert.equal(schema.additionalProperties, false);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), schema.required.slice().sort());
    for (const [field, rule] of Object.entries(schema.properties)) {
      const value = request[field];
      if (rule.type === "integer") assert.ok(Number.isInteger(value));
      else assert.equal(typeof value, rule.type);
      if (rule.const !== undefined) assert.equal(value, rule.const);
      if (rule.enum) assert.ok(rule.enum.includes(value));
      if (rule.minLength) assert.ok(value.length >= rule.minLength);
      if (rule.maxLength) assert.ok(value.length <= rule.maxLength);
      if (rule.pattern) assert.match(value, new RegExp(rule.pattern));
      if (rule.format === "date-time") {
        assert.ok(Number.isFinite(Date.parse(value)));
        assert.equal(new Date(value).toISOString().slice(0, 19), value.slice(0, 19));
      }
    }
  }
  assert.equal(new Set(requests.map((r) => r.id)).size, requests.length);
});

test("fixture validation rejects extra state, malformed intake, dates, and duplicate IDs", async () => {
  const { requests: [valid] } = await loadIntakePreview();
  for (const patch of [{ status: "queued" }, { schemaVersion: 2 }, { source: "github" },
    { prompt: " \n " }, { id: "../escape" }, { id: "a".repeat(129) },
    { receivedAt: "2026-02-30T00:00:00Z" }, { receivedAt: "2026-10-24T14:00:00+00:00" },
    { receivedAt: "2026-10-24T25:00:00Z" }, { prompt: null }]) {
    assert.throws(() => validateRequestFixtures([{ ...valid, ...patch }]));
  }
  for (const field of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[field];
    assert.throws(() => validateRequestFixtures([missing]));
  }
  assert.throws(() => validateRequestFixtures([valid, valid]));
  assert.throws(() => validateRequestFixtures({ requests: [] }));
  assert.deepEqual(validateRequestFixtures([]), []);
  const prompt = "  <script>alert('not HTML')</script>\n\nPreserve spacing.  ";
  assert.equal(validateRequestFixtures([{ ...valid, prompt }])[0].prompt, prompt);
});

test("receipt browsing sorts by actual time without mutating records or inventing state", () => {
  const requests = [
    { id: "later", receivedAt: "2026-10-24T14:00:00.125Z" },
    { id: "earlier", receivedAt: "2026-10-24T14:00:00Z" },
  ];
  const before = JSON.stringify(requests);
  assert.deepEqual(orderedRequests(requests).map((r) => r.id), ["earlier", "later"]);
  assert.equal(JSON.stringify(requests), before);
});

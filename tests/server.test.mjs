import assert from "node:assert/strict";
import { once } from "node:events";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { createAppServer } from "../source/server.ts";

const server = createAppServer();
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

test("control room uses dark Bootstrap and orders operations, floor, and configuration", async () => {
  const response = await fetch(origin);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const page = await response.text();
  assert.match(page, /data-bs-theme="dark"/);
  assert.match(page, /Factory Operations/);
  assert.match(page, /Factory Floor/);
  assert.match(page, /Factory Specification/);
  assert.doesNotMatch(page, /Factory Configuration/);
  assert.match(page, /No agents or real work are running/);
  assert.ok(page.indexOf('section id="operations"') < page.indexOf('section id="factory-floor"'));
  assert.ok(page.indexOf('section id="factory-floor"') < page.indexOf('section id="configuration"'));
  assert.doesNotMatch(page, /Hello, world|Bring an idea|Watch the work|Review the output/);
  assert.match(page, /Tokens over time/);
  assert.match(page, /Subagent outcomes/);
  const specification = page.match(/<section id="configuration"[\s\S]*?<\/section>/)?.[0];
  assert.ok(specification);
  assert.match(specification, /<h2[^>]*>Factory Specification/);
  assert.doesNotMatch(specification, /<details|<summary|\bhidden\b|data-bs-toggle/);
  assert.match(page, /href="#configuration">Specification<\/a>/);
  assert.match(page, /Skip to content/);
  assert.match(page, /aria-controls="navigation"/);
  assert.doesNotMatch(page, /(?:src|href)="https?:\/\//);
  for (const [, asset] of page.matchAll(/(?:src|href)="(\/assets\/[^"#]+)"/g)) {
    assert.equal((await fetch(`${origin}${asset}`)).status, 200, asset);
  }
});

test("serves local styles and Bootstrap JavaScript with correct types", async () => {
  for (const [path, type, content] of [
    ["bootstrap.min.css", /text\/css/, /Bootstrap/],
    ["bootstrap.bundle.min.js", /text\/javascript/, /Bootstrap/],
    ["refainery.css", /text\/css/, /--furnace/],
    ["floor.js", /text\/javascript/, /export function mountFloor/],
  ]) {
    const response = await fetch(`${origin}/assets/${path}?v=1`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type"), type);
    assert.match(await response.text(), content);
  }
});

test("HEAD returns asset metadata without a response body", async () => {
  const response = await fetch(origin, { method: "HEAD" });
  assert.equal(response.status, 200);
  assert.ok(Number(response.headers.get("content-length")) > 0);
  assert.equal(await response.text(), "");
});

test("unknown paths and traversal cannot expose application files", async () => {
  for (const path of ["/missing", "/source/server.ts", "/package.json",
    "/.env", "/storage", "/config", "/assets/../../package.json",
    "/assets/%2e%2e/%2e%2e/package.json", "/%", "//example.com/"]) {
    // Raw HTTP preserves traversal paths rather than normalizing them first.
    const status = await new Promise((resolve, reject) => {
      const req = request(origin, { path }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 404, path);
  }
});

test("unsupported methods are rejected", async () => {
  const response = await fetch(origin, { method: "POST", body: "hello" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("security headers restrict the page to local resources", async () => {
  const response = await fetch(origin);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
});

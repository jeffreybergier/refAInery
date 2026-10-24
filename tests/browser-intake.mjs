// Optional Chromium coverage, using the same external Playwright as browser-floor.
import assert from "node:assert/strict";
import { once } from "node:events";
import { pathToFileURL } from "node:url";
import { createAppServer } from "../source/server.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const server = createAppServer({ config: "/unused/test", storage: "/unused/test" });
let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  assert.equal(page.url(), `${origin}/v1`);
  await page.waitForSelector("#request-list article");
  assert.equal(await page.locator("#request-list article").count(), 3);
  assert.equal(await page.locator("#request-count").innerText(), "3");
  assert.ok(await page.locator("#test-notice").isVisible());
  assert.ok((await page.locator(".request-prompt").last().textContent()).startsWith("  Draft"));
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 900 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  const payload = { mode: "test", requests: [{ schemaVersion: 1, id: "safe",
    prompt: "  <img src=x onerror=alert(1)>\nKeep whitespace.  ",
    receivedAt: "2026-10-24T14:00:00Z", source: "manual" }] };
  let status = 200;
  await page.route("**/api/v1/preview", (route) => route.fulfill({ status,
    contentType: "application/json", body: JSON.stringify(payload) }));
  const refresh = async () => {
    await page.locator("#refresh-preview").click();
    await page.waitForFunction(() => !document.querySelector("#refresh-preview").disabled);
  };
  await refresh();
  assert.equal(await page.locator(".request-prompt").textContent(), payload.requests[0].prompt);
  assert.equal(await page.locator("#request-list img").count(), 0);
  status = 503;
  await refresh();
  assert.equal(await page.locator("#request-list article").count(), 0);
  assert.equal(await page.locator("#request-count").textContent(), "—");
  assert.ok(await page.locator("#preview-error").isVisible());
  status = 200;
  payload.requests = [];
  await refresh();
  assert.equal(await page.locator("#request-count").textContent(), "0");
  assert.match(await page.locator("#requests-state").textContent(), /No request fixtures/);
  assert.ok(await page.locator("#preview-error").isHidden());
  payload.mode = "production";
  await refresh();
  assert.equal(await page.locator("#request-count").textContent(), "—");
  assert.ok(await page.locator("#test-notice").isHidden());
  assert.ok(await page.locator("#refresh-preview").isHidden());
  assert.match(await page.locator("#requests-state").textContent(), /Production intake loading is not implemented/);
  assert.deepEqual(errors, []);
  console.log("V1 browser checks passed: redirect, fixtures, whitespace, safe text, mobile, refresh/error/empty/production states.");
} finally {
  await browser?.close();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}

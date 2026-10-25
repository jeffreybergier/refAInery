// Optional Chromium coverage, using the same external Playwright as browser-floor.
import assert from "node:assert/strict";
import { once } from "node:events";
import { chromium } from "playwright-core";
import { createAppServer } from "../source/server.ts";

const server = createAppServer({ config: "/unused/test", storage: "/unused/test" });
let browser;
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  assert.equal(page.url(), `${origin}/v1`);
  await page.waitForSelector(".floor-bar");
  assert.equal(await page.locator("#request-list article").count(), 3);
  assert.equal(await page.locator("#request-count").innerText(), "3");
  assert.equal(await page.locator(".floor-lane").count(), 2);
  assert.equal(await page.locator(".floor-bar").count(), 9);
  assert.ok(await page.locator("#test-notice").isVisible());
  assert.match(await page.locator("#operation-stats").textContent(), /awaiting-review/);
  assert.match(await page.locator("#queue-state").textContent(), /request-demo-003/);
  assert.match(await page.locator("#configuration-models").textContent(), /250,000/);
  assert.match(await page.locator("#outcome-chart").textContent(), /accepted reviews/);
  const refresh = async () => {
    await page.locator("#refresh-preview").click();
    await page.waitForFunction(() => !document.querySelector("#refresh-preview").disabled);
  };
  const inspector = page.locator(".floor-inspector");
  const initialHeight = (await page.locator(".floor-panel").boundingBox()).height;
  const waiting = page.locator(".floor-bar.status-awaiting-review");
  await waiting.focus();
  await page.keyboard.press("Enter");
  assert.equal(await waiting.getAttribute("aria-pressed"), "true");
  assert.match(await inspector.textContent(), /Attempt 2/);
  assert.match(await inspector.textContent(), /Pending/);
  assert.match(await inspector.textContent(), /14:30:00 UTC/);
  assert.match(await inspector.textContent(), /14:30:06 UTC/);
  assert.match(await inspector.textContent(), /not an execution timestamp/);
  await inspector.getByText("Markdown handover · handovers/release.md", { exact: true }).click();
  assert.ok(await inspector.getByText("## Goal", { exact: false }).first().isVisible());
  assert.match(await inspector.locator("a.transcript-link").getAttribute("href"), /exports\/release.html$/);
  await inspector.getByText("Attempt history", { exact: true }).click();
  await inspector.getByRole("button", { name: /Attempt 1 — interrupted/ }).click();
  assert.match(await inspector.textContent(), /No handover recorded/);
  assert.equal(await inspector.locator("a.transcript-link").count(), 0);
  await page.locator(".floor-lane").last().locator(".kind-orchestrator").first().click();
  assert.match(await inspector.textContent(), /only after the overall run ends/);
  assert.equal(await inspector.locator("a.transcript-link").count(), 0);
  await page.locator(".floor-lane").first().locator(".kind-orchestrator").first().click();
  assert.match(await inspector.textContent(), /shared final orchestrator session/);
  const transcript = await inspector.locator("a.transcript-link").getAttribute("href");
  assert.match(transcript, /search-final.html$/);
  await inspector.getByText("Saved checkpoints (3 illustrative snapshots)", { exact: true }).click();
  await inspector.getByText(/000003.json/).click();
  assert.match(await inspector.locator(".checkpoint-history").textContent(), /"contextWindow": 250000/);
  // Selected execution survives fixture refresh, along with zoom/navigation.
  await page.getByRole("button", { name: "Zoom in timeline", exact: true }).click();
  await refresh();
  assert.equal(await page.locator('.floor-bar[aria-pressed="true"]').count(), 1);
  assert.match(await page.locator(".floor-controls").textContent(), /2×/);
  assert.match(await inspector.textContent(), /shared final orchestrator session/);
  assert.equal((await page.locator(".floor-panel").boundingBox()).height, initialHeight);
  await page.locator(".floor-job-button").last().click();
  await inspector.getByRole("button", { name: /Check terminology after review.*not started/ }).click();
  assert.match(await inspector.textContent(), /no attempt dispatched/i);
  assert.match(await inspector.textContent(), /Not started/);
  for (const width of [1280, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  const original = await (await fetch(origin + "/api/v1/preview")).json();
  let payload = structuredClone(original);
  let status = 200;
  payload.requests[2].prompt = "  <img src=x onerror=alert(1)>\nKeep whitespace.  ";
  await page.route("**/api/v1/preview", (route) => route.fulfill({ status,
    contentType: "application/json", body: JSON.stringify(payload) }));
  await refresh();
  assert.equal(await page.locator("#request-list .request-prompt").last().textContent(), payload.requests[2].prompt);
  assert.equal(await page.locator("#request-list img").count(), 0);
  assert.equal(await page.locator(".floor-lane").count(), 2);
  status = 503;
  await refresh();
  for (const selector of ["#request-list article", ".floor-bar", "#configuration-models article", "#operation-stats article"]) {
    assert.equal(await page.locator(selector).count(), 0);
  }
  assert.equal(await page.locator("#request-count").textContent(), "—");
  assert.ok(await page.locator("#preview-error").isVisible());
  status = 200;
  payload = { mode: "test", asOf: original.asOf, requests: [], runs: [], queue: [], documents: [] };
  await refresh();
  assert.equal(await page.locator("#request-count").textContent(), "0");
  assert.match(await page.locator("#requests-state").textContent(), /No request fixtures/);
  assert.match(await page.locator("#floor-empty").textContent(), /No runs/);
  assert.match(await page.locator("#outcome-chart").textContent(), /no decisions yet/);
  assert.ok(await page.locator("#preview-error").isHidden());
  payload = { mode: "production" };
  await refresh();
  assert.equal(await page.locator("#request-count").textContent(), "—");
  assert.ok(await page.locator("#test-notice").isHidden());
  assert.ok(await page.locator("#refresh-preview").isHidden());
  assert.match(await page.locator("#requests-state").textContent(), /No saved workflow is connected/);
  assert.deepEqual(errors, []);
  console.log("V1 browser checks passed: timeline, keyboard selection, attempts, handovers, checkpoints, exports, frozen models, refresh/zoom, mobile, safe prompts, and empty/error/production states.");
} finally {
  await browser?.close();
  await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
}

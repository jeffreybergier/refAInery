// Optional real-browser regression check; no browser dependency in the app.
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser-floor.mjs
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAppServer } from "../source/server.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE
  ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : "playwright");
const root = await realpath(await mkdtemp(join(tmpdir(), "refainery-browser-")));
const directories = { config: join(root, "config/test"), storage: join(root, "storage/test") };
let browser;
let server;
try {
  for (const directory of Object.values(directories)) await mkdir(directory, { recursive: true });
  await writeFile(join(directories.config, "config.json"), JSON.stringify({
    fixtureVersion: 1, environment: "test", workshopName: "Browser fixture",
    agents: [{ id: "agent", name: "Sample agent", role: "Fictional work" }],
  }));
  const task = (index) => ({ id: `task-${index}`, title: `Execution ${index}`, agentId: "agent",
    kind: index === 0 ? "orchestrator" : "subagent", stage: index, status: "running",
    startedAt: "2026-10-23T13:00:00Z", endedAt: null, transcriptId: null });
  const storage = { fixtureVersion: 2, environment: "test",
    operations: { state: "running", asOf: "2026-10-23T13:30:00Z", tokenUsage: [] },
    runs: Array.from({ length: 10 }, (_, index) => ({ id: `run-${index}`, title: `Job ${index}`,
      summary: "Example job", status: "running", tasks: [0, 1, 2, 3, 4].map(task) })),
  };
  storage.runs[0].tasks.push({ ...task(5), status: "queued", startedAt: null });
  storage.runs[1].tasks[0] = { ...task(0), status: "completed",
    endedAt: "2026-10-23T13:10:00Z", transcriptId: "sample" };
  for (const [index, status] of ["failed", "awaiting-review", "cancelled"].entries()) {
    storage.runs[index + 2].tasks[0] = { ...task(0), status,
      endedAt: "2026-10-23T13:10:00Z" };
  }
  await mkdir(join(directories.storage, "transcripts"));
  await writeFile(join(directories.storage, "transcripts/sample.html"), "<h1>TEST transcript</h1>");
  const save = () => writeFile(join(directories.storage, "workshop.json"), JSON.stringify(storage));
  await save();
  server = createAppServer(directories);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector(".floor-bar");
  assert.equal(await page.locator(".floor-lane").count(), 10);
  assert.equal(await page.locator(".floor-bar").count(), 30);
  const height = async () => (await page.locator(".floor-panel").boundingBox()).height;
  const initialHeight = await height();
  const normalFill = "rgb(41, 44, 48)";
  const selectedFill = "rgb(200, 229, 255)";
  const style = (bar) => bar.evaluate((el) => {
    const css = getComputedStyle(el);
    return { fill: css.backgroundColor, shadow: css.boxShadow,
      top: css.borderTopStyle, topWidth: css.borderTopWidth,
      right: css.borderRightStyle, rightWidth: css.borderRightWidth };
  });
  const assertSelected = async (bar) => {
    assert.equal(await page.locator('.floor-bar[aria-pressed="true"]').count(), 1);
    assert.equal(await bar.getAttribute("aria-pressed"), "true");
    const selectedStyle = await style(bar);
    assert.equal(selectedStyle.fill, selectedFill);
    assert.notEqual(selectedStyle.shadow, "none");
  };
  // Verify computed appearance, not just ARIA: shared badge CSS previously
  // leaked transparent fills, and Bootstrap removed the mouse-selection outline.
  for (const bar of await page.locator(".floor-bar").all()) {
    assert.deepEqual(await style(bar), { fill: normalFill, shadow: "none",
      top: "solid", topWidth: "1px", right: "solid", rightWidth: "1px" });
  }
  for (const status of ["completed", "failed", "awaiting-review", "cancelled"]) {
    const bar = page.locator(`.floor-bar.status-${status}`);
    await bar.click();
    await assertSelected(bar);
    assert.match(await page.locator(".floor-inspector").innerText(), /Execution 0/);
  }
  await page.locator(".floor-bar").first().click();
  await assertSelected(page.locator(".floor-bar").first());
  await page.locator(".floor-inspector").click(); // Selection survives blur.
  await assertSelected(page.locator(".floor-bar").first());
  await page.locator(".floor-bar").first().focus();
  await page.keyboard.press("Tab"); // Focus and selection are independent.
  await assertSelected(page.locator(".floor-bar").first());
  assert.equal(await page.locator(".floor-bar").nth(1).evaluate((el) =>
    el === document.activeElement && el.matches(":focus-visible")), true);
  assert.equal((await style(page.locator(".floor-bar").nth(1))).fill, normalFill);
  assert.match(await page.locator(".floor-inspector").innerText(), /Execution 0/);
  assert.equal(await page.locator('.floor-bar[aria-pressed="true"]').count(), 1);
  await page.getByRole("button", { name: "Refresh fixtures" }).click();
  await page.waitForSelector('.floor-bar[aria-pressed="true"]');
  assert.match(await page.locator(".floor-inspector").innerText(), /Execution 0/);
  await assertSelected(page.locator(".floor-bar").first());
  await page.locator(".floor-job-button").first().click();
  assert.equal(await page.locator('.floor-bar[aria-pressed="true"]').count(), 0);
  assert.equal((await style(page.locator(".floor-bar").first())).fill, normalFill);
  assert.match(await page.locator(".floor-job-button").first().innerText(), /2 overflow/);
  await page.getByRole("button", { name: /subagent: Execution 4/ }).click();
  assert.match(await page.locator(".floor-inspector").innerText(), /Execution 4/);
  await page.getByRole("button", { name: "All job executions / pending tasks" }).click();
  await page.getByRole("button", { name: /Execution 5.*not started/ }).click();
  assert.match(await page.locator(".floor-inspector").innerText(), /Not started/);
  await page.locator(".floor-bar").nth(1).focus();
  await page.keyboard.press("Enter");
  assert.match(await page.locator(".floor-inspector").innerText(), /Execution 1/);
  await assertSelected(page.locator(".floor-bar").nth(1));
  assert.equal(await height(), initialHeight);
  await page.locator(".floor-bar.status-completed").click();
  await assertSelected(page.locator(".floor-bar.status-completed"));
  assert.equal((await style(page.locator(".floor-bar").nth(1))).fill, normalFill);
  const transcript = page.locator(".floor-inspector .transcript-link");
  assert.equal(await transcript.getAttribute("href"), "/preview/transcripts/sample.html");
  assert.equal(await transcript.getAttribute("target"), "_blank");
  await page.getByRole("button", { name: "Zoom in timeline" }).click();
  await page.getByRole("button", { name: "← Earlier" }).click();
  assert.equal(await page.getByRole("button", { name: "Follow latest" }).getAttribute("aria-pressed"), "false");
  await page.locator(".floor-viewport").evaluate((el) => { el.scrollTop = 220; });
  await page.waitForTimeout(100);
  const position = await page.locator(".floor-viewport").evaluate((el) => [el.scrollLeft, el.scrollTop]);
  await page.getByRole("button", { name: "Refresh fixtures" }).click();
  await page.waitForSelector('.floor-bar[aria-pressed="true"]');
  assert.deepEqual(await page.locator(".floor-viewport").evaluate((el) => [el.scrollLeft, el.scrollTop]), position);
  await page.getByRole("button", { name: "Follow latest" }).click();
  assert.equal(await page.locator(".floor-viewport").evaluate((el) => Math.abs(el.scrollWidth - el.clientWidth - el.scrollLeft) < 2), true);
  storage.runs.push({ ...storage.runs[1], id: "extra" });
  await save();
  await page.getByRole("button", { name: "Refresh fixtures" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".floor-lane").length === 11);
  assert.equal(await height(), initialHeight);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal((await page.locator(".floor-viewport").boundingBox()).height, 380);
  await page.locator(".floor-panel").screenshot({ path: join(root, "mobile.png") });
  storage.runs.splice(1, 1);
  await save();
  await page.getByRole("button", { name: "Refresh fixtures" }).click();
  await page.waitForFunction(() => document.querySelector(".floor-inspector").textContent.includes("no longer"));
  assert.equal(await page.locator(".floor-inspector .execution-card").count(), 0);
  storage.runs = [];
  storage.operations.state = "idle";
  await save();
  await page.getByRole("button", { name: "Refresh fixtures" }).click();
  await page.waitForFunction(() => document.querySelector("#floor-runs").childElementCount === 0);
  assert.match(await page.locator("#floor-empty").innerText(), /No runs/);
  await writeFile(join(directories.storage, "workshop.json"), "invalid");
  await page.getByRole("button", { name: "Refresh fixtures" }).click();
  await page.waitForSelector("#preview-error", { state: "visible" });
  // The invalid-fixture request intentionally returns 503.
  assert.deepEqual(errors.filter((error) => !error.includes("503")), []);
  console.log("Browser checks passed: selection, keyboard, overflow, pending, zoom, follow, refresh, fixed height, mobile, empty/error states.");
} finally {
  await browser?.close();
  if (server) await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
  await rm(root, { recursive: true, force: true });
}

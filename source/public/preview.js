import { mountFloor, disposeFloor } from "./floor.js";

const labels = {
  running: "Running", queued: "Queued", "awaiting-review": "Awaiting review",
  completed: "Succeeded", failed: "Failed", cancelled: "Cancelled",
};
const number = (value) => value.toLocaleString("en-US");
const clock = (value) => value.slice(11, 16);

// Pure presentation helpers are also exercised by offline tests.
export function duration(task, asOf) {
  if (!task.startedAt) return "Not started";
  const seconds = Math.max(0, Math.floor((Date.parse(task.endedAt ?? asOf) - Date.parse(task.startedAt)) / 1000));
  const minutes = Math.floor(seconds / 60);
  const value = minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` :
    minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
  return task.status === "running" ? `${value} elapsed` : value;
}

export function tokenPoints(samples, field, maximum) {
  if (!samples.length) return "";
  const first = Date.parse(samples[0].at);
  const span = Date.parse(samples.at(-1).at) - first;
  return samples.map((sample) => {
    const x = span ? 55 + (Date.parse(sample.at) - first) / span * 600 : 355;
    const y = 195 - sample[field] / Math.max(1, maximum) * 160;
    return `${x},${y}`;
  }).join(" ");
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function svgElement(tag, attributes = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function badge(status) {
  return element("span", `execution-status status-${status}`, labels[status]);
}

function renderStats(operations) {
  const stats = document.querySelector("#operation-stats");
  const stateColumn = element("div", "col-12 col-md-4");
  const stateCard = element("div", "panel state-panel h-100 p-4");
  stateCard.append(element("p", "eyebrow mb-3", "Factory state · simulated"));
  const state = element("p", `factory-state state-${operations.state} mb-2`);
  state.append(element("span", "status-light"),
    document.createTextNode(operations.state[0].toUpperCase() + operations.state.slice(1)));
  stateCard.append(state, element("p", "small text-body-secondary mb-0", {
    running: "Executions in flight in this sample.",
    idle: "Ready, with no executions in flight.",
    stopped: "Factory stopped in this sample.",
  }[operations.state]));
  stateColumn.append(stateCard);
  stats.replaceChildren(stateColumn);
  for (const [key, label] of [["active", "Active agents"], ["queued", "Queued tasks"],
    ["completed", "Succeeded"], ["failed", "Failed"]]) {
    const column = element("div", "col-6 col-md-2");
    const card = element("div", "panel metric-card h-100 p-4");
    card.append(element("p", "eyebrow mb-3", label),
      element("p", `metric-value mb-1 metric-${key}`, number(operations.counts[key])),
      element("p", "metric-note mb-0", key === "active" ? "executions" : "tasks"));
    column.append(card);
    stats.append(column);
  }
}

function renderOutcomes(outcomes) {
  const total = outcomes.succeeded + outcomes.failed;
  const rate = total ? Math.round(outcomes.succeeded / total * 100) : null;
  const chart = svgElement("svg", {
    viewBox: "0 0 240 165", class: "outcome-svg", role: "img",
    "aria-label": `Subagent outcomes: ${outcomes.succeeded} succeeded, ${outcomes.failed} failed. ${rate === null ? "No results yet" : `${rate}% success rate`}.`,
  });
  const circumference = 2 * Math.PI * 56;
  chart.append(svgElement("circle", { cx: 120, cy: 78, r: 56, class: "ring-background" }));
  let offset = 0;
  for (const [count, color] of [[outcomes.succeeded, "#8ad0ab"], [outcomes.failed, "#f3998d"]]) {
    if (total && count) chart.append(svgElement("circle", {
      cx: 120, cy: 78, r: 56, fill: "none", stroke: color, "stroke-width": 12,
      "stroke-dasharray": `${count / total * circumference} ${circumference}`,
      "stroke-dashoffset": -offset, transform: "rotate(-90 120 78)",
    }));
    offset += total ? count / total * circumference : 0;
  }
  chart.append(svgElement("text", { x: 120, y: 80, "text-anchor": "middle", class: "ring-value" }, rate === null ? "—" : `${rate}%`),
    svgElement("text", { x: 120, y: 101, "text-anchor": "middle", class: "chart-label" }, total ? "success rate" : "no results yet"));
  const legend = element("div", "d-flex justify-content-center gap-4 small mb-3");
  legend.append(element("span", "success-text", `${outcomes.succeeded} succeeded`),
    element("span", "failure-text", `${outcomes.failed} failed`));
  document.querySelector("#outcome-chart").replaceChildren(chart, legend);
  document.querySelector("#outcome-note").textContent =
    `Across sample runs. Orchestrators and ${outcomes.other} non-terminal or cancelled subagent tasks excluded from the rate.`;
}

function renderTokens(samples) {
  const container = document.querySelector("#token-chart");
  const table = document.querySelector("#token-table");
  table.replaceChildren();
  const totals = samples.reduce((totals, sample) => ({ input: totals.input + sample.input, output: totals.output + sample.output }), { input: 0, output: 0 });
  document.querySelector("#token-total").textContent = `${number(totals.input)} in / ${number(totals.output)} out`;
  if (!samples.length) {
    container.replaceChildren(element("p", "chart-empty", "No token samples in this snapshot."));
    return;
  }
  const largest = Math.max(4, ...samples.flatMap((sample) => [sample.input, sample.output]));
  const magnitude = 10 ** Math.floor(Math.log10(largest / 4));
  const step = [1, 2, 5, 10].find((step) => step * magnitude >= largest / 4) * magnitude;
  const maximum = step * 4;
  const chart = svgElement("svg", {
    viewBox: "0 0 680 235", class: "token-svg", role: "img",
    "aria-label": `Input and output tokens over time, ${clock(samples[0].at)} to ${clock(samples.at(-1).at)} UTC. Full values in the table below.`,
  });
  for (let tick = 0; tick <= 4; tick++) {
    const y = 195 - tick * 40;
    chart.append(svgElement("line", { x1: 55, x2: 655, y1: y, y2: y, class: "chart-grid" }),
      svgElement("text", { x: 50, y: y + 4, "text-anchor": "end", class: "chart-label" },
        new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(maximum * tick / 4)));
  }
  for (const field of ["input", "output"]) {
    const points = tokenPoints(samples, field, maximum);
    chart.append(svgElement("polyline", { points, class: `token-line token-${field}` }));
    for (const point of points.split(" ")) {
      const [cx, cy] = point.split(",");
      chart.append(svgElement("circle", { cx, cy, r: 3.5, class: `token-dot dot-${field}` }));
    }
  }
  const tickIndices = [...new Set([0, Math.floor((samples.length - 1) / 2), samples.length - 1])];
  for (const index of tickIndices) {
    const [x] = tokenPoints(samples, "input", maximum).split(" ")[index].split(",");
    const anchor = samples.length === 1 ? "middle" : index === 0 ? "start" : index === samples.length - 1 ? "end" : "middle";
    chart.append(svgElement("text", { x, y: 222, "text-anchor": anchor, class: "chart-label" }, `${clock(samples[index].at)} UTC`));
  }
  container.replaceChildren(chart);
  for (const sample of samples) {
    const row = document.createElement("tr");
    row.append(element("td", "", sample.at.replace("T", " ").replace("Z", "")),
      element("td", "", number(sample.input)), element("td", "", number(sample.output)));
    table.append(row);
  }
}

function taskCard(task, agents, asOf) {
  const agent = agents.find((agent) => agent.id === task.agentId);
  const card = element("article", `execution-card ${task.status === "running" ? "is-running" : ""}`);
  const header = element("div", "d-flex justify-content-between align-items-center gap-2 mb-3");
  header.append(element("span", "eyebrow mb-0", task.kind), badge(task.status));
  card.append(header, element("h4", "h6 mb-1", agent.name),
    element("p", "small text-body-secondary mb-3", agent.role),
    element("p", "task-title mb-3", task.title));
  const formatTime = (value) => value.replace("T", " ").replace("Z", " UTC");
  const timing = task.startedAt
    ? `${formatTime(task.startedAt)} → ${task.endedAt ? formatTime(task.endedAt) : "In flight"} · ${duration(task, asOf)}`
    : "Not started";
  card.append(element("p", "execution-time mb-3", timing));
  if (task.transcriptUrl) {
    const link = element("a", "transcript-link", "View sample transcript ↗");
    link.href = task.transcriptUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    card.append(link);
  } else {
    card.append(element("span", "small text-body-secondary", task.status === "running" ? "Transcript after execution" : "No transcript available"));
  }
  return card;
}

function renderFloor(preview) {
  document.querySelector("#floor-empty").hidden = preview.runs.length > 0;
  document.querySelector("#floor-empty").textContent = "No runs in this snapshot.";
  mountFloor(preview, document.querySelector("#floor-runs"), taskCard);
}

function renderConfiguration(preview) {
  document.querySelector("#configuration-name").textContent = preview.workshopName;
  const agents = document.querySelector("#configuration-agents");
  agents.replaceChildren();
  for (const agent of preview.agents) {
    const column = element("div", "col-md-4");
    const card = element("div", "config-agent h-100 p-3");
    card.append(element("p", "eyebrow mb-2", agent.id), element("h3", "h6", agent.name),
      element("p", "small text-body-secondary mb-0", agent.role));
    column.append(card);
    agents.append(column);
  }
}

async function showPreview() {
  const refresh = document.querySelector("#refresh-preview");
  refresh.disabled = true;
  try {
    const response = await fetch("/api/preview");
    if (!response.ok) throw new Error("Preview unavailable");
    const preview = await response.json();
    if (preview.mode !== "test") return;
    document.querySelector(".environment-label").textContent = "TEST · Fake data";
    document.querySelector("#test-notice").hidden = false;
    document.querySelector("#preview-error").hidden = true;
    document.querySelector("#operations-empty").hidden = true;
    document.querySelector("#operations-data").hidden = false;
    document.querySelector("#snapshot-time").textContent = `Sample snapshot · ${preview.operations.asOf.replace("T", " ").replace("Z", " UTC")}`;
    renderStats(preview.operations);
    renderOutcomes(preview.operations.outcomes);
    renderTokens(preview.operations.tokenUsage);
    renderFloor(preview);
    renderConfiguration(preview);
    refresh.hidden = false;
  } catch {
    // Never leave apparently healthy but stale metrics on screen after a bad edit.
    disposeFloor();
    document.querySelector("#operations-data").hidden = true;
    document.querySelector("#floor-runs").replaceChildren();
    document.querySelector("#configuration-agents").replaceChildren();
    document.querySelector("#configuration-name").textContent = "Configuration unavailable.";
    document.querySelector("#snapshot-time").textContent = "Snapshot unavailable";
    for (const selector of ["#operations-empty", "#floor-empty"]) {
      const node = document.querySelector(selector);
      node.hidden = false;
      node.textContent = "Fixture data unavailable. No production fallback was attempted.";
    }
    const error = document.querySelector("#preview-error");
    error.textContent = "Preview data could not be loaded. Check the server and test JSON files, then refresh.";
    error.hidden = false;
    refresh.hidden = false;
  } finally {
    refresh.disabled = false;
  }
}

if (typeof document !== "undefined") {
  document.querySelector("#refresh-preview").addEventListener("click", showPreview);
  showPreview();
}

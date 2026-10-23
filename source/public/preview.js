// Fixture strings are text, never HTML. There are no action or write endpoints.
function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

async function showPreview() {
  try {
    const response = await fetch("/api/preview");
    if (!response.ok) throw new Error("Preview unavailable");
    const preview = await response.json();
    if (preview.mode !== "test") return;
    document.querySelector(".environment-label").textContent = "TEST · Fake data";
    document.querySelector("#test-title").textContent = preview.workshopName;
    const agents = document.querySelector("#test-agents");
    for (const agent of preview.agents) {
      agents.append(element("span", "environment-label", `${agent.name} / ${agent.role}`));
    }
    const runs = document.querySelector("#test-runs");
    for (const run of preview.runs) {
      const column = element("div", "col-lg-6");
      const card = element("article", "card station-card h-100");
      const body = element("div", "card-body p-4");
      const heading = element("div", "d-flex flex-wrap justify-content-between gap-2 mb-3");
      heading.append(element("span", "station-number", run.id));
      heading.append(element("span", "preview-badge", `Simulated: ${run.status.replaceAll("-", " ")}`));
      body.append(heading, element("h3", "h5", run.title),
        element("p", "text-body-secondary", run.summary));
      const tasks = element("ul", "list-unstyled mb-0");
      for (const task of run.tasks) {
        const agent = preview.agents.find((item) => item.id === task.agentId);
        const row = element("li", "border-top py-2 small");
        row.append(element("div", "", task.title),
          element("div", "text-body-secondary", `${agent.name} · ${task.status.replaceAll("-", " ")}`));
        tasks.append(row);
      }
      body.append(tasks);
      card.append(body);
      column.append(card);
      runs.append(column);
    }
    document.querySelector("#test-workshop").hidden = false;
    const link = document.querySelector(".btn-furnace");
    link.href = "#test-workshop";
    link.textContent = "Explore the test factory ↘";
  } catch {
    const error = document.querySelector("#preview-error");
    error.textContent = "Preview data could not be loaded. Check the server and test JSON files, then refresh.";
    error.hidden = false;
  }
}

showPreview();

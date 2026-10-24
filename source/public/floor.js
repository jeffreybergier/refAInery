// Execution lifetimes, not CPU activity. All positions share a wall-clock axis.
export function timelineLayout(runs, asOf) {
  const end = Date.parse(asOf);
  const start = runs.reduce((earliest, run) => run.tasks.reduce((time, task) =>
    task.startedAt ? Math.min(time, Date.parse(task.startedAt)) : time, earliest), end - 60000);
  return { start, end, runs: runs.map((run) => {
    const occupied = [];
    const executions = run.tasks.filter((task) => task.startedAt)
      .slice().sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id))
      .map((task) => {
        const from = Date.parse(task.startedAt);
        const to = Date.parse(task.endedAt ?? asOf);
        let row = occupied.findIndex((until) => until <= from);
        if (row < 0) row = occupied.length;
        // Give instantaneous events their own slot when starts coincide.
        occupied[row] = Math.max(to, from + 1);
        return { task, row, left: (from - start) / (end - start),
          width: (to - from) / (end - start) };
      });
    return { run, executions, hidden: executions.filter((item) => item.row >= 3).length };
  }) };
}

const statusIcons = {
  running: "▶", completed: "✓", failed: "×",
  "awaiting-review": "◇", cancelled: "—", interrupted: "!",
};
const state = { zoom: 1, follow: true, left: 0, top: 0, selection: null };
let cleanup = () => {};
export function disposeFloor() { cleanup(); cleanup = () => {}; }
const node = (tag, className, text) => {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
};
const button = (text, action, className = "btn btn-outline-light btn-sm") => {
  const result = node("button", className, text);
  result.type = "button";
  result.addEventListener("click", action);
  return result;
};
const executionStatus = (task) => task.status === "completed" ? "finished" :
  task.status === "awaiting-review" ? "finished · awaiting review" : task.status;
const identity = (task) => task.details?.attemptNumber ? ` · Attempt ${task.details.attemptNumber}` :
  task.details?.turnId ? ` · Turn ${task.details.turnId}` : "";
const timestamp = (time) => new Date(time).toISOString().replace("T", " ").slice(0, 19) + " UTC";

export function mountFloor(preview, container, taskCard) {
  disposeFloor();
  container.replaceChildren();
  if (!preview.runs.length) return;
  const layout = timelineLayout(preview.runs, preview.operations.asOf);
  const panel = node("div", "panel floor-panel");
  const inspector = node("section", "floor-inspector p-3");
  inspector.setAttribute("aria-label", "Selected job or execution details");
  inspector.tabIndex = 0;
  const controls = node("div", "floor-controls p-2");
  const viewport = node("div", "floor-viewport");
  viewport.tabIndex = 0;
  viewport.setAttribute("role", "region");
  viewport.setAttribute("aria-label", "Job execution timeline. Scroll horizontally for time and vertically for jobs. Select a bar for details.");
  const track = node("div", "floor-track");
  const ruler = node("div", "floor-ruler");
  ruler.append(node("div", "floor-job-label", "Jobs / UTC"));
  const ticks = node("div", "floor-time-axis");
  ruler.append(ticks);
  track.append(ruler);
  const selections = [];
  function select(run, task = null) {
    state.selection = { run: run.id, task: task?.id ?? null };
    for (const item of selections) item.button.setAttribute("aria-pressed",
      String(item.run.id === run.id && (item.task?.id ?? null) === (task?.id ?? null)));
    const heading = node("h3", "h6", `${run.title} · ${run.status}`);
    inspector.replaceChildren(heading);
    if (task) {
      inspector.append(taskCard(task, preview.agents, preview.operations.asOf));
      const history = run.tasks.filter((item) => task.details?.taskId &&
        item.details?.taskId === task.details.taskId);
      const attempts = node("details", "small my-2");
      attempts.append(node("summary", "", "Attempt history"));
      if (history.length) {
        const list = node("ul", "floor-execution-list");
        for (const item of history.slice().sort((a, b) =>
          (a.details.attemptNumber ?? Infinity) - (b.details.attemptNumber ?? Infinity))) {
          const li = node("li", "");
          li.append(button(`${item.title}${identity(item)} — ${executionStatus(item)}`,
            () => select(run, item)));
          list.append(li);
        }
        attempts.append(list);
      } else attempts.append(node("p", "", task.kind === "orchestrator"
        ? "Orchestrator turns share a conversation; they are not task attempts."
        : "Task/attempt identity not recorded in this fixture."));
      inspector.append(attempts, button("All job executions / pending tasks", () => select(run)));
    } else {
      inspector.append(node("p", "small text-body-secondary", run.summary));
      const list = node("ul", "floor-execution-list");
      for (const execution of run.tasks) {
        const li = node("li", "");
        li.append(button(`${execution.kind}: ${execution.title}${identity(execution)} — ${executionStatus(execution)}${execution.startedAt ? "" : " (not started)"}`,
          () => select(run, execution)));
        list.append(li);
      }
      inspector.append(list);
      if (!run.tasks.length) inspector.append(node("p", "small", "No tasks in this job."));
    }
    inspector.scrollTop = 0;
  }
  function selectable(text, run, task, className) {
    const result = button(text, () => select(run, task), className);
    result.setAttribute("aria-pressed", "false");
    selections.push({ button: result, run, task });
    return result;
  }
  for (const { run, executions, hidden } of layout.runs) {
    const lane = node("div", "floor-lane");
    const pending = run.tasks.filter((task) => !task.startedAt).length;
    const label = selectable(`${run.title}\n${run.status}${pending ? ` · ${pending} not started` : ""}${hidden ? ` · +${hidden} overflow` : ""}`,
      run, null, "floor-job-label floor-job-button");
    label.title = "Select job to see all executions, including overflow and pending tasks";
    const area = node("div", "floor-lane-time");
    area.append(node("div", "floor-snapshot-line"));
    for (const item of executions.filter((item) => item.row < 3)) {
      const { task } = item;
      const agent = preview.agents.find((agent) => agent.id === task.agentId);
      const bar = selectable("", run, task,
        `floor-bar status-${task.status} kind-${task.kind}`);
      const icon = node("span", "floor-bar-icon", statusIcons[task.status]);
      icon.setAttribute("aria-hidden", "true");
      bar.append(icon, node("span", "floor-bar-label",
        `${task.kind === "orchestrator" ? "O" : "S"}: ${agent.name}`));
      bar.style.left = `${item.left * 100}%`;
      bar.style.width = `max(16px, ${item.width * 100}%)`;
      bar.style.top = `${10 + item.row * 30}px`;
      const description = `${run.title}: ${task.title}. ${task.kind} ${agent.name}${identity(task)}, ${executionStatus(task)}. Start ${timestamp(Date.parse(task.startedAt))}. ${task.endedAt ? `End ${timestamp(Date.parse(task.endedAt))}` : `In flight at snapshot ${timestamp(layout.end)}`}.`;
      bar.title = description;
      bar.setAttribute("aria-label", description);
      area.append(bar);
    }
    if (!executions.length) area.append(node("p", "floor-no-executions", "No executions started"));
    lane.append(label, area);
    track.append(lane);
  }
  viewport.append(track);
  const follow = button("Follow latest", () => {
    state.follow = !state.follow;
    follow.setAttribute("aria-pressed", String(state.follow));
    if (state.follow) viewport.scrollLeft = viewport.scrollWidth;
  });
  follow.setAttribute("aria-pressed", String(state.follow));
  const zoomOut = button("−", () => zoom(state.zoom / 2));
  const zoomIn = button("+", () => zoom(state.zoom * 2));
  zoomOut.setAttribute("aria-label", "Zoom out timeline");
  zoomIn.setAttribute("aria-label", "Zoom in timeline");
  const zoomLabel = node("span", "small");
  controls.append(button("← Earlier", () => {
    state.follow = false;
    follow.setAttribute("aria-pressed", "false");
    viewport.scrollBy({ left: -Math.max(200, viewport.clientWidth / 2) });
  }), follow, zoomOut, zoomLabel, zoomIn,
  node("span", "floor-legend", "▶ Running · ✓ Finished · × Failed · ◇ Awaiting review · — Cancelled · ! Interrupted · O Orchestrator turn / S Subagent attempt"),
  node("span", "floor-legend floor-selection-key", "Selected"));
  const note = node("p", "floor-note small text-body-secondary m-0 p-2",
    `TEST snapshot: ${timestamp(layout.end)}. Bars show execution lifetimes, not CPU activity. Finished is not verified success or result acceptance. Review time does not extend execution bars. Blue fill = selected. Up to 3 parallel subrows per job; select a job for all tasks.`);
  panel.append(inspector, controls, viewport, note);
  container.append(panel);
  function resize() {
    const width = Math.max(600, viewport.clientWidth - 200) * state.zoom;
    track.style.width = `${width + 180 + 20}px`;
    ticks.replaceChildren();
    const count = Math.max(2, Math.floor(width / 180));
    for (const area of track.querySelectorAll(".floor-lane-time")) {
      area.style.backgroundSize = `${100 / count}% 100%, 100% 100%`;
    }
    for (let index = 0; index <= count; index++) {
      const tick = node("span", "floor-tick", index === count ? "Snapshot" : timestamp(layout.start + (layout.end - layout.start) * index / count).slice(5, 19));
      tick.style.left = `${index / count * 100}%`;
      ticks.append(tick);
    }
    zoomLabel.textContent = `${state.zoom}×`;
    zoomOut.disabled = state.zoom <= 1;
    zoomIn.disabled = state.zoom >= 16;
    if (state.follow) viewport.scrollLeft = viewport.scrollWidth;
  }
  function zoom(value) {
    const fraction = viewport.scrollLeft / Math.max(1, track.clientWidth - 180);
    state.zoom = Math.max(1, Math.min(16, value));
    resize();
    if (!state.follow) viewport.scrollLeft = fraction * (track.clientWidth - 180);
  }
  resize();
  viewport.scrollTop = state.top;
  if (!state.follow) viewport.scrollLeft = state.left;
  viewport.addEventListener("scroll", () => {
    state.left = viewport.scrollLeft;
    state.top = viewport.scrollTop;
    if (viewport.scrollLeft + viewport.clientWidth < viewport.scrollWidth - 2) {
      state.follow = false;
      follow.setAttribute("aria-pressed", "false");
    }
  });
  const observer = new ResizeObserver(resize);
  observer.observe(viewport);
  cleanup = () => observer.disconnect();
  const selectedRun = preview.runs.find((run) => run.id === state.selection?.run);
  if (selectedRun) select(selectedRun, selectedRun.tasks.find((task) => task.id === state.selection.task));
  else if (state.selection) {
    state.selection = null;
    inspector.append(node("p", "small", "The previously selected job is no longer in this snapshot. Select a job or execution."));
  } else {
    inspector.append(node("h3", "h6", "Select a job or execution"),
      node("p", "small text-body-secondary", "Click a bar or its status icon for agent details. Select a job label for every execution, including overflow and tasks not yet started. Keyboard: Tab to a bar, then Enter or Space to select."));
  }
}

export function orderedRequests(requests) {
  return requests.slice().sort((a, b) =>
    Date.parse(a.receivedAt) - Date.parse(b.receivedAt) || a.id.localeCompare(b.id));
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

export function renderRequests(requests, container) {
  container.replaceChildren();
  for (const request of orderedRequests(requests)) {
    const card = element("article", "panel p-4", "");
    card.append(element("h3", "h6 text-break", request.id),
      element("p", "small text-body-secondary", `Schema ${request.schemaVersion} · Source: ${request.source}`));
    const receipt = element("p", "small", "Received: ");
    const time = element("time", "", request.receivedAt.replace("T", " ").replace("Z", " UTC"));
    time.dateTime = request.receivedAt;
    receipt.append(time);
    card.append(receipt, element("p", "eyebrow", "Original prompt"),
      element("pre", "request-prompt text-break mb-0", request.prompt));
    container.append(card);
  }
}

async function refresh() {
  const button = document.querySelector("#refresh-preview");
  const list = document.querySelector("#request-list");
  const state = document.querySelector("#requests-state");
  const error = document.querySelector("#preview-error");
  const count = document.querySelector("#request-count");
  button.disabled = true;
  try {
    const response = await fetch("/api/v1/preview");
    if (!response.ok) throw new Error("Intake unavailable");
    const data = await response.json();
    list.replaceChildren();
    count.textContent = "—";
    error.hidden = true;
    document.querySelector("#test-notice").hidden = data.mode !== "test";
    button.hidden = data.mode !== "test";
    state.hidden = false;
    if (data.mode !== "test") {
      state.textContent = "Production intake loading is not implemented. No production requests are loaded.";
      return;
    }
    renderRequests(data.requests, list);
    count.textContent = data.requests.length.toLocaleString("en-US");
    state.hidden = data.requests.length > 0;
    state.textContent = "No request fixtures in this collection. This does not establish that the factory is idle.";
  } catch {
    list.replaceChildren();
    count.textContent = "—";
    state.hidden = false;
    state.textContent = "Request fixtures unavailable. No production fallback was attempted.";
    error.textContent = "V1 intake preview could not be loaded. Check the bundled request fixtures and refresh.";
    error.hidden = false;
    button.hidden = false;
  } finally {
    button.disabled = false;
  }
}

if (typeof document !== "undefined") {
  document.querySelector("#refresh-preview").addEventListener("click", refresh);
  refresh();
}

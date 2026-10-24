import { createAppServer } from "./server.ts";
import { loadPreview } from "./preview.ts";
import { loadWorkflowPreview } from "./workflow-preview.ts";
import type { PreviewDirectories } from "./preview.ts";

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 18)) {
    throw new Error("Node.js 22.18+ is required.");
  }
  const mode = process.env.REFAINERY_MODE ?? "production";
  if (!["production", "test"].includes(mode)) throw new Error("Invalid application mode.");
  let preview: PreviewDirectories | undefined;
  if (mode === "test") {
    if (!process.env.REFAINERY_CONFIG_DIR || !process.env.REFAINERY_STORAGE_DIR) {
      throw new Error("Test mode requires explicit config and storage directories.");
    }
    preview = {
      config: process.env.REFAINERY_CONFIG_DIR,
      storage: process.env.REFAINERY_STORAGE_DIR,
    };
    // Fail closed before listening, rather than falling back to production data.
    await loadPreview(preview);
    await loadWorkflowPreview();
  }
  const host = process.env.REFAINERY_HOST ?? (mode === "test" ? "127.0.0.1" : "0.0.0.0");
  const port = Number(process.env.REFAINERY_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const server = createAppServer(preview);
  server.on("error", () => {
    console.error("Server could not listen. Check whether the port is already in use.");
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`refAInery ${mode} listening at http://${host}:${port}`);
  });
}

main().catch(() => {
  console.error("Startup failed. Check Node.js 22.18+, mode, port, bundled v1 request/workflow fixtures and documents, config fixture v1, storage fixture v2, and referenced test transcripts. No production fallback was attempted.");
  process.exitCode = 1;
});

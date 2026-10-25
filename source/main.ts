import { createAppServer } from "./server.ts";
import { loadPreview } from "./preview.ts";
import { loadWorkflowPreview } from "./workflow-preview.ts";
import type { PreviewDirectories } from "./preview.ts";
import { Store } from "./backend/storage.ts";
import { Registry } from "./backend/registry.ts";

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error("Node.js 22.19+ is required.");
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
  const backend = mode === "production" && process.env.REFAINERY_BACKEND === "1";
  let production: Store | undefined;
  let registry: Registry | undefined;
  if (backend) {
    if (!process.env.REFAINERY_STORAGE_DIR) throw new Error("Explicit production storage required");
    production = new Store(process.env.REFAINERY_STORAGE_DIR);
    registry = new Registry(production, process.env.MODEL_REGISTRY ?? "https://openrouter.ai/api/v1/models");
    await registry.start();
  }
  const host = process.env.REFAINERY_HOST ?? (mode === "test" || backend ? "127.0.0.1" : "0.0.0.0");
  const port = Number(process.env.REFAINERY_PORT ?? 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port.");
  const server = createAppServer(preview, production);
  if (backend) {
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      server.close();
      void registry?.stop();
    });
  }
  server.on("error", () => {
    console.error("Server could not listen. Check whether the port is already in use.");
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`refAInery ${mode} listening at http://${host}:${port}`);
  });
}

main().catch(() => {
  console.error("Startup failed. Check Node.js 22.19+, mode/port, schemas, preview fixtures or explicit production storage and registry. No fallback was attempted.");
  process.exitCode = 1;
});

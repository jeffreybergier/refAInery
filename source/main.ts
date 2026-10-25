import { join } from "node:path";
import { createAppServer } from "./server.ts";
import { Store, readJSON } from "./backend/storage.ts";
import { Registry } from "./backend/registry.ts";
import { configRoot, storageRoot, environment, modelConfiguration } from "./environment.ts";

async function main() {
  const mode = environment();
  const model = await modelConfiguration();
  const store = new Store(storageRoot);
  const registry = mode === "test"
    ? new Registry(store, join(configRoot, model.registry),
      async () => Response.json(await readJSON(join(configRoot, model.registry))), "faux")
    : new Registry(store, model.registry);
  await registry.start();
  const server = createAppServer(undefined, store, mode);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
    server.close();
    void registry.stop();
  });
  server.listen(8080, "0.0.0.0", () => {
    console.log(`refAInery ${mode}: saved workflow on port 8080 (no automatic dispatch)`);
  });
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});

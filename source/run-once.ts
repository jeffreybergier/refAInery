import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runOnce } from "./backend/runner.ts";
import { loadScenario } from "./backend/scenario.ts";
import { configRoot, storageRoot, environment, modelConfiguration } from "./environment.ts";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
const apiKey = process.env.OPENROUTER_API_KEY ?? "";
delete process.env.OPENROUTER_API_KEY;
try {
  const { values } = parseArgs({ options: {
    "prompt-file": { type: "string" }, scenario: { type: "string", default: "happy-path" },
  } });
  const mode = environment();
  const model = await modelConfiguration();
  const scenario = mode === "test" ? await loadScenario(configRoot, values.scenario!) : undefined;
  const prompt = values["prompt-file"] ? await readFile(values["prompt-file"], "utf8") : scenario?.prompt;
  if (!prompt) throw new Error("A production request needs --prompt-file");
  const result = await runOnce({ storage: storageRoot, config: configRoot, prompt,
    selectedModel: model.model, registryURL: scenario ? join(configRoot, model.registry) : model.registry,
    apiKey, scenario, signal: controller.signal,
    onProgress: (stage) => console.log(`refAInery ${mode}: ${stage}`) });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Run failed");
  process.exitCode = 1;
}

import { readFile } from "node:fs/promises";
import { runOnce } from "./backend/runner.ts";

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
const apiKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;
try {
  const { REFAINERY_STORAGE_DIR: storage, REFAINERY_CONFIG_DIR: config,
    REFAINERY_PROMPT_FILE: promptFile, MODEL_SELECTED: selectedModel,
    MODEL_REGISTRY: registryURL } = process.env;
  if (!apiKey || !storage || !config || !promptFile || !selectedModel || !registryURL) throw new Error("Missing configuration");
  const result = await runOnce({ storage, config, prompt: await readFile(promptFile, "utf8"), selectedModel,
    registryURL, apiKey, signal: controller.signal,
    onProgress: (stage) => console.log(`refAInery: ${stage}`) });
  console.log(JSON.stringify(result));
} catch {
  console.error("Supervised milestone stopped. Check configuration, 1Password access, Docker, and saved checkpoints. No automatic retry.");
  process.exitCode = 1;
}

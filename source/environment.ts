import { readJSON } from "./backend/storage.ts";

export const configRoot = "/app/config";
export const storageRoot = "/app/storage";
export type Environment = "test" | "prod";
export function environment(): Environment {
  const mode = process.env.REFAINERY_MODE ?? "test";
  if (mode !== "test" && mode !== "prod") throw new Error("Unknown environment");
  return mode;
}
export interface ModelConfiguration {
  provider: "openrouter" | "faux";
  model: string;
  registry: string;
}
export async function modelConfiguration(root = configRoot): Promise<ModelConfiguration> {
  const config = await readJSON<ModelConfiguration>(`${root}/model.json`);
  if (!["openrouter", "faux"].includes(config.provider) || !config.model || !config.registry) {
    throw new Error("Invalid model.json");
  }
  return config;
}

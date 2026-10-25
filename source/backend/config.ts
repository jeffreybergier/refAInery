import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { safeRead } from "./storage.ts";

export interface Personality {
  schemaVersion: 1; id: string; name: string; role: "orchestrator" | "subagent";
  instructions: string; availableTools: string[];
}
export const SDK_VERSION = "1.4.0";
export const CATALOG_VERSION = "refainery-tools-v1";
const allowed = {
  orchestrator: ["web_search", "update_plan", "assign_subagent", "finish_run"],
  subagent: ["read", "write", "edit", "bash", "web_search", "web_fetch", "submit_handover"],
};
export async function loadConfiguration(root: string) {
  const schema = JSON.parse(await readFile(new URL("../../schemas/config/v1/agent.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile<Personality>(schema);
  const personalities: Personality[] = [];
  for (const id of ["orchestrator", "worker"]) {
    const data = JSON.parse(await safeRead(root, `agents/${id}.json`));
    if (!validate(data) || data.id !== id || data.role !== (id === "worker" ? "subagent" : "orchestrator")) {
      throw new Error("Invalid personality");
    }
    const agent = data as Personality;
    if (agent.availableTools.some((tool) => !allowed[agent.role].includes(tool))) throw new Error("Unauthorized tool");
    const required = id === "worker" ? ["submit_handover"] : ["update_plan", "assign_subagent", "finish_run"];
    if (required.some((tool) => !agent.availableTools.includes(tool))) throw new Error("Missing workflow tool");
    personalities.push(agent);
  }
  const extensions = [];
  for (const name of ["workflow", "web-search"]) {
    const code = await readFile(new URL(`../extensions/${name}.ts`, import.meta.url), "utf8");
    extensions.push({ name, code, sha256: createHash("sha256").update(code).digest("hex") });
  }
  return { personalities, extensions, sdkVersion: SDK_VERSION, toolCatalogVersion: CATALOG_VERSION };
}
export type Configuration = Awaited<ReturnType<typeof loadConfiguration>>;

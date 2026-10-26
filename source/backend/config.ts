import { readFile, lstat, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { orchestrator, orchestratorText } from "../agents/orchestrator.ts";
import { subagent, subagentText, instructionsPrompt } from "../agents/subagent.ts";
import { instructions, workflowMessages, systemPrompt, resolveAgentText, type PersonalityPrompts } from "../agents/shared.ts";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { safeRead } from "./storage.ts";

export interface Personality {
  schemaVersion: 1; id: string; name: string; role: "orchestrator" | "subagent";
  instructions: string; availableTools: string[];
  personalityPrompts?: PersonalityPrompts;
}
export const SDK_VERSION = "1.4.0";
export const CATALOG_VERSION = "refainery-tools-v3";
interface PersonalityOverlay {
  schemaVersion: 1; id: string; name: string; role: Personality["role"];
  prompts?: PersonalityPrompts; availableTools?: string[];
}
export async function loadConfiguration(root: string) {
  const schema = JSON.parse(await readFile(new URL("../../schemas/config/v1/agent.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile<PersonalityOverlay>(schema);
  await realpath(root); // A missing configuration root is not an absent overlay.
  let hasAgents = true;
  try { await lstat(join(root, "agents")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    hasAgents = false;
  }
  // A dangling link or unreadable directory is an error, not missing config.
  const agentFiles = hasAgents ? await readdir(join(root, "agents")) : [];
  const agentTemplates = structuredClone({ shared: { instructions, ...workflowMessages }, orchestrator: orchestratorText, subagent: subagentText });
  const agentText = structuredClone(agentTemplates);
  const personalities: Personality[] = [];
  for (const base of [orchestrator, subagent]) {
    let overlay: PersonalityOverlay | undefined;
    if (agentFiles.includes(`${base.id}.json`)) {
      const data: unknown = JSON.parse(await safeRead(root, `agents/${base.id}.json`));
      if (!validate(data)) {
        throw new Error(`Invalid personality ${base.id}: ${JSON.stringify(validate.errors)}`);
      }
      if (data.id !== base.id || data.role !== base.role) throw new Error(`Invalid personality ${base.id}: ID/role mismatch`);
      overlay = data;
    }
    // Legacy explicit allowlists remain bounded by harness-owned role policy.
    const availableTools = overlay?.availableTools ?? [...base.availableTools];
    if (availableTools.some((tool) => !(base.allowedTools as readonly string[]).includes(tool))) throw new Error("Unauthorized tool");
    if (base.requiredTools.some((tool) => !availableTools.includes(tool))) throw new Error("Missing workflow tool");
    if (base.role === "orchestrator") {
      agentText.orchestrator = resolveAgentText(agentTemplates.orchestrator, overlay?.prompts, base.id);
    } else {
      agentText.subagent = resolveAgentText(agentTemplates.subagent, overlay?.prompts, base.id);
    }
    const instructions = base.role === "orchestrator" ? agentText.orchestrator.instructions
      : instructionsPrompt(agentText.subagent.instructions, agentText.subagent.handover);
    personalities.push({ schemaVersion: 1, id: base.id, role: base.role,
      name: overlay?.name ?? base.name, availableTools,
      instructions: systemPrompt(instructions),
      ...(overlay?.prompts ? { personalityPrompts: structuredClone(overlay.prompts) } : {}),
    });
  }
  const extensions = [];
  for (const name of ["workflow", "web-search"]) {
    const code = await readFile(new URL(`../extensions/${name}.ts`, import.meta.url), "utf8");
    extensions.push({ name, code, sha256: createHash("sha256").update(code).digest("hex") });
  }
  return { personalities, agentTemplates, agentText, extensions, sdkVersion: SDK_VERSION, toolCatalogVersion: CATALOG_VERSION };
}
export type Configuration = Awaited<ReturnType<typeof loadConfiguration>>;

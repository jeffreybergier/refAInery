import { readFile, lstat, realpath, readdir } from "node:fs/promises";
import { join } from "node:path";
import { orchestrator, orchestratorText, instructionsPrompt as orchestratorInstructionsPrompt } from "../agents/orchestrator.ts";
import { subagent, subagentText, instructionsPrompt } from "../agents/subagent.ts";
import { instructions, workflowMessages, systemPrompt, resolveAgentText, type PersonalityPrompts } from "../agents/shared.ts";
import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";
import { safeRead } from "./storage.ts";

export interface Personality {
  schemaVersion: 1; id: string; name: string; role: "orchestrator" | "subagent";
  instructions: string; availableTools: string[];
  personalityPrompts?: PersonalityPrompts;
  resolvedPrompts?: Record<string, string>;
}
export const SDK_VERSION = "1.4.0";
export const CATALOG_VERSION = "refainery-tools-v4";
interface PersonalityOverlay {
  schemaVersion: 1; id: string; name: string; role: Personality["role"];
  prompts?: PersonalityPrompts; availableTools?: string[];
}
export async function loadConfiguration(root: string) {
  const schema = JSON.parse(await readFile(new URL("../../schemas/config/v1/agent.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ strict: true });
  const validate = ajv.compile<PersonalityOverlay>(schema);
  const selectionSchema = JSON.parse(await readFile(new URL("../../schemas/config/v1/subagents.schema.json", import.meta.url), "utf8"));
  const validateSelection = ajv.compile<{ schemaVersion: 1; allowed: string[] }>(selectionSchema);
  await realpath(root); // A missing configuration root is not an absent overlay.
  // lstat distinguishes an absent manifest from a broken or escaping symlink.
  let explicitSelection = true;
  try { await lstat(join(root, "subagents.json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    explicitSelection = false;
  }
  let subagentIds = ["worker"];
  if (explicitSelection) {
    const selection: unknown = JSON.parse(await safeRead(root, "subagents.json"));
    if (!validateSelection(selection)) throw new Error(`Invalid subagent selection: ${JSON.stringify(validateSelection.errors)}`);
    subagentIds = selection.allowed;
  }
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
  agentText.subagent = resolveAgentText(agentTemplates.subagent);
  const personalities: Personality[] = [];
  const bases = [orchestrator, ...subagentIds.map((id) => ({ ...subagent, id }))];
  for (const base of bases) {
    let overlay: PersonalityOverlay | undefined;
    if (explicitSelection && base.role === "subagent" && !agentFiles.includes(`${base.id}.json`)) {
      throw new Error(`Missing selected subagent: ${base.id}`);
    }
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
    const resolvedPrompts = base.role === "orchestrator"
      ? resolveAgentText(agentTemplates.orchestrator, overlay?.prompts, base.id)
      : resolveAgentText(agentTemplates.subagent, overlay?.prompts, base.id);
    if (base.role === "orchestrator") {
      agentText.orchestrator = resolvedPrompts as typeof orchestratorText;
    } else if (!explicitSelection) {
      // Retain the legacy role-wide snapshot for old config consumers.
      agentText.subagent = resolvedPrompts as typeof subagentText;
    }
    const instructions = base.role === "orchestrator"
      ? orchestratorInstructionsPrompt(resolvedPrompts.instructions, subagentIds)
      : instructionsPrompt(resolvedPrompts.instructions, agentTemplates.subagent.handover);
    personalities.push({ schemaVersion: 1, id: base.id, role: base.role,
      name: overlay?.name ?? base.name, availableTools,
      instructions: systemPrompt(instructions), resolvedPrompts,
      ...(overlay?.prompts ? { personalityPrompts: structuredClone(overlay.prompts) } : {}),
    });
  }
  const extensions = [];
  for (const name of ["workflow", "web-search"]) {
    const code = await readFile(new URL(`../extensions/${name}.ts`, import.meta.url), "utf8");
    extensions.push({ name, code, sha256: createHash("sha256").update(code).digest("hex") });
  }
  return { personalities, subagentIds, agentTemplates, agentText, extensions, sdkVersion: SDK_VERSION, toolCatalogVersion: CATALOG_VERSION };
}
export type Configuration = Awaited<ReturnType<typeof loadConfiguration>>;

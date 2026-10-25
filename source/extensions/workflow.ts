import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Type as SchemaType, TSchema } from "@earendil-works/pi-ai";

// AGENT INSTRUCTION: Workflow tool names and descriptions are user-authored.
// Ask the user for explicit permission before changing either, including wording
// cleanups, renames, or prompt "improvements". Do not change them without approval.

// ── Tool text: review model-facing descriptions here ─────────────
// Wording is intentionally preserved; moving text is not a prompt revision.
export const workflowText = {
  update_plan: "ALWAYS create a plan to complete the REQUEST. Each TASK in the plan may be accomplished by spawning one more subagents. Update the plan whenever you receive new information from the subagents. ALWAYS use the PLAN format provided in your instructions.",
  spawn_subagent: "Spawn a subagent to execute a TASK from your PLAN.",
  finish_task: "WHEN you are finished with your TASK OR you cannot continue due to problems, call this tool to submit your handover documentation to the Orchestrator. ALWAYS use the template provided in your instructions.",
  finish_request: "ALWAYS call this tool when all of the TASKs from your PLAN have been completed and you have confirmed that the REQUEST is fully complete OR when you think the REQUEST cannot be completed for reasons outside of your control.",
};

// ── Tool schemas and implementation ──────────────────────────────
type Action = "update_plan" | "spawn_subagent" | "finish_task" | "finish_request";
type Host = (callId: string, name: Action, args: Record<string, unknown>) => Promise<unknown>;

/** Thin Pi-facing definitions. The backend binds caller identity and owns every
 * state transition. No filesystem access, dispatch, or credentials live here.
 */
export function createWorkflowExtension(
  Type: typeof SchemaType, availableTools: readonly string[], host: Host,
): (pi: ExtensionAPI) => void {
  const text = () => Type.String({ minLength: 1, maxLength: 65536 });
  const definitions = [
    { name: "update_plan", description: workflowText.update_plan,
      parameters: Type.Object({ markdown: text() }, { additionalProperties: false }) },
    { name: "spawn_subagent", description: workflowText.spawn_subagent,
      parameters: Type.Object({ personality: Type.Literal("worker"), model: Type.Literal("default"),
        title: text(), assignment: text(), rationale: text() }, { additionalProperties: false }) },
    { name: "finish_task", description: workflowText.finish_task,
      parameters: Type.Object({ markdown: text(), stopReason: Type.Union([
        Type.Literal("success"), Type.Literal("failure"), Type.Literal("context-limit"),
      ]) }, { additionalProperties: false }) },
    { name: "finish_request", description: workflowText.finish_request,
      parameters: Type.Object({ outcome: Type.Union([Type.Literal("success"), Type.Literal("failure"), Type.Literal("question")]),
        summary: text(), rationale: text() }, { additionalProperties: false }) },
  ] as const;
  return (pi) => {
    for (const tool of definitions) {
      if (!availableTools.includes(tool.name)) continue;
      pi.registerTool<TSchema>({ ...tool, label: tool.name, executionMode: "sequential",
        async execute(callId, args) {
          // Every schema above is a closed object; Pi validates it before execute.
          const saved = await host(callId, tool.name, args as Record<string, unknown>);
          return { content: [{ type: "text", text: JSON.stringify(saved) }],
            details: saved, terminate: tool.name !== "update_plan" };
        },
      });
    }
  };
}

// Loading without an explicitly bound backend grants no workflow tools.
export default function disabled(_pi: ExtensionAPI): void {}

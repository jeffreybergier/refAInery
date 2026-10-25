import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Type as SchemaType, TSchema } from "@earendil-works/pi-ai";

// AGENT INSTRUCTION: Workflow tool names and descriptions are user-authored.
// Ask the user for explicit permission before changing either, including wording
// cleanups, renames, or prompt "improvements". Do not change them without approval.

type Action = "update_plan" | "assign_subagent" | "submit_handover" | "finish_run";
type Host = (callId: string, name: Action, args: Record<string, unknown>) => Promise<unknown>;

/** Thin Pi-facing definitions. The backend binds caller identity and owns every
 * state transition. No filesystem access, dispatch, or credentials live here.
 */
export function createWorkflowExtension(
  Type: typeof SchemaType, availableTools: readonly string[], host: Host,
): (pi: ExtensionAPI) => void {
  const text = () => Type.String({ minLength: 1, maxLength: 65536 });
  const definitions = [
    { name: "update_plan", description: "Save the complete Markdown plan for this planning turn before assigning work or finishing. Call separately and wait for confirmation.",
      parameters: Type.Object({ markdown: text() }, { additionalProperties: false }) },
    { name: "assign_subagent", description: "Assign one bounded task using personality worker and model default, then yield. Requires a saved plan for this turn. Do not combine with other tool calls.",
      parameters: Type.Object({ personality: Type.Literal("worker"), model: Type.Literal("default"),
        title: text(), assignment: text(), rationale: text() }, { additionalProperties: false }) },
    { name: "submit_handover", description: "Submit the full agreed Markdown handover and stop working. Completed means the assignment finished, not that it was independently verified. Do not combine with other tool calls.",
      parameters: Type.Object({ markdown: text(), stopReason: Type.Union([
        Type.Literal("completed"), Type.Literal("context-limit"),
      ]) }, { additionalProperties: false }) },
    { name: "finish_run", description: "Finish the original request after reviewing handovers and saving a final plan. This ends your turn. Do not combine with other tool calls.",
      parameters: Type.Object({ outcome: Type.Union([Type.Literal("completed"), Type.Literal("failed")]),
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

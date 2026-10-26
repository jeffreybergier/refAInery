import { composePrompt, promptWithContext } from "./shared.ts";

// AGENT INSTRUCTION: All prompts, guidance, and the handover template in this
// file are user-authored. Never edit them without the user's explicit permission,
// including wording cleanups, typo fixes, or prompt "improvements". Changes to
// prompt assembly code do not grant permission to change the authored text.

// ── Agent text: review behavioral guidance here ──────────────────
export const subagentText = {
  // System-role guidance (optional personality is composed separately).
  instructions: `
{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Initial user message; placeholders control task/context placement.
  firstPrompt: `
Complete this ASSIGNMENT from the orchestrator:

{{ ASSIGNMENT }}

Use the original REQUEST and current PLAN as context for your assignment:

REQUEST:
{{ REQUEST }}

PLAN:
{{ PLAN }}

Use this HANDOVER TEMPLATE when calling finish_task:

{{ HANDOVER_TEMPLATE }}

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Assistant message seeded once after firstPrompt; blank disables seeding.
  firstReply: `
{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // User reminder after a clean text-only stop; blank disables the reminder.
  finalAnswer: `
{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  handover: `## Goal

## Constraints & Preferences

## Progress
### Done

### In Progress

### Blocked

## Key Decisions

## Next Steps

## Critical Context

<read-files>
</read-files>

<modified-files>
</modified-files>`,
  contextHandback: `The application context guard requires handback now. Call finish_task alone with stopReason context-limit and the complete required Markdown. Do not continue the assignment.`,
};

// ── Role policy and prompt assembly ──────────────────────────────
export const subagent = {
  id: "worker", name: "Worker", role: "subagent",
  availableTools: ["read", "write", "edit", "bash", "finish_task"],
  allowedTools: ["read", "write", "edit", "bash", "web_search", "web_fetch", "finish_task"],
  requiredTools: ["finish_task"],
} as const;

// The validation contract and the agent's template share one source of truth.
export const handoverSections = subagentText.handover.split("\n").filter(Boolean);

/** Place the handover format inline, retaining the legacy append fallback. */
export function instructionsPrompt(text: string, handover: string): string {
  const marker = "{{ HANDOVER_TEMPLATE }}";
  return text.includes(marker) ? text.split(marker).join(handover)
    : [text, handover].join("\n\n");
}

export function firstPrompt(assignment: string,
  text = composePrompt(subagentText.firstPrompt),
  context: { request?: string; plan?: string; handoverTemplate?: string } = {}): string {
  const values: Record<string, string | undefined> = {
    ASSIGNMENT: assignment,
    REQUEST: context.request,
    PLAN: context.plan,
    HANDOVER_TEMPLATE: context.handoverTemplate ?? subagentText.handover,
  };
  // One pass: markers inside inserted task, context, or template stay literal.
  const rendered = text.replace(/\{\{ (ASSIGNMENT|REQUEST|PLAN|HANDOVER_TEMPLATE) \}\}/g,
    (_match, name: string) => {
      const value = values[name];
      if (value === undefined) throw new Error(`Missing subagent prompt context: ${name}`);
      return value;
    });
  // Preserve task delivery for older or deliberately blank prompt templates.
  return text.includes("{{ ASSIGNMENT }}") ? rendered
    : promptWithContext(rendered, { assignment });
}

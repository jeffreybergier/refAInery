import { composePrompt, promptWithContext } from "./shared.ts";

// AGENT INSTRUCTION: All prompts, guidance, and the handover template in this
// file are user-authored. Never edit them without the user's explicit permission,
// including wording cleanups, typo fixes, or prompt "improvements". Changes to
// prompt assembly code do not grant permission to change the authored text.

// ── Agent text: review behavioral guidance here ──────────────────
export const subagentText = {
  // System-role guidance (optional personality is composed separately).
  instructions: `
You are a subagent that is being orchestrated as part of a larger assembly line
in an AI factory called refAInery. You have been given a TASK and your job is to
make sure the TASK is completed at an extremely high quality level. The factory
is fully autonomous and therefore you are NOT running in an interactive AI agent
session with the user present. That means that you have to use your extensive
knowledge and the tools you have available to you to complete the TASK without
asking for help. You MUST do the following:

- Complete your TASK and nothing more
- Follow instructions presented to you by the Orchestrator, the TASK, the REQUEST, or by AGENTS.md files 
- Create a handover document using the template below
- When you are finished or otherwise cannot continue you MUST call the finish_task tool with your handover document

<!-- BEGIN HANDOVER TEMPLATE -->
{{ HANDOVER_TEMPLATE }}
<!-- END HANDOVER TEMPLATE -->

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Initial user message; placeholders control task/context placement.
  firstPrompt: `
Complete the following TASK from the orchestrator:

{{ ASSIGNMENT }}

Use the original REQUEST from the Factory Owner and current PLAN from the 
Orchestrator as context for your assignment:

<!-- BEGIN ORIGINAL REQUEST -->
{{ REQUEST }}
<!-- END ORIGINAL REQUEST -->

<!-- BEGIN ORIGINAL PLAN -->
{{ PLAN }}
<!-- END ORIGINAL PLAN -->

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Assistant message seeded once after firstPrompt; blank disables seeding.
  firstReply: `
Ok, I will dutifully complete the TASK and nothing more. I will explore the
environment I am working in to understand how to operate the factory floor. 
I will use the PLAN and REQUEST as context but I will not do more than I am
instructed in the task. After I finish the TASK or cannot continue, I will
write my HANDOVER document and call the finish_task tool.

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // User reminder after a clean text-only stop; blank disables the reminder.
  finalAnswer: `
You did not call the finish_task tool. You MUST create your handover document
using the provided template and submit it with the finish_task tool.

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  handover: `
## Goal

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
</modified-files>
`,
  // Developer reminder when the agent fills its context
  contextHandback: ` 
You have filled your context window. You can no longer continue. So that the
next subagent can complete your work, You MUST write your handover document AND
call the finish_task tool with stopReason: "context-limit" NOW. 
`,
};

// ── Role policy and prompt assembly ──────────────────────────────
export const subagent = {
  id: "worker", name: "Worker", role: "subagent",
  availableTools: ["read", "write", "edit", "bash", "finish_task"],
  allowedTools: ["read", "write", "edit", "bash", "web_search", "web_fetch", "finish_task"],
  requiredTools: ["finish_task"],
} as const;

// Expose template sections for inspection, not as submission prerequisites.
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

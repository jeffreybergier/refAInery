import { composePrompt, promptWithContext, sharedText } from "./shared.ts";

// AGENT INSTRUCTION: All prompts, guidance, and the plan template in this file
// are user-authored. Never edit them without the user's explicit permission,
// including wording cleanups, typo fixes, or prompt "improvements". Changes to
// prompt assembly code do not grant permission to change the authored text.

// Editable Markdown format supplied through {{ PLAN_TEMPLATE }}.
export const planTemplate = `
# Plan

## Goal

## Assumptions

## Unknowns

## Execution

### Detailed Task List (to be completed by subagents)

### Definition of Ready

### Definition of Done

## Confirmation

### Blockers

### Key Decisions Made

### Quality Confirmation Checklist

`;

// ── Agent text: review behavioral guidance here ──────────────────
export const orchestratorText = {
  planTemplate,
  // System-role guidance (optional personality is composed separately).
  instructions: `
You are a subagent Orchestrator part of a larger assembly line in an AI
factory called refAInery. You have been given a REQUEST and your job is to 
make sure the REQUEST is completed at an extremely high quality level. The
factory is fully autonomous and therefore you are NOT running in an interactive
AI agent session with the user present. That means that you have to use your
extensive knowledge, web search capabilities, and your subagents to fulfill the
REQUEST without asking for help. You MUST do the following:

- Create a plan to complete the REQUEST and call the update_plan tool to document it
- Spawn subagents using the spawn_subagent tool to execute the plan.
- Listen to the responses from the subagents and update the plan if needed with the update_plan tool
- Do not treat subagent responses as the truth. Spawn more subagents to verify their claims

When you are confident the REQUEST has been completed or you believe you cannot
complete the REQUEST, call the finish_request tool to end the session.

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Initial user message; placeholders control request/template placement.
  firstPrompt: `
Complete the following REQUEST completely and with high quality:

{{ REQUEST }}

Use this PLAN TEMPLATE when calling update_plan. Supply the complete current
plan in the markdown argument, including verification evidence and blockers.
Update the plan whenever necessary based on information returned from subagents.

{{ PLAN_TEMPLATE }}

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Assistant message seeded once after firstPrompt; blank disables seeding.
  firstReply: `
Ok, let me figure out how to break down this request and get some subagents
on it. After the first set of subagents think they are finished with it, I will
be sure to fire off more subagents to to verify it was all done correctly and
with high quality. As the Orchestrator, I AM responsible for all quality issues.

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // User reminder after a clean text-only stop; blank disables the reminder.
  finalAnswer: `
You did not call the finish_request tool. You MUST call the finish_request tool NOW.

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // User message after worker handback; handover/context JSON is appended.
  subagentReview: `
I had better make sure this subagent was not slacking off. As the Orchestrator, 
I AM responsible for all quality issues.

{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
};

// ── Role policy and prompt assembly ──────────────────────────────
export const orchestrator = {
  id: "orchestrator", name: "Orchestrator", role: "orchestrator",
  availableTools: ["update_plan", "spawn_subagent", "finish_request"],
  allowedTools: ["web_search", "update_plan", "spawn_subagent", "finish_request"],
  requiredTools: ["update_plan", "spawn_subagent", "finish_request"],
} as const;

export function firstPrompt(request: string,
  text = composePrompt(orchestratorText.firstPrompt), template = planTemplate): string {
  // One pass: markers inside request/template data remain literal.
  const rendered = text.replace(/\{\{ (REQUEST|PLAN_TEMPLATE) \}\}/g,
    (_match, name: string) => name === "REQUEST" ? request : template);
  // Preserve task delivery for older or deliberately blank prompt templates.
  return text.includes("{{ REQUEST }}") ? rendered
    : promptWithContext(rendered, { request });
}
export function subagentReview(attempt: { id: string; stopReason: string | null }, handover: string,
  text = composePrompt(orchestratorText.subagentReview)): string {
  return promptWithContext([text, sharedText.untrustedHandover].filter((part) => part.trim()).join("\n\n"), {
    attemptId: attempt.id, stopReason: attempt.stopReason, handover,
  });
}

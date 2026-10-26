import { composePrompt, promptWithContext, sharedText } from "./shared.ts";

// Editable Markdown format supplied through {{ PLAN_TEMPLATE }}.
export const planTemplate = `
# Plan

## Goal

## Assumptions

## Unknowns

## Acceptance Criteria

## Tasks
- ID:
  - Objective:
  - Status: pending | in_progress | blocked | complete
  - Dependencies:
  - Verification:
  - Evidence:

## Progress
### Done

### In Progress

### Blocked

## Key Decisions

## Next Steps

## Critical Context

## Completion Assessment`;

// ── Agent text: review behavioral guidance here ──────────────────
export const orchestratorText = {
  planTemplate,
  // System-role guidance (optional personality is composed separately).
  instructions: `
{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Initial user message; placeholders control request/template placement.
  firstPrompt: `
Complete the following REQUEST:

{{ REQUEST }}

Use this PLAN TEMPLATE when calling update_plan. Supply the complete current
plan in the markdown argument, including verification evidence and blockers.

{{ PLAN_TEMPLATE }}

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
  // User message after worker handback; handover/context JSON is appended.
  subagentReview: `
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

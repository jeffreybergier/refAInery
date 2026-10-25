import { composePrompt, promptWithContext } from "./shared.ts";

// ── Agent text: review behavioral guidance here ──────────────────
export const subagentText = {
  // System-role guidance (optional personality is composed separately).
  instructions: `
{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Initial user message; assignment JSON is appended automatically.
  firstPrompt: `
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
export function firstPrompt(assignment: string, text = composePrompt(subagentText.firstPrompt)): string {
  return promptWithContext(text, { assignment });
}

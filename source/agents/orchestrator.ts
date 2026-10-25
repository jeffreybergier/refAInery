import { composePrompt, promptWithContext, sharedText } from "./shared.ts";

// ── Agent text: review behavioral guidance here ──────────────────
export const orchestratorText = {
  // System-role guidance (optional personality is composed separately).
  instructions: `
{{ OPTIONAL_PERSONALITY_ADDITION }}
`,
  // Initial user message; request JSON is appended automatically.
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

export function firstPrompt(request: string, text = composePrompt(orchestratorText.firstPrompt)): string {
  return promptWithContext(text, { request });
}
export function subagentReview(attempt: { id: string; stopReason: string | null }, handover: string,
  text = composePrompt(orchestratorText.subagentReview)): string {
  return promptWithContext([text, sharedText.untrustedHandover].filter((part) => part.trim()).join("\n\n"), {
    attemptId: attempt.id, stopReason: attempt.stopReason, handover,
  });
}

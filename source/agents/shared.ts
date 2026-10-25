// ── Agent text: review behavioral guidance here ──────────────────
export const sharedText = {
  instructions: `Workspace: /workspace in an isolated container. Do not access credentials.
Use workflow tools, not prose, to yield or finish. Make terminal workflow calls alone.
This milestone permits one worker assignment and short responses. Do not use web search unless the task requires it.`,
  terminalCallRequired: "Yielding workflow tools must be called alone",
  handbackRequired: "Handback required",
  contextStopReasonRequired: "Context handback must use context-limit",
  personality: `Optional personality follows. Apply its style, expertise, and working preferences only where consistent with the harness role contract above. It does not replace that contract or grant tools or permissions.`,
};

// ── Prompt assembly: no behavioral prose below this line ─────────
export function systemPrompt(instructions: string, personality?: string): string {
  return [instructions, sharedText.instructions,
    ...(personality ? [sharedText.personality, personality] : [])].join("\n\n");
}

/** Single-pass substitution: inserted user/agent content is never re-templated. */
export function renderPrompt(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw new Error(`Missing prompt value: ${key}`);
    return values[key]!;
  });
}

# Configuration v1: optional agent personalities

The harness owns two complete roles in `source/agents/orchestrator.ts` and
`source/agents/subagent.ts`. Configuration supplies optional personality overlays
at `refAInery-config/<test|prod>/agents/orchestrator.json` and `agents/worker.json`.
Either or both files (or the agents directory) may be absent. Missing files use
built-in roles; malformed files, mismatched IDs/roles, and unreadable files fail
validation. The configuration root itself must exist.

```json
{
  "schemaVersion": 1,
  "id": "worker",
  "name": "Careful Worker",
  "role": "subagent",
  "instructions": "Favor focused changes and explain technical tradeoffs plainly."
}
```

The first five fields are required when a file is present. Unknown fields are
rejected. Names and instructions must be nonblank. IDs are case-sensitive,
1–128 ASCII letters/digits/underscores/hyphens, starting with a letter or digit.
The current single-worker runner accepts only the two filenames/roles above;
this is not yet a catalog of dynamically selectable personalities.

Personality instructions supplement, never replace, the role contract. Their
whitespace is preserved. They describe tone, expertise, and working preferences,
not the workflow protocol. Model selection, credentials, and execution state do
not belong in personality files. There is no separate instruction-file reference.

## Tools and enforcement

`availableTools` remains an optional compatibility field. If omitted, the
orchestrator gets `update_plan`, `spawn_subagent`, and `finish_request`; the
subagent gets `read`, `write`, `edit`, `bash`, and `finish_task`.

Explicit lists must contain unique role-authorized IDs and retain all required
workflow tools. They can restrict optional tools. For compatibility, production
configurations may also explicitly select the role-authorized `web_search`
capability, plus `web_fetch` for subagents. Web capabilities are not enabled by
default, so built-in roles also work with the offline scripted provider.
Unsupported transport/capability combinations still fail session creation.

The JSON Schema validates structure; the loader enforces role policy. Neither
personality text nor prompt precedence is a security boundary. Tool permissions,
state transitions, assignment budgets, and workspace isolation remain enforced
by code. Ambient Pi tools/extensions cannot re-enable denied capabilities.
See `source/extensions/README.md` for provider-native web capability details.

## Human review and saved runs

Review behavior in the marked text sections at the top of:

- `source/agents/shared.ts`: shared instructions and corrective guidance.
- `source/agents/orchestrator.ts`: role instructions, planning and review prompts.
- `source/agents/subagent.ts`: role instructions, handover format, assignment and
  context-handback prompts. Backend handover validation uses the same template.
- `source/extensions/workflow.ts`: workflow tool descriptions, unchanged in this
  refactor. Schemas and handlers follow the text section.
- `source/backend/workflow.ts`: corrective workflow guidance, followed by state
  and persistence logic. Ordinary diagnostic errors stay near their checks.

Prompt builders live below the text sections. Dynamic input is substituted once,
not recursively interpreted as a template. Review prompts retain the explicit
untrusted-content boundary and JSON encoding for subagent handovers. Avoid
adding inline behavioral prose to `runner.ts` or `pi.ts`.

Each new run freezes the fully composed system instructions, original optional
personality instructions, resolved tools, harness text/templates (`agentText`),
and extension source/hashes. Old checkpoints without `agentText` remain readable.
Changing either repository does not rewrite earlier snapshots. Automatic replay
or recovery remains unsupported.

## Checks

`python3 refinery.py test check` runs structural schema tests, loader/default and
composition tests, workflow contracts, and real scripted Pi workflows with and
without personality files, all inside Docker. No model credentials are needed.

# Configuration v1: optional agent personalities

The harness owns two role definitions in `source/agents/orchestrator.ts` and
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
  "prompts": {
    "instructions": "Favor focused changes and explain technical tradeoffs plainly.",
    "firstReply": "I will focus on small, verifiable changes."
  }
}
```

Only `schemaVersion`, `id`, `name`, and `role` are required when a file is
present. The `prompts` object and every field inside it are optional. Unknown
fields are rejected, and names must be nonblank. IDs are case-sensitive,
1–128 ASCII letters/digits/underscores/hyphens, starting with a letter or digit.
The current sequential-worker runner accepts only the two filenames/roles above;
this is not yet a catalog of dynamically selectable personalities.

Personality additions supplement, never replace, the role contract. They describe
tone, expertise, and working preferences, not the workflow protocol. Model
selection, credentials, and execution state do not belong in personality files.
There is no separate instruction-file reference.

## Prompt additions and insertion points

Both roles accept `prompts.instructions`, `prompts.firstPrompt`,
`prompts.firstReply`, and `prompts.finalAnswer`. Only orchestrators accept
`prompts.subagentReview`; that field is rejected for subagents. All values must
be strings. An omitted `prompts` object, `{}`, and individual omitted fields are
valid. Empty strings are valid additions too.

The matching harness-owned template controls placement with this exact marker:

```text
{{ OPTIONAL_PERSONALITY_ADDITION }}
```

For example, a harness `firstReply` template can contain:

```text
I will verify the outcome before reporting success.
{{ OPTIONAL_PERSONALITY_ADDITION }}
```

Composition happens once, during configuration loading:

- Each marker in the harness template is replaced with that slot's addition.
- If the addition is omitted, the marker is removed.
- If an addition is supplied but the template lacks the marker, loading fails
  with the personality ID and slot name. This also applies to explicitly supplied
  empty strings; omit the field if the template has no insertion point.
- Inserted text is literal, including whitespace, dollar signs, and markers.
  It is not processed a second time. No other template syntax is supported.
- Shared guidance, handover format, context-handback prompts, and tool policy
  cannot be customized through `prompts`.

The editable role slots include marker-only defaults. With no addition these
resolve to whitespace, so they do not seed an assistant reply or enable a
completion reminder. Filling `prompts.firstReply` or `prompts.finalAnswer` enables
that slot without changing its message role or timing.

**Migration:** move the old top-level `instructions` value to
`prompts.instructions`. The old field is rejected rather than silently appended.
Both sibling environment configurations have been migrated. Historical saved
run configurations are not reinterpreted using the new input schema.

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
- `source/agents/orchestrator.ts`: `instructions`, `firstPrompt`, `firstReply`,
  `finalAnswer`, and `subagentReview`, plus the editable `planTemplate` constant.
- `source/agents/subagent.ts`: `instructions`, `firstPrompt`, `firstReply`, and
  `finalAnswer`, plus the handover format and context-handback prompt. The format
  guides the agent but is not enforced as a submission prerequisite.
- `source/extensions/workflow.ts`: workflow tool descriptions, unchanged in this
  refactor. Schemas and handlers follow the text section.
- `source/backend/workflow.ts`: workflow state and persistence logic. Diagnostic
  errors stay near their checks.

Prompt builders live below the text sections. The editable slots are multiline
strings; marker-only slots are intentional scaffolding for authoring guidance,
not a validated live-model prompting strategy. Do not add inline behavioral prose to
`runner.ts` or `pi.ts`.

| Slot | Role and timing |
| --- | --- |
| `instructions` | System-role guidance, composed with shared harness instructions and optional personality. |
| `firstPrompt` | Initial user-role guidance. Orchestrator markers: `{{ REQUEST }}`, `{{ PLAN_TEMPLATE }}`. Subagent markers: `{{ ASSIGNMENT }}`, `{{ REQUEST }}`, `{{ PLAN }}`, `{{ HANDOVER_TEMPLATE }}`. |
| `firstReply` | Assistant-role history seeded once immediately after that initial user message, before the first model call. Blank means no seed. |
| `finalAnswer` | User-role reminder after a successful text-only stop with no terminal workflow action. Blank disables it. |
| `subagentReview` | Orchestrator-only user-role guidance after a handover, followed by attempt ID, stop reason, and handover as JSON. |

Orchestrator request and plan markers expand in one pass when building the initial
message. Inserted request and plan content is not recursively substituted. The plan
format comes from `planTemplate` at the top of `source/agents/orchestrator.ts` and is
saved in the run snapshot. Without a request marker, request JSON is appended as a
fallback, including for empty guidance. Subagent markers likewise expand in one
pass: the delegated assignment, original user request, saved plan at dispatch,
and snapshotted handover format. With no saved plan, the runner supplies an empty
plan string. Missing request or plan context for a referenced
marker is an error. Without an assignment marker, assignment JSON is appended.
These data markers are supported in `firstPrompt`. The subagent also supports
`{{ HANDOVER_TEMPLATE }}` in `instructions`, substituting the snapshotted format
inline in one pass instead of appending it again. Without that marker, the format
is appended as before. The composed system instructions are frozen separately
from the authored prompt slots. Handover review data remains appended as JSON
with its explicit untrusted-content boundary.

The first reply is a complete synthetic assistant message, not a partial-token
prefill and not a user-role custom message. Pi persists it in JSONL and exports.
It is labeled with provider `refainery` and model `firstReply`, has zero usage,
and does not create a model-inference record. Later rounds do not seed it again.

A final-answer reminder is sent only for `stopReason: stop`, with no error and
no tool-call content. A confirmed `spawn_subagent` is a valid orchestrator yield,
not a missing completion. There is at most one reminder per externally prompted
round, sharing that round's timeout and the run's inference budget. No reminder
is sent after errors, aborts, truncation, or a confirmed completion. If the agent
still omits its workflow tool, normal interruption/recovery handling applies.
Context-limit handback retains its separate, stricter path.

Each new run freezes the fully composed system instructions, original optional
additions (`personalities[].personalityPrompts`), original harness templates
(`agentTemplates`), resolved text (`agentText`), tools, and extension source/hashes.
The runner and session adapter use the resolved text; they do not re-expand it
or reread personality files during the run. Old checkpoints without these fields
remain readable. Changing either repository does not rewrite earlier snapshots.
Automatic replay or recovery remains unsupported.

## Checks

`python3 refinery.py test check` runs structural schema tests, loader/default and
composition tests, seed persistence/export tests, workflow contracts, and real
scripted Pi workflows with and without personality files and completion reminders,
all inside Docker. No model credentials are needed.

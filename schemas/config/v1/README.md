# Configuration v1: agent personalities

`agent.schema.json` defines one self-contained JSON file per personality under
`refAInery-config/<test|prod>/agents/<id>.json`. The application owns this schema;
the configuration repository owns the definitions. Both environments use this
same schema and backend. Historical presentation fixtures are separate.

All six fields are required; unknown fields are rejected:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `id` | Stable personality ID; 1–128 ASCII letters/digits/underscores/hyphens, starting with a letter or digit |
| `name` | Nonblank display name |
| `role` | `orchestrator` or `subagent` |
| `instructions` | Nonblank embedded instructions; Markdown allowed, whitespace preserved |
| `availableTools` | Explicit array of unique server tool IDs; empty means no tools |

A personality is reusable configuration, not a session or attempt. Model
selection, requested/actual model identity, credentials, and execution state do
not belong here. JSON strings can use `\n` for multiline instructions; there is
no separate instruction-file reference.

## Backend validation and enforcement

Structural validation uses JSON Schema Draft 2020-12. The configuration loader
must additionally reject duplicate personality IDs, basename/ID mismatches,
unknown tool IDs, and tools disallowed by role or server policy. IDs are
case-sensitive. A wildcard is not a tool ID; omitted tools are not granted.
Adding tools to the catalog must never expand an existing allowlist implicitly.
Do not silently drop an invalid tool or silently enable default Pi tools.

The server owns tool implementations and exposes only the resolved allowlist to
each agent. Workflow delegation is restricted to orchestrators; subagents cannot
delegate. Tool permissions must be enforced outside the instructions. Broad
shell access can bypass the absence of dedicated tools, so workspace/network
isolation requires separate execution-environment enforcement.

At run creation, freeze the complete personality definitions, resolved tool
allowlists, and tool catalog/implementation version with the run configuration.
Each attempt references its personality ID in that snapshot. Reject recovery
when the required tool implementation is unavailable rather than silently
substituting changed behavior. Active runs do not reread edited personalities.
The supervised checkpoint now includes these frozen definitions and the fixed
role-specific catalog implemented in `source/backend/config.ts`. A generalized
top-level configuration schema and recovery mechanism remain future work.

## Initial definitions

The sibling configuration repository contains `orchestrator.json` and
`worker.json`. Production definitions both allow `web_search`. The worker additionally allows `web_fetch`
and Pi's standard `read`, `write`, `edit`, and `bash` tools. The orchestrator also
has `update_plan`, `spawn_subagent`, and `finish_request`; the worker has
`finish_task`. Test definitions omit web capabilities. The application-owned
`source/extensions/workflow.ts` delegates persistence to the backend.
The reviewed `source/extensions/web-search.ts`
provides session-scoped provider-native search/fetch declarations, not local Pi
tool registrations. The future server catalog must distinguish native provider
capabilities from local tools and validate transport support before use.

Neither definition is execution-ready merely because it passes structural
validation. The backend must resolve every tool/capability, explicitly select
local Pi tools, and load only reviewed extensions with the frozen allowlist.
Ambient extensions must not be allowed to re-enable denied capabilities. See the
application's `source/extensions/README.md` for the web extension contract.

The supervised runner now loads these configurations, freezes run snapshots,
selects exact tools, and routes worker filesystem/shell operations into an
isolated Docker workspace. See `docs/supervised-milestone.md` for boundaries;
structural validation is not a substitute for runtime enforcement.

## Contract checks

`python3 refinery.py test check` runs the Draft 2020-12 contract suite in Docker,
including filename/ID matching and cross-file uniqueness for the test config.
No host Python package installation, Node setup or model credentials are needed.
The shared backend separately validates role-specific tool catalog membership. Identifier patterns use a strict end-of-input
assertion to reject final newlines, which a bare `$` can accept.

# Configuration v1: agent personalities

`agent.schema.json` defines one self-contained JSON file per personality under
`refAInery-config/prod/agents/<id>.json`. The application owns this schema; the
configuration repository owns the definitions. This is not the existing test
fixture schema and does not activate production configuration loading.

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

## Backend validation and enforcement (not implemented)

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
The enclosing configuration/snapshot schemas and tool catalog remain undefined.

## Initial definitions

The sibling configuration repository contains `orchestrator.json` and
`worker.json`. The orchestrator deliberately has no tools until the workflow tool
contract is defined. The worker requests `read`, `write`, `edit`, and `bash`;
these names are intended catalog IDs, not proof that a server implementation or
sandbox exists. Neither definition is execution-ready merely because it passes
structural validation. The backend must validate all tool references before use.

The runtime loader, policy enforcement, tool catalog, run snapshots, and Pi
integration are not implemented by this schema slice.

## Contract checks

The optional contract suite uses a real Draft 2020-12 validator, independently of
Node runtime dependencies. It checks valid/invalid shapes and optionally validates
actual config files, including filename/ID matching and cross-file uniqueness:

```sh
python3 -m venv /tmp/refainery-schema-check
/tmp/refainery-schema-check/bin/python -m pip install jsonschema==4.26.0
/tmp/refainery-schema-check/bin/python tests/check-agent-schema.py \
  ../refAInery-config/prod/agents/*.json
```

Run from the application checkout. This suite is separate from `npm test` and
requires no model calls or credentials. Tool catalog membership cannot be checked
until that catalog exists. Identifier patterns use a strict end-of-input
assertion to reject final newlines, which a bare `$` can accept.

# Storage v1: intake and supervised workflow

`request.schema.json` defines the first production storage record. The fictional
example is `examples/storage/v1/request.json`, relative to the application root.
It is not production data or part of the dashboard's presentation fixtures.

A request records intake only:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1` |
| `id` | Stable application-assigned identity, unique within storage |
| `prompt` | Original prompt, with at least one non-whitespace character |
| `receivedAt` | Application-recorded UTC receipt time, ending in `Z` |
| `source` | `manual`, the only initially supported source |

All five fields are required; unknown fields are rejected. IDs are 1–128 ASCII
letters, digits, underscores, or hyphens, beginning with a letter or digit.
This allows several ID-generation strategies without allowing path separators.

Use a JSON Schema Draft 2020-12 validator with `date-time` format assertions
explicitly enabled. The timestamp pattern enforces UTC spelling; format
validation checks the date/time itself. Schema validation does not enforce ID
uniqueness, record immutability, or the absence of secrets in free-form text;
those remain application responsibilities.

Once accepted, the request remains unchanged. Queue position, execution status,
run identity, provider/model selection, and results do not belong in this record.
`checkpoint.schema.json` now defines the separate supervised run state. The
backend validates requests/checkpoints and durably publishes them; intake lives
at `requests/<request-id>.json`. See `docs/supervised-milestone.md` for file layout,
explicit launch commands, and the no-automatic-recovery boundary.

Related workflow contracts in `SPEC.md`:

- Each subagent handback saves a Markdown handover, then a Pi session HTML export,
  then a checkpoint referencing both files and the producing attempt/session.
- Only the end of the overall run exports the orchestrator session; the final
  checkpoint references that HTML file. Other checkpoints do not trigger exports.
- Run configuration freezes the allowed provider/model choices with
  `contextWindow: 250000`. This capacity must leave room for handover; it is not
  an exact handover trigger. Each subagent assignment records its selected model.

- Each inference call preserves `requestedModel` and provider-reported
  `actualModel` separately, including unknown/unresolved actual identities.
  Attempts may reference calls with different actual models.
- Startup and hourly registry fetches retain immutable catalog/pricing snapshots
  plus refresh status. Each inference references its dispatch-time snapshot;
  stale/unavailable prices and provider-reported costs remain explicit and
  separate from registry-derived estimates. See `SPEC.md` sections 5.1–5.3.

These fields belong in future run/configuration/attempt/inference records and
registry snapshots, not requests. Registry refresh and per-call persistence are
implemented in the supervised backend; their standalone JSON schemas remain
follow-up work.

The `/v1` dashboard now previews this **full agreed workflow**, using separate
provisional fixtures documented in `refAInery-storage/test/legacy/v1/README.md`. Its restored
execution timeline uses explicitly recorded fixture observations, not inferred
checkpoint-save times. The fixture shapes do not finalize the production
checkpoint/configuration/assignment schemas, and do not add fields to requests.

## Supervised checkpoint schema

`checkpoint.schema.json` covers the supervised runner: one request, sequential
workers, complete checkpoint revisions, frozen configuration,
orchestrator turns, task/attempt identity, plan revisions, handover/export state,
next-action decisions, and idempotency receipts. Receipt `argsHash` values prevent
embedding plan/handover text in checkpoints. Terminal outcomes retain the
orchestrator's `resultSummary` separately from its rationale.

Apply Draft 2020-12 validation with date-time assertions. The application also
checks frozen-configuration equality, monotonic revision/history preservation,
sequential execution, and valid handback/export relationships. Runtime validation
is in `source/backend/validation.ts`; the backend tests exercise the actual schema.
A schema-valid file alone does not establish durable publication, worker liveness,
or permission to replay an uncertain action. A run may finish without any plan or
worker; decision `plan` and attempt `planRevision` are nullable. Non-null attempt
plan references must name a saved revision. Multiple tasks are supported, each
with one attempt; new worker assignments are not retries of uncertain executions.
The backend records absences instead of fabricating files. Catalog v3 records the
relaxed workflow policy; historical v1/v2 catalogs remain readable.

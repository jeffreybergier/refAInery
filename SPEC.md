# refAInery — working specification

**Updated:** 2026-10-25

This document covers the previews, agreed workflow, and first supervised Pi
milestone. `docs/supervised-milestone.md` specifies the implemented backend's
narrower operational limits, file layout, launch commands, and unverified coverage.
It is not a roadmap for a larger agent platform.

## 1. Implemented web server and dashboard

refAInery is a Node.js/TypeScript application with a dark Bootstrap dashboard.
Its offline previews display fictional fixtures. The opt-in supervised backend
now executes a real request with one worker, persists the workflow, and feeds v1.
It does not yet automatically drain the queue or resume interrupted work.

`/` redirects to `/v1`. `/v1` presents the full agreed workflow below; `/v2`
preserves the original execution-oriented test dashboard. Both remain read-only.

### V1 workflow dashboard

V1 retains the shared wall-clock timeline, selection, keyboard navigation,
zoom/history controls, and fixed-height inspector. Its fictional work follows
one active run and one subagent at a time, with orchestrator planning/review
turns between assignments. Pending tasks are inspected without execution bars;
queued requests remain outside the execution timeline.

The page displays request intake, separate FIFO queue membership, run status and
phase, latest-checkpoint-derived metrics, attempt history and interruption/retry
reasons, separate execution/review outcomes, applied orchestrator decisions,
Markdown plans/handovers, session identities, export references, and frozen model
configuration. The outcome ring measures accepted/rejected attempt handovers,
not correctness or original-request completion. An accepted context-limit
handover is still partial progress. The orchestrator's shared export is linked
only after run end, never generated for individual turns.

The finalized request records remain in `source/fixtures/requests-v1.json`.
Separate `source/fixtures/workflow-v1.json` records model the agreed queue,
configuration, run, checkpoint, task, attempt, and review concepts. The exact
record shapes, observed execution/turn times, review times, checkpoint times,
display labels, and export-state encoding are **provisional fixture conventions**,
not finalized production schemas. Checkpoint-save times are never substituted
for execution times. Every illustrated snapshot is complete, but the fixture
shows selected milestones rather than an exhaustive production transition log.
See `source/fixtures/README.md` for the precise preview contract.

The latest validated snapshot drives each run; repeated attempts in earlier
snapshots are not double-counted. The inspector exposes earlier snapshots.
Run-relative sample Markdown, HTML, and labeled session placeholders live under
`source/fixtures/workflow-v1/`; none are real Pi files or exports. Referenced
Markdown/HTML can be served in test mode; sessions are not served. HTML remains
script-free and sandboxed; Markdown is rendered as text.

Only genuinely undefined data remains unavailable: token history/usage, live
activity/heartbeat, factory stop/idle control, general output-artifact inventory,
and tool policy. Configured context capacity is not measured usage.

`/api/v1/preview` validates bundled requests, all workflow snapshots, frozen
configuration, sequential execution, handback/review boundaries, FIFO linkage,
and referenced files at refresh and test startup. Invalid data or missing files
clear stale displays; there is no rollback to an earlier checkpoint. This is
fixture validation, not production persistence, orchestration, or recovery.
Production mode loads neither set of fixtures.

### Preserved v2 dashboard

The v2 dashboard has three sections:

- **Factory Operations:** simulated factory state, execution/queue counts,
  subagent outcomes, and input/output token history.
- **Factory Floor:** a shared wall-clock timeline with lanes per run, execution
  bars, zoom/history navigation, and a fixed-height selection inspector.
  Orchestrators and subagents are labeled separately. Unstarted tasks appear in
  the inspector, not as past executions. Selection and navigation survive valid
  fixture refreshes.
- **Factory Specification:** agent definitions from the configuration fixtures.

The inspector shows available attempt/turn identity, execution and review status,
model/provider, timing, activity, usage, summaries, and artifact labels. Finished
execution does not mean an accepted or correct result. Missing information stays
explicitly unknown; zero usage is different from unavailable usage. Review waiting
is not execution time, and last activity is not a worker heartbeat.

### Preview data and server boundaries

- `refAInery-config/test/config.json` uses configuration fixture v1.
- `refAInery-storage/test/workshop.json` uses storage fixture v2, including
  optional execution `details` for inspector metadata.
- `refAInery-storage/test/transcripts/` contains labeled sample HTML, not Pi
  exports. Only referenced transcripts are served, in separate script-free,
  sandboxed pages.
- Fixtures are validated and reloaded on refresh. Invalid data produces a visible
  error rather than retaining stale telemetry or falling back to production.
- The server provides explicit asset routes, `/api/preview`, and test transcript
  routes. It accepts GET/HEAD only; there is no work-submission or write API.
- Bootstrap assets are local. Path escapes are rejected, and security headers
  restrict browser content. Artifact labels are not download links.
- Outside test mode, the default dashboard shows empty production states.
  `REFAINERY_BACKEND=1` with explicit storage activates the saved production reader
  and hourly registry service. The separate supervised runner loads config and
  executes Pi. Live heartbeat/activity telemetry is not implemented.

The v2 fixture format is a presentation contract, **not the production storage
schema**. Its validation lives in `source/preview.ts` and its tests. Its fictional
parallel work and per-turn transcript examples are preserved for design reference,
not claims of compliance with the sequential production workflow below. V1 intake
request fixture validation lives in `source/intake-preview.ts`; provisional
workflow validation and document loading live in `source/workflow-preview.ts`.

### Running and checking

`python3 serve.py --test` launches the preview in the published Altivec container,
with read-only sibling test directories and fake credentials. It skips 1Password,
GitHub authorization, storage cloning, and SDK installation. The launcher
publishes the web port on host loopback only.

The non-test launcher obtains credentials through 1Password at launch. Secrets
must not be written into schema records, fixtures, configuration, or logs; no
`.env` files. See `README.md` for launcher prerequisites and dependency caching.

Portable checks: `npm run check` and `npm test`. These do not run live agents.

## 2. Intake: the first production schema

Every incoming piece of work is a **request**, separate from its execution.
Different intake sources may eventually produce the same request shape; only
manual intake is defined initially.

The implemented JSON Schema is `schemas/storage/v1/request.schema.json`.
A fictional example is `examples/storage/v1/request.json`:

```json
{
  "schemaVersion": 1,
  "id": "request-example-001",
  "prompt": "Add a search box to the fictional workshop dashboard.",
  "receivedAt": "2026-10-24T14:00:00Z",
  "source": "manual"
}
```

All five fields are required; unknown fields are rejected. The ID is stable and
unique within storage. The prompt must contain non-whitespace text and is
preserved as received. Receipt time is UTC. The schema README describes exact
validation requirements, including enabled date-time format assertions.

A request remains unchanged after acceptance. Queue position, run status,
provider/model selection, and results belong elsewhere. This record's schema,
example, fixtures, and supervised production validator/writer exist. Intake is
currently an explicit CLI operation, not a browser write API.

## 3. Queue and orchestration — agreed design

The full design places top-level requests in a **FIFO queue** and starts the
oldest request when free. The current milestone is deliberately supervised:
`run-once.py` accepts one request, requires no previously queued/unfinished work,
runs one worker, and stops. Automatic dispatch and multiple subagents per run
are follow-up work, not enabled behavior.

- One top-level run is active at a time.
- All subwork stays inside that run, ahead of the next queued request.
- Only one subagent works at a time.
- The next request starts after the current run completes, fails, or is cancelled
  and its workers have stopped.
- No priorities or scheduled start times in v1.

Each run has one orchestrator:

```text
Request → orchestrator makes a plan → launches one subagent
                  ↑                           ↓
                  └──── reviews handover ─────┘
                  ↓
          launches another subagent OR finishes the run
```

Only the orchestrator creates subagents. Subagents cannot delegate or pass work
directly to another subagent. The orchestrator owns the plan and decides whether
the original request is finished.

The implemented tools are `update_plan`, `assign_subagent`, `finish_run`, and
worker-only `submit_handover`. Their thin Pi definitions live in the config repo;
the backend binds caller identity and owns durable transitions. The orchestrator
must save a full Markdown plan in each planning/review turn before assignment or
finalization. Each revision is immutable and each subsequent action references
it. Reviewing uses a prompt plus the next saved action, not a `review_handover`
tool or a required accepted/rejected ceremony. Production records use pending
versus decision-recorded states; preview accepted/rejected examples stay fictional.
Terminal workflow tools must be called alone and yield control.

A subagent writes a handover and stops when its assignment finishes or it reaches
the context handover boundary, intended to be Pi's request to compact context.
The exact Pi compaction boundary still needs live validation. The milestone
disables compaction/retries and uses a conservative application context guard to
request handback with reserve space; this is not a verified replacement for that
boundary. Automatic continuation through compaction is not intended behavior. A crash without a handover is an interruption, not a completed result.

On each normal handback, including a context-limit handback:

1. The subagent writes its Markdown handover and stops.
2. The application exports that subagent's Pi session to an HTML file.
3. The application saves a checkpoint referencing both files.
4. Control returns to the orchestrator to review the handover and decide next steps.

The orchestrator's session is exported only when the overall run ends, not after
individual turns. The final checkpoint references that HTML export and records
the run's outcome. HTML is for human inspection; the handover is for continuing
work. Export failures must remain explicit and recoverable, never represented as
successfully saved files or repaired by rerunning the agent.

## 4. Handover document — agreed format

Store the handover as Markdown using this exact starting format:

```markdown
## Goal
[What the user is trying to accomplish]

## Constraints & Preferences
- [Requirements mentioned by user]

## Progress
### Done
- [x] [Completed tasks]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues, if any]

## Key Decisions
- **[Decision]**: [Rationale]

## Next Steps
1. [What should happen next]

## Critical Context
- [Data needed to continue]

<read-files>
path/to/file1.ts
path/to/file2.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

Application bookkeeping records which subagent attempt produced it and why it
stopped: `completed` or `context-limit`. Missing handovers after interruption stay
explicitly absent. Next Steps are recommendations; only the orchestrator decides
what happens next. File lists are agent-reported, not a verified change audit.

## 5. Providers and models — agreed design

Configuration defines the allowed provider/model choices. Initially there is
**one choice**, rather than a hard-coded rule that all agents must always use the
same model.

- Application configuration selects the orchestrator's own model so it can start.
- The orchestrator selects a model from the allowed list for each subagent.
- Each assignment records that selection; the scheduler validates it before launch.
- The allowed list and orchestrator selection are frozen in the run's configuration
  when it starts. Configuration changes affect future runs, not the active run or
  its recovery. No silent model fallback.
- Provider/model identifiers are stored, never credentials.
- V1 hardcodes `contextWindow` to **250000 tokens** in the allowed model definition,
  for both orchestrator and subagents. Freeze it with the run configuration and
  explicitly supply it to Pi rather than inheriting a changing default.
- This is the configured context capacity, not an exact handover trigger. The Pi
  integration must reserve room to produce the handover before context is exhausted
  and verify compaction behavior. The selected backend must support this capacity;
  changing metadata cannot increase its actual limit.

Proposed configuration shape (identifiers are placeholders, not a final schema):

```json
{
  "models": [
    {
      "id": "default",
      "provider": "provider-id",
      "modelId": "model-id",
      "contextWindow": 250000
    }
  ],
  "orchestratorModel": "default"
}
```

A subagent assignment would record `"model": "default"`.

### 5.1 Requested and actual model identity

Persist both identities for every inference call, including orchestrator calls,
subagent calls, and retries, rather than only once per run or agent session:

- `requestedModel`: the exact model identifier sent to the provider, preserving
  aliases and routing syntax. Save it before dispatch; never replace it with the
  resolved model. Keep the provider identity separately to disambiguate names.
- `actualModel`: the model identifier reported by the provider for that call.
  Initially `null`; leave it unknown if a failure, interruption, or adapter
  limitation prevents observation. Never infer it from the requested identifier,
  registry contents, or the model's own generated text.
- Retain the provider response/generation ID and the source of the reported model
  when available, so later reconciliation is possible. If the provider reports
  only an alias, preserve it but explicitly mark resolution as unresolved; do not
  claim that it identifies immutable weights or a specific underlying revision.
- Each retry is a separate inference call. A session may use multiple actual
  models; attempt/run summaries must not hide that behind one model label.

The dashboard must show requested and actual models separately, with an explicit
unknown/unresolved state. These identities belong in future inference records
referenced by attempts and checkpoints, not in immutable intake requests.
Freezing configuration freezes the requested selection, not a provider's alias
mapping. No application-selected fallback is allowed silently.

The Pi spike must verify that the adapter exposes the provider-reported identity,
not merely an echo of the configured model. The selected identifier's routing
semantics also require verification; its spelling alone is not evidence.

### 5.2 Hourly model registry snapshots

The production server owns registry refresh independently of agent execution or
browser refresh. Fetch the configured `MODEL_REGISTRY` at startup and every hour
(3,600 seconds) while running, including while the factory is idle. Use bounded
request timeouts and one in-flight refresh; do not overlap fetches or queue a
backlog of missed hourly ticks. Test preview mode stays offline.

Persist every successfully validated full catalog as an immutable snapshot in
production storage, including unchanged successful hourly observations. A snapshot
records a stable ID, schema version, provider, credential-free source endpoint,
UTC fetch time, and model entries with provider identifiers, capabilities,
context limits, and pricing. Preserve pricing decimal strings and their currency
and units, including cache or other pricing categories when supplied. Missing
prices remain unknown, never zero. Do not save authentication headers or secrets.
Complete all pages if the configured API paginates; a partial catalog is not a
successful refresh.

Use the application-owned writer and durable atomic publication. Publish the
new current snapshot only after validation and persistence succeed; retain older
snapshots for historical interpretation. A current-snapshot pointer is a
rebuildable index, not the sole copy of the catalog. Registry refreshes do not
change a running workflow's frozen allowed models or context configuration.

Persist refresh status separately: last attempt, last successful persisted fetch,
next scheduled attempt, and a sanitized failure category. On network, validation,
or persistence failure, retain the last good snapshot and expose degraded status.
Its prices become stale once the last successful fetch is an hour old. With no
valid snapshot, prices are unavailable. Retry transient failures with bounded
backoff without losing the hourly schedule; recovery/restart reloads persisted
history and immediately attempts a fresh fetch. Never label a failed refresh as
current data. Hourly polling cannot guarantee instantaneous provider prices.

### 5.3 Price provenance and reported costs

Each inference call records `registrySnapshotId` for the persisted catalog
current at dispatch (or `null` when unavailable), along with its freshness at
that time. Use the reported actual model to look up estimated prices in that
snapshot; unresolved identities or missing entries remain unpriced. Never
substitute an alias's price or a different model's price silently.

Registry-derived amounts are estimates, not proof of the amount charged. Preserve
provider-reported cost, currency/unit, and usage separately when available; missing
cost is unknown, not free. Do not overwrite provider-reported costs with local
estimates. Calculations must preserve decimal precision and document cache and
other applicable pricing assumptions. An hourly refresh must not retroactively
reprice old calls; any current-price comparison is a separately labeled view.
Snapshot fetch time records when we observed prices, not their effective date.

Implementation checks must cover different requested/actual models, absent or
unresolved actual identities, multiple actual models within a session, retries,
startup/hourly/idle refreshes, unchanged catalogs, invalid or partial responses,
timeouts, write failure, stale/no-catalog states, restart, non-overlapping refresh,
and historical snapshot references remaining unchanged after new prices arrive.

The supervised backend implements registry fetching, immutable snapshots,
per-inference intent/results, provider model identity and cost observations, and
saved-state dashboard inspection. Registry/inference standalone JSON schemas,
financial estimates, and interval charts remain follow-up work. See the milestone
document for implementation limits and explicit unverified coverage.

### 5.4 Agent personalities and tool allowlists

`schemas/config/v1/agent.schema.json` defines one self-contained JSON file per
personality under `refAInery-config/prod/agents/<id>.json`. Required fields are
`schemaVersion`, `id`, `name`, `role`, embedded `instructions`, and
`availableTools`. Roles are `orchestrator` and `subagent`; model selection and
execution state remain separate. Unknown fields and duplicate tool IDs are
rejected. Instructions may contain Markdown; no instruction-file link is needed.

The server owns the tool catalog. Each personality explicitly selects a subset
by stable tool ID: empty means none, missing is invalid, and unknown or
unauthorized IDs must fail validation before execution. New catalog tools do not
expand existing permissions. The server must expose only the resolved allowlist,
not default tools plus advisory instructions. It enforces orchestrator-only
delegation and sequential work. Shell access requires separate workspace/network
isolation; an allowlist alone is not a sandbox.

Freeze complete personalities, resolved tool permissions, and the tool catalog/
implementation version in each run's configuration. Attempts reference a frozen
personality ID. Configuration edits affect future runs only; recovery must not
silently substitute changed tool implementations. The supervised checkpoint schema includes the frozen configuration. The loader
validates the initial two personalities against the role-specific catalog and
explicitly loads their tools; arbitrary catalog plugins and recovery are not
implemented.

The config repository contains orchestrator and worker personalities. Both allow
`web_search`. The worker additionally allows `web_fetch` and Pi's standard `read`,
`write`, `edit`, and `bash` tools; the orchestrator has no file/shell access.
The reviewed `prod/extensions/web-search.ts` adapts the operator's existing
provider-native web extension to take an explicit, frozen session allowlist.
These web capabilities modify provider payloads rather than register local tools.
The future server catalog must distinguish native capabilities from local tools,
validate provider support, and disable ambient extension discovery. A later or
unreviewed extension must not be able to silently re-enable denied capabilities.

The supervised runner activates these definitions and workflow tools, with
worker file/shell operations delegated to an isolated Docker workspace.
Provider-native web behavior still needs live verification; the first live
milestone intentionally makes no web search/fetch calls. See `schemas/config/v1/README.md` and the configuration
repository's `prod/extensions/README.md` for validation and loading contracts.

## 6. Checkpoints — saved run state

A **checkpoint** is a complete saved snapshot of where a run stands. It lets the
application recover its progress after restarting instead of guessing from a
conversation transcript.

It records or references:

- The run and original request identities, status, and current execution phase.
- The frozen configuration and current plan.
- Subagent tasks and attempts, including the active attempt, model selections,
  and earlier outcomes.
- Pi session identities and locations.
- Handovers awaiting review and orchestrator decisions already applied.
- Run-relative paths to each stopped subagent's handover and exported session HTML,
  associated with its attempt and Pi session identity.
- The orchestrator's exported session HTML in the final checkpoint.

Save a new numbered JSON file at meaningful transitions rather than overwriting
the previous snapshot:

```text
checkpoints/
  000001.json   # Run created
  000002.json   # Subagent assignment saved, ready to dispatch
  000003.json   # Subagent stopped; handover and HTML saved, awaiting review
  000004.json   # Orchestrator decision saved with resulting run state
```

Intermediate checkpoints, such as an assignment saved before dispatch, do not
trigger HTML exports. Subagent handback and overall run end are the export
boundaries. Preserve the Markdown, Pi conversation files, and HTML exports as
separate files; checkpoint JSON references them instead of embedding their contents.

These are illustrative milestones, not a fixed sequence. Each checkpoint is the
complete workflow state, not just a change event. The latest durably committed
snapshot is authoritative. A corrupt checkpoint or missing referenced file must
produce an explicit recovery error, not silent rollback.

Use one application-owned writer. Save referenced documents before committing the
checkpoint, and commit it durably before acknowledging or dispatching subsequent
work. Ignore unfinished temporary writes. Saved dispatch intent does not prove
execution occurred; uncertain actions must not be blindly repeated on recovery.

JSON holds identities and workflow state. Markdown holds plans and handovers.
Pi owns its conversation files; our records reference them rather than redefine
their contents. A checkpoint is not a transcript or a workspace backup.

`schemas/storage/v1/checkpoint.schema.json` now defines the supervised checkpoint
including assignments, attempts, plan revisions, decisions, and frozen config.
Runtime validation also enforces sequential execution and history preservation.
Queue membership is derived from intake/run linkage; it is not an independently
mutable queue file. Registry and inference record contracts currently live in
TypeScript. See `docs/supervised-milestone.md` for the implemented file layout,
durable publication, and explicit operator-recovery requirement.

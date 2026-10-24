# refAInery — working specification

**Updated:** 2026-10-24

This document covers the implemented web preview and the storage/workflow model
agreed so far. It is not a roadmap for a larger agent platform.

## 1. Implemented web server and dashboard

refAInery is a Node.js/TypeScript application with a dark Bootstrap dashboard.
It currently displays fictional, read-only fixtures, not real agent activity.
Pi integration and production orchestration are not implemented.

The dashboard has three sections:

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
- Outside test mode, the dashboard shows empty production states. Production
  configuration/storage loading, live activity, and Pi exports are not implemented.

The fixture format is a presentation contract, **not the production storage
schema**. Its validation lives in `source/preview.ts` and its tests.

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
provider/model selection, and results belong elsewhere. Only this record's schema
and example exist so far; a production validator/writer is not implemented.

## 3. Queue and orchestration — agreed design, not implemented

Top-level requests enter a **FIFO queue**. When the factory is free, it
automatically starts the oldest request as a **run**.

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

A subagent writes a handover and stops when its assignment finishes or it reaches
the context handover boundary, intended to be Pi's request to compact context.
We must verify that boundary and the ability to produce a handover before
implementing it; automatic continuation through compaction is not the intended
behavior. A crash without a handover is an interruption, not a completed result.

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

Proposed configuration shape (identifiers are placeholders, not a final schema):

```json
{
  "models": [
    { "id": "default", "provider": "provider-id", "modelId": "model-id" }
  ],
  "orchestratorModel": "default"
}
```

A subagent assignment would record `"model": "default"`.

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

Save a new numbered JSON file at meaningful transitions rather than overwriting
the previous snapshot:

```text
checkpoints/
  000001.json   # Run created
  000002.json   # Subagent assignment saved, ready to dispatch
  000003.json   # Subagent stopped; handover saved, awaiting review
  000004.json   # Orchestrator decision saved with resulting run state
```

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

**Next schemas remain to be defined one at a time:** the queue, run checkpoints,
configuration/model choices, and subagent assignments/results. Their exact fields,
file layout, and crash-safe persistence are not implemented yet.

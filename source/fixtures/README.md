# V1 workflow design fixtures

These files implement a **read-only presentation of the full agreed workflow in
SPEC.md**, not just the request schema. They are not production storage and do not
finalize the queue/checkpoint/configuration/assignment schemas.

- `requests-v1.json`: an array of immutable records, each conforming to the
  finalized `schemas/storage/v1/request.schema.json`. No workflow fields are added
  to a request.
- `workflow-v1.json`: a provisional test-only envelope with `fixtureVersion`,
  `environment`, frozen `asOf`, a FIFO `queue` of request IDs, and `runs`.
- `workflow-v1/<run-id>/`: run-relative Markdown plans/handovers, sample HTML,
  and explicitly labeled session placeholders. These are not real Pi session
  files or exports, and must not be used to test Pi format compatibility.

## Provisional records

Each run has an identity, request reference, display title, and an ordered list of
complete checkpoint snapshots. The last validated snapshot is authoritative.
The bundled snapshots show selected milestones, **not an exhaustive production
checkpoint log**. They do not implement durable commits, dispatch, or recovery.

Every checkpoint includes:

- Number and `savedAt`; run status, current phase, and run start/end observations.
- Frozen configuration identity, allowed model/provider choices, fixed 250000
  context capacity, and orchestrator model selection.
- Current plan path; orchestrator session identity/path and export state.
- Explicit observed orchestrator turns, each with identity, title, execution
  status, and start/end times. Turns share one session, not separate exports.
- Tasks with identity, title, assigned model, and attempts. A task without
  attempts is planned/unstarted; it does not become a past execution bar.
- Attempts with stable identity/number, selected model, session identity/path,
  execution status/timing, stop reason, handover path, export state, review state
  and time, and explicit retry/continuation reason.
- Applied orchestrator review decisions associated with their producing attempt.

The **exact fields, display titles, execution/turn timestamps, review timestamps,
checkpoint timestamps, and export-state encoding are provisional fixture
conventions**, not additions to the finalized production request schema.
Execution timestamps are separate observations: never derive them from request
receipt, checkpoint-save time, session lifetime, or time spent waiting for review.

Export state is `not-due`, `pending`, `saved`, or `failed`. Only `saved` references
an existing file. Failures carry an explicit error; retries are export retries,
not instructions to rerun an agent. A normal handback has a Markdown handover;
review waits for its HTML export. An interruption has no fabricated handover.
The orchestrator exports its shared conversation only at overall run end.

## What the samples demonstrate

1. A completed search request: a context-limit handback, accepted partial progress,
   an explicitly assigned continuation, final acceptance, and a shared final
   orchestrator export.
2. A release-note request: an interrupted attempt with no handover, an authorized
   retry, and a normal handback awaiting review. A further subtask has not started.
3. A request waiting in the separate FIFO request queue, not an execution lane.

Only one run is active; all observed work is sequential. An awaiting-review run
still occupies the factory even though no execution is in flight. The workflow
phase is not factory-control/worker-health telemetry.

## Rendering and validation

`source/workflow-preview.ts` validates every snapshot, frozen configuration,
request linkage, FIFO ordering, sequential execution, handbacks/reviews, and file
references. Missing/corrupt data or referenced files fail the preview; there is no
fallback to an earlier checkpoint. Paths are restricted and symlinks rejected.
Only referenced Markdown and HTML documents are served, only in test mode; HTML
uses the same script-free, opaque-origin sandbox as v2. Session placeholders are
checked for existence but never served. Markdown is rendered as text, not HTML.

`source/public/workflow.js` projects only each latest complete snapshot into the
shared floor renderer. Counts do not double-count attempts repeated in snapshots.
The outcome ring measures accepted versus rejected **attempt handover reviews**,
not task correctness or request success; accepting a context-limit handover is
not completion. Finished, failed, interrupted, pending review, and run outcomes
remain separate.

No token samples, usage totals, live activity, worker heartbeat, factory stop/idle
control, general artifact inventory, or tool policies are invented. These remain
explicit unknown/unavailable displays. Frozen context capacity is not usage.

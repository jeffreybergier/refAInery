# refAInery — AI Factory Specification

**Status:** Draft 0.1 — starting point for collaborative design  
**Last updated:** 2026-10-24

## 1. Purpose

refAInery is a containerized, Node.js/npm application for designing and operating
an **AI Factory**: a repeatable way to turn a user request and project context
into useful, reviewable work using AI agents and tools.

This document is intentionally an initial working specification, not a
commitment to unresolved product behavior. Decisions and questions that need
collaboration are called out explicitly.

## 2. Confirmed direction

- The project lives in the `Vibing/refAInery` repository.
- It will be an npm application.
- **Pi** will be used as a dependency and the low-level agent/runtime harness.
  refAInery will build its product behavior above Pi rather than reimplementing
  the agent loop.
- The application is intended to run in the published container image:
  `ghcr.io/jeffreybergier/altivec-intelligence:latest`.
- The app will consume that image; it will not modify or build the
  AltivecIntelligence engine image as part of its normal workflow.
- **All application authentication must be sourced at launch through the
  1Password CLI (`op`).** A Python launcher will retrieve the required secret
  values from 1Password and pass them to the container process as environment
  variables (or an equally transient mechanism if a particular integration
  requires it).
- **No `.env` files. No credentials, API keys, access tokens, or other secrets
  written to disk.** Secrets are fetched at launch and exist only in process
  memory/environment for use by the application and its child processes. The
  launcher must not print secret values or place them in command-line
  arguments.
- There will be no `compose.yml` as the application launch mechanism. The
  Python launcher will start the published Docker image directly.
- A launcher and Hello World server exist. The workflow and storage design
  below is agreed direction, not a claim that those features are implemented.
  This phase documents that design; implementation is separate.
- Prompt-based work requests enter a FIFO queue. One top-level run is active
  at a time, with one orchestrator that makes a plan and launches one subagent
  at a time. Every subagent returns a handover to that orchestrator; only the
  orchestrator decides what runs next or whether the work is done. See section
  6.13 for the agreed v1 execution loop and handover format.
- Storage uses JSON workflow checkpoints, opaque Pi conversation files, and
  HTML historical reports. The storage repository is managed inside the
  container on a persistent named volume, not a host checkout bind mount.
- Durable per-inference usage records provide a per-model, per-machine token
  odometer. Cloud-equivalent spend and purchase-price recovery are explicitly
  estimated views, separate from measured usage. This accounting design is
  agreed direction, not implemented telemetry.
- A separate private `refAInery-config` repository defines agent types,
  instructions, policies, workflow defaults, and approved Pi resources. Each
  run uses an immutable snapshot of its resolved configuration, including
  during recovery.

## 3. Product intent (working hypothesis)

The initial product hypothesis is a **personal, project-aware AI workshop**
that helps its operator define repeatable AI workflows, run them against
selected project material, and inspect/review the resulting artifacts.

The name “AI Factory” suggests repeatable production, but does not yet define
what is produced. The first product workflow and its users must be agreed
before implementing that workflow. The orchestration and storage model below
is agreed, while the first concrete output remains open. See
[Open questions](#12-open-questions).

## 4. Goals

1. Run the application and its AI work inside the Altivec Intelligence Docker
   environment, using the image's preinstalled Node.js/runtime and tools where
   appropriate.
2. Use Pi as the underlying harness for model interaction, tool execution, and
   agent lifecycle, while keeping refAInery's domain logic separate and
   testable.
3. Make work observable and reviewable: users should be able to understand
   what was requested, what context/tools were used, and what was produced.
4. Keep project data and generated outputs in explicit, mounted workspace paths
   so they persist after a disposable container exits.
5. Start with a small, useful workflow and add capabilities through explicit
   design rather than building a generic agent platform prematurely.

## 5. Non-goals for the initial version

- Rebuilding or customizing the AltivecIntelligence Docker image.
- Reimplementing Pi's agent loop, model adapters, or tool-calling machinery.
- Automatically modifying files or taking external actions without an agreed
  approval and safety policy.
- Supporting a hosted multi-tenant service, team accounts, or remote job
  scheduling unless later prioritized.
- Assuming that “AI Factory” means training foundation models or operating GPU
  clusters. The likely initial scope is orchestration of existing AI models;
  confirm this product definition before implementation.

## 6. Runtime and repository assumptions

### 6.1 Container environment

The Altivec Intelligence image is a Linux development environment with the
application workspace conventionally mounted at `/repo/user` and the engine at
`/altivec`. Its README describes Node.js 22 as available for the release helper;
verify the exact Node/npm versions in the published `latest` image before
relying on them as a compatibility contract.

The application should run as a consumer of the published image. The current
Python launcher (rather than Compose):

- Uses `ghcr.io/jeffreybergier/altivec-intelligence:latest`; it does not build
  or customize the image during normal application use.
- Mounts the checkout's `source` directory at `/app/source` and uses `/app` as
  the container working directory. This is the current launcher layout, not a
  settled requirement for the eventual application workspace.
- Invoke the 1Password CLI to fetch the required authentication values at
  launch, then start the container with those values available to the
  application as environment variables.
- Avoid writing fetched values to files, `.env` files, temporary files,
  command-line arguments, logs, or other persistent storage. Do not echo
  secrets. Pass values to subprocesses using process environments rather than
  shell interpolation.
- Fail closed if 1Password CLI authentication or a required secret lookup
  fails; do not start the app with silently missing or stale credentials.

The launcher and container may persist non-secret application data only in
explicitly chosen workspace/cache mounts. The precise Python interface,
1Password item/field mapping, and handling of Docker daemon visibility of
container environment variables remain to be specified. No `compose.yml` will
be used to launch the application.

### 6.2 npm application

The repository will have a `package.json` and use npm scripts as the standard
entry points. Initial candidate scripts (names are provisional):

- `npm start` — start the refAInery application.
- `npm test` — run automated tests.
- `npm run check` — run static/type/lint checks selected by the project.

Pi is a runtime dependency. The exact package name, supported version range,
import surface, and Node compatibility must be verified against Pi's current
published package and documentation before implementation. Avoid silently
depending on global Pi installations: package-level dependency management
should make the runtime reproducible.

### 6.3 Container-managed storage checkout

The storage repository is `refAInery-storage`. Mount a Docker-managed named
volume, `refainery-storage`, at `/app/storage`. Do not bind-mount the host's
`Vibing/refAInery-storage` checkout. Git checkout and repository management
continue to happen inside the container.

This replaces the current launcher's disposable clone at `/app/storage`:

1. Attach the named volume and acquire exclusive storage ownership before
   accessing or initializing the checkout.
2. On first use of an empty volume, clone the private storage repository into
   `/app/storage` using launch-time, 1Password-sourced authentication.
3. On subsequent launches, validate and reuse the existing checkout, including
   uncommitted state. Do not clone afresh over existing recovery data.
4. Recover active runs before scheduling new work according to the recovery
   policy below.

Use a lock outside the clone destination or another initialization-safe lock
mechanism so ownership bookkeeping does not prevent cloning into an empty
checkout. An incomplete clone or unexpected volume contents must produce an
explicit recovery error, not trigger destructive cleanup.

Container shutdown/removal must not remove the named volume. The volume is
local persistent storage, not a remote backup. Local durable writes are the
crash-recovery mechanism; Git commits and remote synchronization are separate
operations. Recovery must not depend on a successful commit or push. Do not
run automatic reset, clean, or pull operations over recovery data. Backup,
commit, and synchronization policies remain open; no automatic push is assumed.

### 6.4 Storage layout and ownership

Distinguish these identities:

- **Request:** one incoming prompt-based work item, independent of execution.
- **Run:** the orchestration performed to fulfill one request.
- **Task:** one assigned part of the orchestrator's plan.
- **Attempt:** one execution of a task; retries create new attempts and retain
  earlier outcomes.
- **Inference request:** one actual model invocation, including orchestrator
  calls. An attempt or orchestrator turn may make many requests. An inference
  retry gets a new request ID; duplicate notifications do not.

Use stable identifiers and run-relative paths in refAInery records. The initial
production layout under `/app/storage/prod` is (the repository root also
contains a separate `test/` fixture area; see section 6.11):

```text
storage.json
active/
  <run-id>/
    request.json
    configuration/
      manifest.json
      resolved.json
      instructions/
      resources/
    checkpoints/
      000001.json
      000002.json
    orchestrator/
      turns/
        <turn-id>/
          input.json
          decision.json
    tasks/
      <task-id>/
        attempts/
          <attempt-id>/
            input.json
            result.json
            artifacts/
    pi/
      orchestrator/
      tasks/
        <task-id>/<attempt-id>/
history/
  <year>/<month>/<run-id>/
    ...retained run data...
    report.html
accounting/
  machines/
    <machine-id>/
      000001.json
  models/
    <model-id>.json
  pricing/
    <price-snapshot-id>.json
  comparisons/
    <comparison-id>.json
  usage/
    <year>/<month>/<request-id>/
      000001.started.json
      000002.settled.json
derived/
  accounting/
    ...rebuildable indexes and dashboard summaries...
runtime/
  ...writer-lock metadata and temporary bookkeeping...
```

`storage.json` records the storage-format version and storage identity, never
credentials. `request.json` preserves the original prompt, submission time,
approved context, and a reference to the immutable configuration snapshot
specified in section 6.9. Orchestrator turns preserve the exact input presented
and the structured decision returned. Task attempts preserve exact inputs,
structured outcomes, and artifacts.

Pi owns conversation persistence; refAInery owns workflow state. Keep Pi's JSONL
session files opaque to the application storage schema and reference them by
session identity and path. Use one persistent orchestrator conversation per
run and isolated subagent sessions per attempt. Reopen the recorded session
explicitly rather than selecting the most recent session. Configure Pi storage
inside the run directory; verify the pinned Pi API and relocation behavior
before implementation. A transcript alone is not a scheduler recovery record.

### 6.5 Authoritative JSON checkpoints

Use numbered, immutable JSON snapshots of complete workflow control state.
The highest committed, valid revision is authoritative; older revisions retain
transition history. Do not maintain independently authoritative copies of a
run's plan, inbox, and task statuses. Indexes and UI caches must be rebuildable.
The durable intake queue contract remains to be defined separately from run
checkpoints; section 6.13 establishes its scheduling behavior.
Workflow checkpoints govern scheduling and result acceptance; the independent
usage ledger in section 6.12 governs consumption. Neither substitutes for the
other. Consumed tokens count even if a task fails or its result is rejected.

Each checkpoint records:

- Schema version, run ID, revision, and timestamps.
- Run status, optional parent run, and final outcome when terminal.
- Workflow/application version, configuration snapshot identity, model
  configuration, tool policy, and limits.
- Plan revision, task definitions, and their ordering or prerequisites.
- Attempt statuses, worker identities, timestamps, and Pi session references.
- Result references and their delivery and acceptance states.
- Current orchestrator turn, pending result IDs, and applied decisions.
- Pending approvals and recorded operator decisions.
- The transition that produced the checkpoint and its reason.

Keep large inputs, results, artifacts, and transcripts outside checkpoints and
reference them. Finalize referenced immutable files before committing a
checkpoint. Write each checkpoint to a temporary sibling file, flush it, rename
it to its final numbered name, and flush the containing directory where
supported. Only then acknowledge the transition or dispatch subsequent work.
The persistence implementation must validate these guarantees on the mounted
filesystem, including forced interruption tests.

Ignore unfinished temporary files during recovery. A corrupt committed
checkpoint or a missing referenced file requires explicit recovery; do not
silently roll back to older state and potentially repeat actions. Unreferenced
files from an interrupted transition are not proof that work was accepted.

Allow only one scheduler/workflow-state writer per storage directory. V1 runs
one subagent at a time, with workflow changes submitted through that writer
rather than by editing checkpoint files. Their separate Pi session files remain owned by
the respective agent sessions. Locks must prevent overlapping writers across
containers; stale ownership recovery must not rely on a PID alone.

### 6.6 Result delivery, recovery, and archival

Subagent results always return to the orchestrator. Finishing an attempt does
not itself authorize subsequent work: the orchestrator reviews its handover and
commits a decision before another subagent starts. Results include stable
result, task, and attempt IDs; outcome; the handover reference and stop reason;
summary; structured output; artifact references; and error details when
applicable. Failures and cancellations also return outcomes. An interruption
without a handover is recorded explicitly, not filled with an invented document.

Persist result handling through these stages:

1. Result durably recorded and pending orchestrator review.
2. Result included in a recorded orchestrator turn.
3. Orchestrator decision committed with the resulting workflow-state change.

Serialize orchestrator turns and launch at most one subagent at a time. Persist
inputs before dispatch and decisions before applying subsequent actions. Stable
result and decision IDs prevent duplicate application during recovery. The
orchestrator may accept, reject, retry, revise its plan, or add work. Preserve
executed task definitions; represent revision work as new tasks rather than
rewriting execution history. Subagents never create other subagents.

On recovery, reconcile incomplete turns and recorded results, and mark attempts
whose workers are gone as interrupted. Never assume a recorded running state
means a worker still exists. Never treat a Pi conversation resume as proof of
safe external-action replay.

- Never-started tasks may be scheduled according to policy.
- Recorded, unreviewed results return to the orchestrator.
- Committed decisions must not be applied again.
- Interrupted read-only attempts may resume or retry according to policy.
- Attempts with uncertain external effects require reconciliation or approval.
- Terminal runs missing a report have their report regenerated.

Exactly-once execution is not promised. Use action-specific idempotency where
available and conservative handling of uncertain effects. Whether recovery
continues automatically or waits for operator approval remains open.

Completed, failed, and cancelled runs move into `history/` only after workers
stop and the terminal checkpoint is committed. Retain the JSON checkpoints,
inputs, results, configuration snapshots, artifacts, and Pi JSONL alongside
`report.html`; HTML is a human-readable view, not the sole historical record.
Make report generation and archival restartable, using a same-volume directory rename and recovery
logic that recognizes both active and archived terminal runs.

Reports show the request, outcome, plan, decisions, attempts, retries, failures,
interruptions, artifacts, timing, and available usage information. Individual
Pi HTML exports may supplement the overall report. Escape untrusted text and
sanitize permitted markup; never execute generated agent HTML in the report.
Prevent credentials from entering transcripts, artifacts, or exports. Private
prompts and source content also require review before sharing or remote sync.

Archived runs are immutable; continuing one creates a new run with a
`parentRunId`. Test Pi path references when relocating sessions for archival.
Run retention, deletion, and backup policies remain to be specified. Minimal
accounting records survive run archival and any future deletion of bulky run
history; they reference stable identities rather than relocated run paths.
Reconcile interrupted inference requests separately as described in section
6.12; missing usage is not evidence that no inference occurred.

### 6.7 Container-managed configuration repository

Separate reusable configuration from application code and run state:

| Repository | Responsibility |
| --- | --- |
| `refAInery` | Application code, scheduler, persistence, validation, and policy enforcement |
| `refAInery-config` | Agent definitions, instructions, policies, workflow defaults, and approved Pi resources |
| `refAInery-storage` | Run state, frozen configuration, conversations, results, artifacts, and history |

The private `refAInery-config` repository is cloned and managed inside the
container at `/app/config`, backed by a separate named volume,
`refainery-config`. Clone on first use, then validate and reuse the checkout,
preserving local development edits. Apply the same initialization-safe ownership
and incomplete-clone protections as storage. Do not automatically reset, clean,
or pull on launch; configuration updates are explicit operator actions.
Authentication remains launch-time and 1Password-sourced.

The current development launcher uses the host bind-mount alternative: clone
`refAInery-config` beside the application checkout in `Vibing`, then mount it
read-only at `/app/config`. The launcher checks that the checkout exists before
fetching credentials and never clones or updates it automatically. Operators
can edit that host checkout during development; the container cannot write to
it through this mount. This does not restrict the permissions of any GitHub
credential available to the container.

The container-managed named volume remains the target default; its cloning and
update lifecycle is not yet implemented. For that lifecycle, a trusted setup
process needs read-write access for initialization and explicit updates, while
agent execution mounts the configuration read-only. Neither container removal
nor routine cleanup may remove the configuration volume. Git synchronization
and backup remain separate operations.

Agents must not modify live configuration or their frozen run configuration.
They may propose changes in an approved output area for operator review. Enforce
this through application capabilities and appropriate filesystem/process
boundaries, not instructions alone. Configuration activation is an operator
responsibility, separate from normal agent work.

### 6.8 Configuration layout and contract

Use JSON for structured definitions and Markdown for instructions. The initial
production layout under `/app/config/prod` is (the repository root also
contains a separate `test/` fixture area; see section 6.11):

```text
README.md
config.json
agents/
  orchestrator/
    agent.json
    instructions.md
  researcher/
    agent.json
    instructions.md
  implementer/
    agent.json
    instructions.md
  reviewer/
    agent.json
    instructions.md
instructions/
  shared.md
policies/
  read-only.json
  workspace-write.json
workflows/
  default.json
pi/
  extensions/
  skills/
  prompts/
```

Agent names above are illustrative, not a required first workflow. These files
form refAInery's configuration contract; they are not assumed to be native Pi
configuration. JSON schemas and validation code belong in the application
repository, which owns the contract and its supported versions.

`config.json` declares a schema version, default workflow and orchestrator type,
scheduler settings constrained to v1's sequential execution, named model
profiles, and explicitly approved extension
registrations. Agent definitions declare stable IDs, descriptions, ordered
instruction files, model profiles, requested policy/tool profiles, selected
extensions and skills, execution limits, and expected result-schema references.
Start with explicit definitions and shared instruction files, not inheritance.

Workflow definitions select allowed agent types, defaults, and limits; the
orchestrator's actual plan belongs in persisted run state. Scheduling, checkpoint
commits, result delivery, dependency acceptance, recovery, and approval
mechanics remain application code, not configurable replacements for those
mechanisms. Tasks may narrow, but never expand, approved agent permissions.
Instruction text is not a substitute for capability enforcement.

Before launching an orchestrator, validate supported schema versions, unique
agent IDs, referenced instruction files, model/policy/extension references,
execution limits, and result schemas. Reject unknown fields and paths that
escape approved resources, including through symlinks. Report actionable
validation errors without starting work with partial or implicit defaults.

### 6.9 Immutable per-run configuration

Configuration edits affect new runs only. Before dispatching any agent, resolve
and validate the run's configuration, then durably save it under the run's
`configuration/` directory and reference it from the initial checkpoint.

- `manifest.json` records the configuration repository commit when available,
  dirty-checkout status, content hashes, application and Pi versions, and
  dependency versions or lockfile/bundle identity.
- `resolved.json` records the effective non-secret configuration for the run,
  including agent definitions, model profiles, tool policies, and limits.
- `instructions/` retains the actual selected instruction content and order.
- `resources/` retains selected extension/skill/prompt content and required
  executable resources, or references a retained immutable resource bundle.

A commit ID alone is insufficient: preserve the actual selected content,
including uncommitted or untracked development files. Snapshotting must produce
one consistent configuration; coordinate with edits or detect changes during
capture and retry or fail. Avoid copying unrelated files or mutable credentials.
Referenced bundles must remain available for recovery and archival, and may not
be removed while retained runs depend on them.

Recovery uses the saved configuration, never silently substitutes current
`/app/config` contents, and never hot-reloads an active run. Verify snapshot
integrity and runtime compatibility before resuming; missing resources or an
incompatible application/Pi runtime produce an actionable recovery error. Keep
snapshots with archived runs. New continuations receive a new snapshot and link
to the parent run; they do not mutate its configuration.

### 6.10 Explicit Pi resources and extension trust

The Pi adapter translates resolved agent definitions into sessions, explicitly
selecting resource loading, instructions and their order, settings, models, and
tools. Verify the exact API against the pinned Pi dependency before implementing.
Do not mount the configuration repository as Pi's entire home directory or
silently inherit personal Pi settings, credentials, or arbitrary workspace
resources. Any project instructions or resources must be explicitly approved
and included in the resolved run configuration. Pi session files remain under
`/app/storage`, not `/app/config`.

Treat extensions as trusted executable code, not sandboxed configuration.
Require explicit allowlists, pinned dependencies, and operator review before
activating changed extension code. Agents may not automatically install or
activate requested extensions. Tool allowlists alone do not constrain malicious
extension code; execution isolation and credential exposure must be considered
separately. Small private extensions may live in the configuration repository;
substantial extensions need tests and dependency management and may become
separately versioned packages. Dependency installation must be explicit rather
than an unreviewed side effect of loading configuration.

Neither the configuration checkout nor a run snapshot may contain `.env`
files, API keys, tokens, OAuth bundles, or other credentials. Store only
non-secret credential identifiers and resolve their values through launch-time
1Password authentication. Do not persist resolved secret values when recording
effective configuration. Private repository access is not a substitute for
secret-handling rules or extension review.

### 6.11 Production and test design environments

Both `refAInery-config` and `refAInery-storage` have root-level `prod/` and
`test/` directories. Repository clone/mount destinations remain `/app/config`
and `/app/storage`; production application data is scoped beneath their
`prod/` directories. The production contracts described above apply within
those production subdirectories, not to test fixtures.

Before Pi integration, `serve.py --test` starts the same Node application in
the same development container, using read-only mounts of the sibling
repositories' `test/` directories. Both modes share the tool/Node preflight,
dependency installation in the `developer_cache` volume, and shutdown logic.
Test mode supplies fake credential environment values and skips 1Password,
GitHub authorization, storage cloning, and SDK installation. It does not run
agents or mount production data or SDK volumes. The server listens on container
interfaces, but the published host port is loopback-only; real host credentials
are not forwarded into the test container.

The configuration fixture contract uses version-1 `test/config.json` for
fictional agents/workshop settings. Storage fixture version 2 uses
`test/workshop.json` for operational telemetry and timed executions, and
`test/transcripts/` for explicitly labeled sample HTML, not Pi exports.
These are presentation fixtures, not production configuration schemas or
scheduler checkpoints. Future accounting fixtures must represent per-model and
per-machine usage, known zero versus unknown counters, incomplete requests,
unpriced usage, and explicitly estimated costs. This does not claim those
fields exist in the current version-2 fixture contract.
They permit designing the UI and data relationships
before real orchestration. All simulated state is visibly labeled as test
data; no real activity, completion, or approval is implied.

The Control Room presents Factory Operations (simulated factory state, derived
task counts, subagent outcomes, and input/output tokens over time), followed
by Factory Floor (one shared wall-clock timeline with a compact lane per run).
A fixed-height inspector above the internally scrolling timeline displays the
selected execution or job. Bars use actual start/end timestamps on a common
axis, with running bars extending to the frozen test snapshot. Each bar has
one status icon on the left, vertically centered with its text; there are no
endpoint markers. Positions and lengths represent execution lifetimes, not
CPU activity. Orchestrators
and subagents share the view with explicit role labels. Timestamp overlaps,
not stage numbers, determine up to three compact parallel subrows per job;
overflow counts on job labels lead to the full task list in the inspector.
Unstarted tasks are accessible there but never drawn as past executions.
Sticky labels/ruler, zoom, Earlier, Follow latest, and keyboard-operable buttons
support navigation. Browsing history pauses following; selection, zoom, and
scroll position persist across valid refreshes without growing the page.
Finished executions link to sample transcripts when available.
Config-derived agent definitions live in an always-visible Factory Specification
section at the bottom. Static introductory cards are no longer displayed.

The target Factory Operations design leads with the recorded-since token
odometer and per-model breakdown, then estimated economics, with current
execution counts and token history as supporting views (section 6.12).
Completed/failed execution counts measure outcomes, not independently verified
quality or correctness. These target labels and accounting views are not yet
implemented in the preview.

Transcript endpoints are test-only, allow only referenced fixture files, and
reject path escapes. Reports open separately under a script-free,
opaque-origin CSP sandbox; they are not embedded into the dashboard. Actual
Pi HTML export generation remains unimplemented.

The preview is read-only. It validates fixture versions, test markers, IDs,
statuses, and agent references; rejects production paths and path escapes;
and never falls back to production. Missing/invalid initial data prevents
startup. Edits are re-read on page refresh or the Refresh fixtures action;
invalid edits clear stale telemetry and produce a visible error. This fixture
reload behavior does not change the immutable
per-run production configuration rule. No automatic reset or promotion from
test into production is allowed. Neither area may contain credentials.

#### Factory Floor inspector and telemetry contract

The preview inspector now separates **execution outcome** from **result review**.
A `completed` fixture execution is labeled **Finished**, not Succeeded;
`awaiting-review` is shown as Finished with Pending review. Completion does not
prove correctness, passing checks, or orchestrator acceptance. The separate
Factory Operations fixture outcome chart remains an execution-outcome summary,
not a quality measurement.

The production identity model is run → task → attempt → Pi session for
subagents, and run → orchestrator turn → shared orchestrator Pi session for
orchestration. Each retry retains a distinct attempt and execution bar; each
orchestrator turn has its own execution interval even though the conversation
persists between turns. Do not draw an entire orchestrator session lifetime as
continuous active work. Unstarted tasks remain in the job inspector, not the
past-execution timeline. Legacy fixtures without attempt/turn identity show
**Not recorded** rather than inventing an attempt number or grouping by title.

Inspector information has explicit ownership:

| Information | Production authority |
| --- | --- |
| Job/task titles, dependencies, queued/waiting reason, attempts, review decisions | refAInery workflow checkpoints and recorded decisions |
| Agent name/role, approved tool policy, configuration identity | Immutable per-run configuration, not live configuration |
| Effective model/provider, message/tool activity, retry/compaction observations, session ID | Pinned Pi adapter observations |
| Execution boundaries, last observed activity, worker interruption | refAInery scheduler and timestamped adapter observations |
| Validated outcome summary and artifact references | Durable refAInery result record |
| Normalized usage and coverage | Independent accounting ledger, not reconstructed session totals |
| Conversation/activity transcript | Pi-owned session through approved adapter/export APIs |

The compact inspector presents attempt or turn identity, execution status,
separate result-review status, start/end and elapsed wall-clock time, current
activity, model/provider, last activity, and usage coverage. When recorded, it
also shows queued/review timestamps, outcome/waiting and retry reasons, and a
result summary. Expandable sections expose artifact labels, diagnostic identity
and configuration, and selectable attempt history. Sample transcript links keep
the existing isolated report behavior. Artifact downloads and a live activity
stream are not implemented in this preview.

Execution time ends when the worker execution ends; awaiting review never
extends its bar. Review timing is separate. `interrupted` is a distinct status,
not success, cancellation, or proof of safe replay. Last activity is an
observation timestamp, **not a worker heartbeat**. Do not infer worker death
from quiet output. Missing information is explicitly Not recorded, Not reported,
or Unavailable; known zero usage remains distinct from unknown counters. Cached
input is a subset of normalized input, not additional consumption. Final usage
means reporting finality, not necessarily availability of every counter.

Pi lifecycle integration must be verified against the pinned dependency. The
reviewed installed Pi 1.3.0 documentation distinguishes `agent_end` (a low-level
run ending) from `agent_settled` (no further automatic work); neither is a
workflow-success or result-acceptance signal. Persist captured observations
through the adapter rather than trying to recover every timing or state detail
from opaque conversation files after a crash. Internal retries, compaction,
nested model calls, and incomplete usage still require the accounting coverage
verification in section 6.12. The preview does not claim this integration exists.

Do not promise percentage complete, ETA, verified correctness, exact billing,
GPU/power/memory telemetry, or a complete changed-file list from Pi session
metadata alone. These require separate workflow, validation, engine, accounting,
or workspace instrumentation. Safe activity summaries must not expose raw tool
arguments or credentials. Artifact paths are not automatically downloadable URLs.

**Backward-compatible fixture-v2 inspector extension:** each execution in
`test/workshop.json` may include a `details` object. Only validated, explicitly
selected fields are returned to the browser:

- `taskId` and positive `attemptNumber` identify subagent attempt history within
  a run; duplicate task/attempt pairs are rejected. `turnId` identifies an
  orchestrator turn and is unique within a run. These identities are not
  interchangeable; `id` remains the unique presentation execution identity.
- `sessionId`, `model`, `provider`, `activity`, `summary`, `reason`, `retryReason`,
  `configuration`, and `toolPolicy` are optional non-secret display metadata.
- `review` is `unknown`, `not-submitted`, `pending`, `accepted`, `rejected`, or
  `not-applicable`. Missing review remains unknown, except the existing
  `awaiting-review` status explicitly implies pending review. Do not infer
  acceptance from `completed`.
- `queuedAt`, `lastActivityAt`, and `reviewedAt` are optional UTC timestamps.
  Queue time precedes execution; activity lies within execution; a recorded
  review decision follows execution and requires accepted/rejected review.
  No observation may exceed the frozen snapshot. Pending/accepted/rejected
  review requires a finished execution.
- `usage` contains nullable `input`, `output`, and `cachedInput` nonnegative
  integer counters plus `coverage`: `partial`, `final`, or `unavailable`.
  Unavailable usage cannot carry numeric counters. Cached input cannot exceed
  known input. These are normalized fictional counters, not raw Pi usage.
- `artifacts` is an optional list of display labels rendered as text, never HTML
  or arbitrary file links. Unrecognized metadata is not passed through.
- Execution/run statuses additionally admit `interrupted`; interrupted
  executions require start and end timestamps. Existing v2 fixtures remain
  valid and visibly disclose absent metadata. This is a presentation extension,
  not the production persistence or accounting schema.

### 6.12 Usage accounting and economic comparisons

#### Authority and scope

Persist measured consumption once, independently of workflow history; calculate
financial interpretations separately. The harness is intended to be the sole
connector to the local inference engine. All model calls, including orchestrator
work, subagents, retries, and auxiliary calls, must pass through the accounting
boundary. Verify that the pinned integration exposes every actual invocation,
including internal retries; do not infer requests from task completion counts.
Calls bypassing the harness are outside its accounting coverage.

The authoritative accounting store consists of immutable, versioned JSON records
under `accounting/`. It shares the storage volume's exclusive ownership and
application-owned serialized writer. Agents do not write accounting records.
It does not depend on parsing opaque Pi session files or on Git commits/pushes.
File names above illustrate the contract; exact validated JSON schemas remain
implementation work.

#### Request records and normalization

Allocate a globally unique request ID before dispatch. Each request records:

- Schema version, request ID, revision, event type, and UTC timestamps.
- Storage identity, run ID, and applicable task/attempt or orchestrator-turn IDs.
  Auxiliary calls without a run record an explicit purpose instead.
- Inference machine ID, model identity, engine identity/version, and adapter
  version. The inference machine need not be the harness host. Model identity
  distinguishes weights/revision and quantization when known; unknown metadata
  stays explicit rather than implying a verified match.
- Dispatch intent, terminal outcome when known, and any retry-parent request ID.
- Normalized input/output, cached-input, and cache-write counts where available;
  measurement source, finality, and completeness are separate from outcome.
- Allowlisted original usage counters and their documented normalization
  semantics, not full responses, prompts, headers, or credentials.

Input tokens include cached input in the normalized schema. Display cached input
as a subset, never add it to input again. Preserve cache writes separately and
record their relationship to input according to the adapter's semantics. Do not
invent a universal cache-write billing rule. Output normalization must document
any inclusion of reasoning or other output subcategories without double counting.
Use nonnegative integer counters: `null` means unavailable/unknown, while zero
means known zero. Estimates, if supported, must be labeled and distinguishable
from engine-reported measurements; text length is not authoritative token usage.
Validate supported engine counters before promising a dashboard metric.

#### Durable lifecycle and reconciliation

1. Durably write a `started` record before sending the inference request. This
   records intent, not proof that the engine received or executed it. If this
   write fails, do not dispatch.
2. Invoke the engine with that request identity where supported.
3. Durably append a settled record containing the outcome and available usage,
   then publish updated dashboard aggregates. A failure or cancellation can
   still consume tokens and can still have complete usage.
4. If usage arrives late or is corrected, append a revision that explicitly
   supersedes the preceding accounting state; never rewrite earlier records.

Each revision contains the full accounting state for its request. Aggregation
uses only the latest valid revision per request, not the sum of revision files.
Stable notification identities or equivalent adapter deduplication prevent
replayed callbacks from increasing totals. A genuinely repeated inference call
is a new request even when its prompt is identical. The request's directory is
assigned at creation and remains stable for late revisions across month changes.

Use temporary sibling writes, flush, rename, and directory flush as in section
6.5. Ignore unfinished temporary files; corrupt committed records or broken
revision chains require explicit recovery, not silent rollback. Stop new
inference dispatch on accounting persistence failure and expose degraded status;
already-running requests may still consume tokens and require reconciliation.

A crash between dispatch and usage persistence leaves uncertain consumption.
Reconcile against engine request records where supported; otherwise preserve an
unresolved/incomplete request. Do not invent zero usage or automatically replay
inference to repair accounting. Workflow recovery separately decides whether
work can be retried. Exactly-once inference and gap-free accounting are not
promised without engine reconciliation support. Request finality does not imply
all counters were reported, and partial observations must not be labeled exact
final totals.

#### Models, machines, prices, and comparison policies

Model records retain non-secret identity metadata. Machine records use immutable
revisions containing purchase price, currency, accounting start date, and any
operating-cost assumptions with their effective periods. Keep inference-machine
identity stable across model changes and harness restarts. New machines get new
identities. Do not silently attribute pre-metering usage or shared-machine costs.

Pricing snapshots retain cloud service (for example OpenRouter), exact model and
provider identity, currency, rate units and exact decimal rates, cache billing
categories, capture time, source reference, and applicable pricing conditions.
Retain effective dates when known; capture time alone does not establish a
historical rate. Never overwrite a referenced snapshot. Monetary calculation
uses decimal/fixed-point arithmetic with an explicit rounding policy.

Immutable comparison policies map local model identities to cloud model/provider
identities and price snapshots. They record the calculation version and cache
assumptions. Capture the applicable comparison-policy ID in request accounting
state for reproducible historical estimates, or explicitly record no policy.
An uncached baseline and a cache-adjusted scenario are separate estimates: a
local cache hit is not proof of a cloud cache hit. Non-identical model variants
are benchmark comparisons, not claims of equivalent quality or output.

Missing rates, mappings, or required usage produce unpriced/incompletely priced
coverage, not a zero-dollar valuation. Report priced totals with that coverage.
Historical-rate estimates use the retained policy; repricing at newer rates is
an explicitly separate view and never mutates measured usage or old snapshots.
Different currencies require a retained conversion source/rate/date and policy,
or separate totals; never silently add them together.

#### Odometer, economics, and retention

The primary dashboard shows input, output, cached-input availability, per-model
and per-machine breakdowns, and the date recording began. Report known totals
alongside unresolved requests, partial usage, and unavailable counter coverage.
Retain interval histories as derived views, not independent lifetime counters.

Label financial views **Estimated cloud-equivalent spend** and **Estimated
purchase-price recovery**, not measured savings. The comparison is hypothetical
unless the operator would otherwise have purchased that workload. Compute:

```text
estimated net avoided spend = cloud-equivalent estimate - local operating costs
remaining purchase price = purchase price - estimated net avoided spend
```

If operating costs are omitted, label the view **Gross purchase-price offset —
excluding operating costs**. Show the selected machine cost, pricing policy/date,
cache assumptions, and any incomplete/unpriced coverage. Do not imply measured
electricity use from inference duration or token counts alone. A negative
remaining balance means the estimate exceeds the purchase price, not a negative
purchase price. Do not promise a payoff date without a separate forecast model.

All daily, per-model, per-machine, lifetime, and economic summaries under
`derived/accounting/` are rebuildable caches. They are never authoritative
mutable odometer counters. A future database may index the ledger without
replacing this authority contract. The accounting ledger and referenced model,
machine, price, and policy records survive run archival/deletion. Minimal
records contain no prompt or response content. Ledger compaction requires a
separate auditable design preserving totals, coverage, and provenance; deleting
ledger records while retaining only dashboard totals is not supported.

### 6.13 V1 intake, sequential orchestration, and handover

#### Intake and FIFO scheduling

All intake sources produce a common prompt-based work request. The initial
minimum fields are `id`, `prompt`, `receivedAt`, and `source`; the initial source
is `manual`. Other sources may be added later without defining integrations now.
A request preserves what was asked and where it came from; it is not itself an
execution. A run records execution of that request.

Incoming top-level requests enter a FIFO queue. When the factory is free, the
scheduler automatically starts the oldest queued request. V1 has one active
run at a time, without priorities, scheduled start times, or a separate manual
approval to start. This does not bypass approval requirements for consequential
actions performed during the run.

All subwork belongs to the active run and takes precedence over the next queued
request. It never joins the back of the intake queue. The next request starts
only after the current run completes, fails, or is cancelled and its workers
have stopped. Durable queue records, tie-breaking, and the atomic transition
from queued request to active run remain schema implementation work.

#### Orchestrator-owned execution loop

Each run has one orchestrator, which stays responsible for the request until
completion, failure, or cancellation:

1. The orchestrator receives the request and makes a plan.
2. It launches one subagent to perform the first assigned part of the plan.
3. The subagent works until its assignment finishes or it reaches the context
   handover boundary, intended to be Pi's request to compact context.
4. The subagent writes a handover document and stops, returning control to the
   orchestrator rather than silently continuing through compaction.
5. The orchestrator reviews the handover, updates its plan, and decides whether
   to launch another subagent or declare the original work done.
6. Repeat until the run is terminal, then advance the top-level FIFO queue.

Only the orchestrator creates subagents. Subagents cannot delegate or pass
control directly to another subagent. There is at most one active subagent;
this replaces the earlier general DAG/concurrent-subagent proposal. Subwork is
scheduled within the current run after the orchestrator's decision, not in
parallel or automatically from a subagent's recommendations. A subagent finishing
does not establish completion or correctness of the overall request.

The pinned Pi integration must be verified before implementing the context
boundary: in particular, whether compaction can be intercepted and sufficient
context reserved to request and persist the handover. This specification records
the desired behavior, not a claim that those hooks have been verified.

#### V1 handover document

Use the following Markdown format for both completed assignments and
context-limit handovers, retaining the file-list tags:

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

Keep the producing subagent attempt identity and stop reason (`completed` or
`context-limit`) in application bookkeeping outside the document. Retain the
handover as an immutable file referenced by the attempt's result; its precise
filename and record schema remain to be defined. The Next Steps section is
advice for the orchestrator, not automatically scheduled work. File lists are
agent-reported context, not an independently verified workspace change audit.

If a subagent crashes or is interrupted before producing a handover, record
that interruption and the absent handover explicitly. Do not invent a handover
or label the attempt completed. Existing conservative recovery and approval
rules apply before further work is dispatched.

## 7. Proposed logical architecture

Keep the first implementation separable into these responsibilities. These are
logical boundaries, not a requirement to create all modules up front.

1. **Application interface** — accepts a user request and presents status,
   progress, approval prompts, and results. CLI versus web/TUI interface is
   undecided.
2. **Factory/workflow layer** — defines a workflow's inputs, ordered steps,
   allowed tools, success criteria, and output locations.
3. **Pi adapter** — creates/configures Pi sessions and translates between Pi
   events and refAInery's workflow-level events. Pi-specific types should not
   leak through the whole application.
4. **Context and workspace layer** — selects project files and other approved
   context, applies ignore/exclusion rules, and identifies the workspace scope.
5. **Tool and policy layer** — defines which tools are available, what they can
   access, and when user approval is required.
6. **Run record/output layer** — owns the JSON workflow checkpoints, persistent
   Pi session references, artifacts, and generated HTML history described in
   sections 6.3–6.6, including per-run configuration snapshots. Retention remains
   undecided.
7. **Configuration layer** — validates and resolves the separate configuration
   repository, freezes run-specific resources, and supplies explicit settings
   to the Pi adapter without taking over scheduler or policy enforcement.
8. **Usage accounting layer** — records every inference invocation and available
   engine usage, normalizes counters, reconciles incomplete records, and derives
   odometer and explicitly estimated economic views. It owns accounting schemas
   and pricing provenance, not workflow acceptance or scheduling decisions.

## 8. Initial interaction lifecycle (proposal)

A first workflow could follow this sequence:

1. The operator starts refAInery from the mounted project workspace.
2. The operator selects or describes a task and explicitly chooses the allowed
   project context.
3. refAInery constructs a run with a unique identifier and a clear output
   location, validates its configuration, and commits an immutable configuration
   snapshot before dispatching work.
4. The FIFO scheduler starts one top-level run. Its Pi-backed orchestrator makes
   a plan and launches one subagent at a time, using only configured tools and
   workspace permissions. Each subagent returns a handover on completion or at
   the context handover boundary. The orchestrator reviews it and commits the
   decision to launch further work or finish; subagents cannot delegate.
5. refAInery reports progress and requests approval before any action defined
   as approval-gated.
6. The operator reviews the result, requested changes, and relevant run details.
7. The operator can keep, revise, or discard the generated work.

The exact lifecycle depends on the initial workflow and on Pi's event/session
APIs. No automatic commit, push, deployment, or other irreversible action is
assumed.

## 9. Hard authentication and secret-handling rules

These requirements are mandatory, not optional implementation preferences:

1. All authentication material used by refAInery or its in-container
   application processes must be obtained at launch from 1Password via the
   1Password CLI (`op`). No alternate credential source or fallback is allowed
   unless the spec is explicitly changed.
2. A Python launcher is the entry point that resolves secrets and starts the
   Docker container. Do not use `compose.yml` or Compose `.env` interpolation
   for launch or secret delivery.
3. Never create or read project `.env` files. Never write passwords, API keys,
   access tokens, 1Password-derived secret values, or credential bundles to
   disk, including temporary files, generated config files, logs, or Docker
   build/image layers.
4. Keep secret values transient in process memory and provide them to the
   container's application processes through environment variables, unless a
   specific integration cannot use environment variables and an equally
   transient, non-file mechanism is agreed upon first.
5. Do not expose secret values in terminal output, exception messages, shell
   command strings, or process arguments. Handle child processes without shell
   interpolation and redact sensitive data from diagnostics.
6. If 1Password is unavailable, the CLI is unauthenticated, or a required
   lookup fails, stop before starting the application and report a redacted,
   actionable error.

Container environment variables can be visible to Docker administrators and
may be exposed by container-inspection tooling. The design must document this
local threat boundary; environment injection does not make a secret invisible
to the Docker daemon. This observation does not permit writing secrets to disk.

## 10. Safety, privacy, and reliability principles

- **Explicit workspace scope:** do not treat the whole container filesystem as
  user-approved context. Define the readable and writable paths.
- **Least privilege:** expose only tools and permissions required by the
  selected workflow. Tool access should be configurable and auditable.
- **Approval before consequential actions:** default to review/approval for
  writes outside a designated output area, network actions, and irreversible
  operations. Exact policy is an open decision.
- **Secrets:** do not put provider credentials in source control, generated
  artifacts, or image layers. Decide how host credentials enter the container
  and how Pi discovers them.
- **Persistence:** distinguish transient container state from durable project
  files, cache, logs, credentials, and run records.
- **Failure handling:** make model/provider errors, cancellation, timeouts, and
  partial output visible. Avoid silently treating incomplete runs as success.
- **Reproducibility:** record workflow/configuration versions and relevant run
  metadata, without persisting secrets or unnecessarily copying private source
  material into logs.

## 11. Draft acceptance criteria for the first usable slice

These criteria are provisional until the first workflow is chosen:

- A user can start refAInery using the Python launcher and published
  AltivecIntelligence image with the current `source`-only mount at
  `/app/source` and `/app` as the working directory; no Compose file is needed.
- At launch, the Python launcher obtains all required authentication material
  using the 1Password CLI and makes it available to in-container application
  processes without writing it to disk or printing it.
- Startup stops with a redacted, actionable error if 1Password authentication
  or a required secret lookup fails.
- Startup clearly reports other missing configuration instead of failing
  opaquely.
- A user can run one agreed end-to-end workflow through Pi.
- The run's progress and final status are understandable to the user.
- Storage is cloned inside the container into `/app/storage` on the named
  volume on first use and reused on later launches, without a host checkout
  bind mount or destructive synchronization.
- JSON workflow checkpoints, Pi sessions, and artifacts survive container
  removal without requiring Git commits or pushes.
- The private configuration repository is cloned inside the container at
  `/app/config` on a separate named volume and reused without discarding edits.
- Invalid configuration fails before agent dispatch. Tests cover unknown fields,
  missing references, unsupported schemas, and resource path escapes.
- Runs preserve actual resolved configuration and resources, including dirty
  development edits. Changing live config does not change active or recovered
  runs; missing resources or incompatible runtimes stop recovery explicitly.
- Agents cannot modify live or frozen configuration or expand approved
  permissions. Pi loads only explicitly approved resources, and extension
  activation requires operator review.
- Configuration and snapshots contain no credentials; secret values are never
  persisted as part of configuration resolution.
- Recovery tests cover interrupted checkpoint writes, result delivery,
  orchestrator decisions, uncertain external effects, and archival. Recovery
  must not silently repeat committed decisions or discard corrupt state.
- Concurrent scheduler instances cannot acquire ownership of the same storage.
- Accounting tests cover multiple calls per attempt, orchestrator/auxiliary
  calls, retries, failed/cancelled consumption, duplicate notifications, late
  corrections, unknown versus zero counters, and cache-subset normalization.
- Forced-interruption tests cover pre-dispatch and post-dispatch accounting
  writes, incomplete usage, corrupt records, and persistence failures. Recovery
  never silently converts missing usage to zero or replays inference to repair
  the ledger. Integration tests verify invocation coverage and supported counters
  against the pinned engine/adapter; unavailable coverage remains explicit.
- Rebuilding accounting summaries reproduces totals without double counting
  revisions. Archival or deletion of bulky run history does not reset usage.
- Economic tests cover historical versus current repricing, absent mappings or
  rates, cache assumptions, decimal rounding, currency handling, and excluded
  operating costs. Estimates and incomplete coverage are visible in the UI.
- Top-level requests start FIFO, with at most one active run and one subagent.
  Only the orchestrator creates subagents; all subwork returns to it before
  further dispatch. The next queued request waits until the active run and its
  workers have stopped.
- Subagents persist the agreed handover on completion or at the verified Pi
  context handover boundary. Missing handovers after interruption remain
  explicit; recommendations never schedule work without an orchestrator decision.
- Terminal runs retain machine-readable records alongside regenerable HTML
  reports; reports render agent and tool content as untrusted data.
- The default tool permissions and any approval steps are documented and
  covered by tests.
- A portable test/check command can run without Apple SDKs. The application is
  not itself an Apple app; the cross-compilation toolchain is available context,
  not an assumed dependency of the initial feature.

## 12. Open questions

### Product definition

1. What should the factory produce first: software changes, plans/specs,
   research summaries, content, reusable agents/workflows, or something else?
2. Who is the primary operator—just the repository owner, or eventually other
   users/team members?
3. Is this a general-purpose project agent, or should it focus on the
   Altivec/retro Apple development workflow?

### Interface and workflow

4. Should the first interface be a CLI, a terminal UI, a local web UI, or a
   combination?
5. What is one concrete end-to-end task that would make the first version
   valuable?
6. Which initial workflow defaults, agent types, and result schemas should be
   defined in the agreed JSON/Markdown configuration contract?

### Pi integration

7. Which Pi package/API should be used, and should Pi be embedded as a library
   or invoked through a CLI/subprocess?
8. Which specific Pi tools, extensions, skills, streaming events, and model
   profiles are needed for the initial workflow?
9. What resource-loader and isolation implementation will enforce refAInery's
   explicit configuration namespace, reviewed extensions, and credential rules?

### Container and data

10. What command-line interface should the Python launcher expose, and should
    it run interactively by default?
11. What additional non-secret cache mounts are needed beyond the named
    configuration and storage volumes? Credential files must not be mounted as an
    alternate to the 1Password-at-launch rule.
12. What retention, deletion, backup, and Git synchronization policies apply
    to the agreed `/app/storage` layout? Should Git track active runs,
    completed history only, or neither by default? Should crash recovery
    proceed automatically or wait for operator approval?

### Permissions and providers

13. Which local engine/version and cloud comparison providers are in scope for
    the initial slice? Which usage counters, internal retries, and request
    reconciliation capabilities can the pinned integration actually expose?
14. Should network access be unrestricted, provider-only, or disabled unless
    explicitly enabled?
15. Which file operations and other tools may run without approval, if any?

## 13. Design decision log

| ID | Decision | Status |
| --- | --- | --- |
| D-001 | Use npm/Node.js for the application | Confirmed |
| D-002 | Use Pi as a dependency and low-level harness | Confirmed; package/API TBD |
| D-003 | Run in `ghcr.io/jeffreybergier/altivec-intelligence:latest` | Confirmed |
| D-004 | Consume the published image; do not build/customize it for normal app use | Confirmed |
| D-005 | Use a Python launcher, not Compose, to start the container | Confirmed |
| D-006 | Obtain all authentication through 1Password CLI at launch; no `.env` files or disk-written secrets | Hard rule |
| D-007 | First user-facing interface | Open |
| D-008 | First production workflow/output | Open |
| D-009 | JSON workflow checkpoints, opaque Pi sessions, and HTML reports retaining underlying records | Confirmed; detailed schema and retention TBD |
| D-010 | 1Password item/field names and mapping to container environment variables | Open |
| D-011 | Clone storage inside the container on first use; reuse checkout on named volume at `/app/storage`, not a host checkout bind mount | Confirmed; launcher change pending |
| D-012 | FIFO top-level requests; one active run whose orchestrator plans and launches one subagent at a time; all subwork returns to that orchestrator before further dispatch | Confirmed; replaces general DAG/concurrent scheduling |
| D-013 | One workflow-state writer, immutable checkpoints, conservative crash recovery | Confirmed; recovery automation policy TBD |
| D-014 | Immutable archived runs; continuations create linked new runs | Confirmed |
| D-015 | Private `refAInery-config` checkout at `/app/config` on a separate named volume; explicit updates preserve development edits | Confirmed; implementation pending |
| D-016 | JSON agent/workflow/policy definitions and Markdown instructions; schemas and enforcement remain application-owned | Confirmed; detailed schema TBD |
| D-017 | Immutable resolved configuration and resources per run; no active-run hot reload or recovery substitution | Confirmed |
| D-018 | Explicit Pi resource loading, reviewed executable extensions, and no persisted credentials in config or snapshots | Confirmed |
| D-019 | Root-level prod/test namespaces in configuration and storage repositories; credential-free local test launcher with read-only fictional fixtures | Confirmed; initial preview implemented |
| D-020 | Independent immutable per-inference accounting ledger; per-model/per-machine odometer with explicit unknown usage; summaries are rebuildable | Confirmed; implementation pending |
| D-021 | Versioned pricing and comparison policies; cloud-equivalent spend and purchase-price recovery are estimates separate from measured usage | Confirmed; implementation pending |
| D-022 | Attempt/turn-aware Factory Floor inspector; execution completion separate from result acceptance; explicit telemetry sources and unavailable coverage | Preview implemented; production Pi adapter pending |
| D-023 | Common prompt-based intake request with ID, received time, and source; request identity separate from execution | Confirmed; detailed queue schema pending |
| D-024 | Subagents hand back the agreed Markdown document on completion or context limit; only the orchestrator decides continuation or completion | Confirmed; Pi compaction interception requires verification |

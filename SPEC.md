# refAInery — AI Factory Specification

**Status:** Draft 0.1 — starting point for collaborative design  
**Last updated:** 2026-10-23

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
- Prompts start an orchestrator agent, which defines a basic directed acyclic
  graph (DAG) of subagent tasks. A scheduler executes eligible tasks, and all
  results return to the orchestrator for decisions about subsequent work.
- Storage uses JSON workflow checkpoints, opaque Pi conversation files, and
  HTML historical reports. The storage repository is managed inside the
  container on a persistent named volume, not a host checkout bind mount.
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

Distinguish three identities:

- **Run:** one user request and the orchestration performed to fulfill it.
- **Task:** one logical node in the DAG.
- **Attempt:** one execution of a task; retries create new attempts and retain
  earlier outcomes.

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
transition history. Do not maintain independently authoritative queue, DAG,
inbox, and task-status files. Indexes and UI caches must be rebuildable.

Each checkpoint records:

- Schema version, run ID, revision, and timestamps.
- Run status, optional parent run, and final outcome when terminal.
- Workflow/application version, configuration snapshot identity, model
  configuration, tool policy, and limits.
- DAG revision, task definitions, and dependencies.
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

Allow only one scheduler/workflow-state writer per storage directory. Subagents
may run concurrently, but submit workflow changes through that writer rather
than editing checkpoint files. Their separate Pi session files remain owned by
the respective agent sessions. Locks must prevent overlapping writers across
containers; stale ownership recovery must not rely on a PID alone.

### 6.6 Result delivery, recovery, and archival

Subagent results always return to the orchestrator. A successful attempt does
not by itself satisfy a DAG dependency: the orchestrator must accept its result
before dependent tasks become eligible. Results include stable result, task,
and attempt IDs; outcome; summary; structured output; artifact references; and
error details when applicable. Failures and cancellations also return outcomes.

Persist result handling through these stages:

1. Result durably recorded and pending orchestrator review.
2. Result included in a recorded orchestrator turn.
3. Orchestrator decision committed with the resulting workflow-state change.

Serialize orchestrator turns even when subagents run concurrently. Persist
inputs before dispatch and decisions before applying subsequent actions. Stable
result and decision IDs prevent duplicate application during recovery. The
orchestrator may accept, reject, retry, or add work. New dependencies may affect
unstarted tasks only; reject cycles and preserve executed task definitions.
Represent revision work as new nodes rather than rewriting execution history.

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

Reports show the request, outcome, DAG, decisions, attempts, retries, failures,
interruptions, artifacts, timing, and available usage information. Individual
Pi HTML exports may supplement the overall report. Escape untrusted text and
sanitize permitted markup; never execute generated agent HTML in the report.
Prevent credentials from entering transcripts, artifacts, or exports. Private
prompts and source content also require review before sharing or remote sync.

Archived runs are immutable; continuing one creates a new run with a
`parentRunId`. Test Pi path references when relocating sessions for archival.
Retention, deletion, and backup policies remain to be specified.

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
scheduler concurrency, named model profiles, and explicitly approved extension
registrations. Agent definitions declare stable IDs, descriptions, ordered
instruction files, model profiles, requested policy/tool profiles, selected
extensions and skills, execution limits, and expected result-schema references.
Start with explicit definitions and shared instruction files, not inheritance.

Workflow definitions select allowed agent types, defaults, and limits; the
orchestrator's actual DAG belongs in persisted run state. Scheduling, checkpoint
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
scheduler checkpoints. They permit designing the UI and data relationships
before real orchestration. All simulated state is visibly labeled as test
data; no real activity, completion, or approval is implied.

The Control Room presents Factory Operations (simulated factory state, derived
task counts, subagent outcomes, and input/output tokens over time), followed
by Factory Floor (one horizontal execution timeline per run). Historical
stages are ordered by start time, with in-flight stages on the right; parallel
executions share a stage and stack vertically. Unstarted tasks are listed
separately. Finished executions link to sample transcripts when available.
Config-derived agent definitions live in an always-visible Factory Specification
section at the bottom. Static introductory cards are no longer displayed.

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

## 8. Initial interaction lifecycle (proposal)

A first workflow could follow this sequence:

1. The operator starts refAInery from the mounted project workspace.
2. The operator selects or describes a task and explicitly chooses the allowed
   project context.
3. refAInery constructs a run with a unique identifier and a clear output
   location, validates its configuration, and commits an immutable configuration
   snapshot before dispatching work.
4. A Pi-backed orchestrator plans a DAG of subagent tasks. The scheduler runs
   eligible attempts using only configured tools and workspace permissions.
   Every result returns to the orchestrator; accepted results unlock dependent
   work, and committed decisions determine retries, new tasks, or completion.
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
- Downstream tasks wait for orchestrator acceptance of dependency results.
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

13. Which model providers are in scope for the initial slice?
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
| D-012 | Orchestrator plans a DAG; scheduler runs subagents; all results return for orchestrator acceptance | Confirmed |
| D-013 | One workflow-state writer, immutable checkpoints, conservative crash recovery | Confirmed; recovery automation policy TBD |
| D-014 | Immutable archived runs; continuations create linked new runs | Confirmed |
| D-015 | Private `refAInery-config` checkout at `/app/config` on a separate named volume; explicit updates preserve development edits | Confirmed; implementation pending |
| D-016 | JSON agent/workflow/policy definitions and Markdown instructions; schemas and enforcement remain application-owned | Confirmed; detailed schema TBD |
| D-017 | Immutable resolved configuration and resources per run; no active-run hot reload or recovery substitution | Confirmed |
| D-018 | Explicit Pi resource loading, reviewed executable extensions, and no persisted credentials in config or snapshots | Confirmed |
| D-019 | Root-level prod/test namespaces in configuration and storage repositories; credential-free local test launcher with read-only fictional fixtures | Confirmed; initial preview implemented |

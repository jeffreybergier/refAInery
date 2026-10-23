# refAInery — AI Factory Specification

**Status:** Draft 0.1 — starting point for collaborative design  
**Last updated:** 2026-10-22

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
- This phase is specification writing only. No application implementation or
  build is in scope yet.

## 3. Product intent (working hypothesis)

The initial product hypothesis is a **personal, project-aware AI workshop**
that helps its operator define repeatable AI workflows, run them against
selected project material, and inspect/review the resulting artifacts.

The name “AI Factory” suggests repeatable production, but does not yet define
what is produced. The first product workflow and its users must be agreed
before implementation. See [Open questions](#11-open-questions).

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
6. **Run record/output layer** — records enough information to review a run and
   locates its durable outputs. Persistence format and retention are undecided.

## 8. Initial interaction lifecycle (proposal)

A first workflow could follow this sequence:

1. The operator starts refAInery from the mounted project workspace.
2. The operator selects or describes a task and explicitly chooses the allowed
   project context.
3. refAInery constructs a run with a unique identifier and a clear output
   location.
4. The Pi-backed agent performs the task using only the configured tools and
   workspace permissions.
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
- Outputs are written only to an agreed persistent location and survive
  container exit.
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
6. Should workflows be written as code, declarative configuration, prompts, or
   assembled interactively?

### Pi integration

7. Which Pi package/API should be used, and should Pi be embedded as a library
   or invoked through a CLI/subprocess?
8. Which Pi capabilities are needed initially (sessions, tools, extensions,
   streaming, persistence, model/provider configuration)?
9. Should users be able to use their existing Pi configuration and credentials,
   or should refAInery own a separate configuration namespace?

### Container and data

10. What command-line interface should the Python launcher expose, and should
    it run interactively by default?
11. Which non-secret host directories, if any, should be mounted for Pi
    configuration, cache, and run history? Credential files must not be
    mounted as an alternate to the 1Password-at-launch rule.
12. Where should durable run records and generated artifacts live, and how
    should they be cleaned up?

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
| D-009 | Run state and non-secret persistence strategy | Open |
| D-010 | 1Password item/field names and mapping to container environment variables | Open |

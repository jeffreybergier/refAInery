# Supervised Pi milestone

This is a real backend integration, not simulated agent output. It intentionally
runs **one request and one worker**, then stops. It is not an unattended scheduler
or a general-purpose recovery engine. The existing fixture previews remain
available and offline.

## Run a request

Requirements: Node 22.19+, installed application dependencies (`npm ci
--ignore-scripts`), Python 3, Docker running, the existing Altivec image already
available, and approved 1Password CLI access. No Apple SDK setup is needed for
this scratch-workspace milestone. The image ID is resolved and recorded before
starting a worker; execution never implicitly pulls an image.

From `refAInery`:

```sh
python3 run-once.py --prompt-file examples/milestone/request.md \
  --storage build/my-supervised-run
```

Without `--storage`, the runner uses `build/supervised-storage`. It never copies
preview fixtures into that root.

The launcher reads only `OPENROUTER_API_KEY`, `MODEL_REGISTRY`, and `MODEL_SELECTED`
from `Dev Key - refAInery`. It does not pass GitHub credentials, ambient provider
credentials, Pi settings, or `NODE_OPTIONS`. Secrets are not written into config,
storage, arguments, or logs. Pi uses an in-memory credential store. The selected
identifier is sent unchanged; there is no fallback model. Catalog capacity must
support the fixed 250,000-token run configuration and model tool calls.

The server tools and personality files are loaded from the sibling
`refAInery-config/prod` by default (`--config` overrides that explicit trusted
checkout). Their contents, extension hashes, SDK version, and tool-catalog
version are frozen before agent execution. Do not point the loader at unreviewed
code: extensions execute in the host process with its permissions.

Limits: one assignment, twelve inference requests across both sessions, 2,048
maximum output tokens per call, no provider or agent retries, and a three-minute
cancellation deadline per prompted phase (bounded tool teardown can add time).
Native web calls may have additional charges.
The example is deterministic and explicitly asks agents not to use web tools.

## Inspect the result

```sh
REFAINERY_BACKEND=1 \
REFAINERY_STORAGE_DIR=build/my-supervised-run \
npm start
```

Open the loopback server on port 8080 and select `/v1`. This opt-in server reads
production records and refreshes the registry at startup and hourly while idle;
it does **not** submit work or run the queue automatically. Refresh the dashboard
manually to load new saved state. Default `serve.py` and `serve.py --test` do not
activate this backend. Never expose the unauthenticated server to an untrusted
network. The configured storage root must be application-owned and private.

The dashboard shows the actual execution timeline, current/final plans, full plan
history, handovers, decisions, checkpoints, frozen tool/model selections, and
per-call requested versus provider-reported actual model identity. A saved state
is not a worker heartbeat. Completed execution, recorded decisions, and original
request outcome remain separate; production does not invent accepted/rejected
review labels. Short historical bars can overlap at the minimum pixel width as
idle time expands the axis; select the job label and its execution list to inspect
any execution without relying on a tiny bar hit target.

## Ownership and scheduling

The config repository's `extensions/workflow.ts` defines four model-facing tools:

- Orchestrator: `update_plan`, `assign_subagent`, `finish_run`.
- Worker: `submit_handover`, plus allowed standard tools and web capabilities.

The app binds caller role/session identity outside the tool arguments. A plan
must be saved in the current planning turn before assignment or finalization.
Plan Markdown is published first, then an immutable checkpoint. The next action
references that revision. Tool-call receipts contain argument hashes and results,
not copies of plan/handover Markdown. Repeated delivery of the same call ID is
idempotent; changed arguments with a reused ID fail.

A terminal workflow tool must be the only call in its assistant message. Pi's
termination result prevents an automatic follow-up; the backend waits for session
settlement before switching agents. A normal handback saves Markdown, stops the
worker, saves its export, stops the entire workspace container (including any
background shell work), and commits the awaiting-decision checkpoint before
resuming the orchestrator. The final plan/decision precedes the orchestrator's
single final session export and terminal checkpoint.

The worker uses Pi's actual standard tool definitions with custom file/shell
operations delegated to Docker. This first adapter targets text files; image
handling has not been validated. The container has no network, credentials,
Docker socket, config/storage mounts, or host project checkout. Its only host
mount is this run's scratch workspace. It runs unprivileged, with a read-only
root, no capabilities, and process/memory/CPU limits. The workspace remains after
container teardown for operator inspection; it is not publicly served. Provider
native web tools run through the model API, outside that network-disabled shell.
This setup limits the milestone; it is not a claim that containers eliminate all
security risks or that shell access is suitable for arbitrary untrusted jobs.

## Storage layout

```text
requests/<request-id>.json
registry/
  snapshots/<fetch-time>-<snapshot-id>.json
  status.json
runs/<run-id>/
  config/frozen.json
  config/extensions/{workflow,web-search}.ts
  checkpoints/000001.json ...
  plans/000001.md ...
  handovers/<attempt-id>.md
  sessions/<pi-generated-name>.jsonl
  exports/<attempt-id>.html
  exports/orchestrator.html
  inferences/<call-id>/{000001,000002}.json
  sandbox.json
  workspace/...
  pi-private/...
```

Requests and checkpoints have Draft 2020-12 schemas under `schemas/storage/v1`.
Runtime validation also checks plan history, frozen configuration, sequential
execution and export/review relationships. The registry and inference records
currently use the TypeScript contracts in `source/backend`; standalone schemas
for those records remain follow-up work.

Immutable files are flushed and atomically published without overwriting prior
records. Newly created parent-directory entries are flushed too. One exclusive
writer lock protects workflow dispatch. Temporary files are ignored; a missing
or corrupt committed checkpoint or referenced document fails closed, never
silently rolling back. Queue membership is derived from immutable intake and run
references; this milestone refuses to dispatch if any intake is already queued
or any prior run requires recovery.

Inference intent is saved **before** invoking the provider. Raw provider model/ID
and allowlisted usage/cost fields are observed before Pi normalization. The
terminal inference revision is saved before executing tools. Unknown identities
or costs remain null. A provider-reported name does not prove immutable weights.
Pi-normalized counts retain their source and are not treated as independently
verified measurements. No financial estimates or token-history chart are invented.

Registry snapshots preserve the complete public catalog, including decimal price
strings, pricing overrides, and unknown-price sentinels such as `-1`. A sentinel
is not a negative price or zero cost. Partial catalogs are rejected. Each call
references the snapshot current in its adapter at dispatch and its freshness;
refresh does not reprice history or change frozen model choices. Failed refreshes
retain the last good catalog and retry with bounded backoff. A per-registry lock
prevents concurrent publication from the viewer and runner; a crashed lock needs
operator inspection. Prices are stale after one hour without success. Hourly
observations are not a promise of instantaneous provider prices or exact charges.
Provider-reported USD cost is stored separately; no total is computed using binary
floating-point arithmetic in the application.

Pi owns the conversation files. The unmodified native HTML export remains under
`pi-private/`; the referenced public export adds an escaped static active-branch
transcript. This makes it readable under the existing script-free, opaque-origin
CSP sandbox without enabling the native viewer's JavaScript. Only referenced
plans, handovers and exports are served; sessions, workspace files, credentials,
and arbitrary paths are not web routes.

## Failure and recovery boundaries

On interruption or failed handback/export, the run remains `recovery-required`
and blocks new work. There is no automatic inference retry, redispatch, worker
continuation, export repair command, or stale-lock removal. Preserve logs and
checkpoints. Inspect any `refainery-*` containers and stop owned workers before
manually recovering storage. Never rerun an agent merely to repair an export.
Use a new scratch storage root for an independent test, not as a way to continue
an interrupted real job while its worker might still be executing.

Compaction and automatic continuation/retry are disabled. A conservative
application context guard reserves space and requests a handover-only turn; it
uses Pi's reported context and a size estimate. Long-context handback and provider
overflow remain **not live-validated**. This is not advertised as a verified Pi
compaction-boundary implementation. Other pending coverage includes forced-crash
recovery, live web search/fetch, repeated subagents, automatic FIFO draining,
production project access, and browser submission controls.

## Checks

```sh
npm run check
npm test
# From the config repository:
node --test tests/*.test.mjs
node tests/typecheck.mjs
```

The application tests include actual SDK construction without model calls,
workflow/storage invariants, hourly registry scheduling, credential isolation,
model provenance, and safe document routing. They use local temporary data.
`skipLibCheck` is enabled because the pinned SDK dependency declarations contain
JSON imports without NodeNext import attributes and an optional Google MCP type
reference. Application and extension code remain strictly typechecked; dependency
declaration checking is not claimed.

Optional browser checks use an externally installed Playwright:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs \
REFAINERY_STORAGE_DIR=build/my-supervised-run \
node tests/browser-production.mjs
```

That check reads a completed deterministic milestone using the configured example
model; it makes no model calls. The existing `browser-intake.mjs` and
`browser-floor.mjs` continue to cover the offline previews.

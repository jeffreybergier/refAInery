# refAInery

A personal AI workshop with a dark, industrial Bootstrap control room.
The dashboard supports offline design fixtures and an opt-in **supervised Pi
backend milestone**: one real request, one worker, durable plans/handovers,
checkpoints, session exports, and recorded model identities. Automatic queue
processing and recovery remain disabled.

See `docs/supervised-milestone.md` for setup, storage, limits, and validation.
Start a live scratch run with `python3 run-once.py --prompt-file
examples/milestone/request.md --storage build/my-supervised-run`. This makes paid
model calls using the existing 1Password item; it does not modify an app checkout.

## Dashboard versions

- `/` redirects to `/v1` (GET and HEAD).
- `/v1` presents the **full agreed v1 workflow**: requests, FIFO queue, sequential
  runs, checkpoints, orchestrator turns, subagent attempts, and handback/review.
- `/v2` preserves the existing execution-oriented design preview described below.
  Both dashboards link to one another; `/v1/` and `/v2/` redirect to canonical URLs.

In test mode, `/api/v1/preview` loads bundled fixtures under `source/fixtures/`:
`requests-v1.json` contains finalized-schema request records; `workflow-v1.json`
contains separate provisional queue/run/checkpoint records based on `SPEC.md`.
Run-relative documents live under `workflow-v1/`. See `source/fixtures/README.md`
for the record conventions and which fields are provisional. These do not finalize
production schemas or implement a production reader, writer, or recovery engine.

### V1 design preview

The following describes the offline fixtures. The opt-in production view reuses
the timeline and inspector, with recorded next-action decisions instead of the
preview's accepted/rejected labels; see `docs/supervised-milestone.md`.

- **Operations:** saved workflow phase, active runs/executions, FIFO request queue
  depth, pending subagent tasks, finished/failed/interrupted attempts, and run
  outcomes. The review ring measures accepted versus rejected attempt handovers,
  not execution completion or verified request success. Context-limit handbacks
  can be accepted while the original task remains unfinished.
- **Factory Floor:** the same shared timeline, selection, zoom, Earlier/Follow,
  keyboard navigation, fixed-height inspector, and refresh preservation as v2.
  Runs and subagents execute sequentially. Unstarted tasks remain in the inspector;
  queued requests do not become fictional execution bars. Explicit observed
  start/end times and turn boundaries are **provisional fixture fields**, never
  derived from checkpoint-save or receipt times. Review waiting does not extend bars.
- **Inspector:** model/provider and frozen configuration, task/attempt/session
  identity, retry/stop reasons, separate execution/review outcomes, applied
  decisions, Markdown plans/handovers, and expandable full checkpoint snapshots.
  Subagent HTML is available after handback; all orchestrator turns link only to
  the shared final session after the run ends. Interrupted attempts have no
  fabricated handover; export failures are explicit and never become valid links.
- **Intake and specification:** original prompts/receipt metadata, independently
  recorded queue membership and run linkage, and each run's frozen model choices
  with 250,000-token configured context capacity.

Only genuinely undefined telemetry remains unavailable: token history/usage,
live activity/heartbeat, factory stop/idle controls, general output-artifact
inventory, and tool policy. Context capacity is not usage. Invalid records or
missing referenced documents clear stale displays instead of falling back to an
older checkpoint. Production mode loads neither fixture set. With `REFAINERY_BACKEND=1` and an
explicit `REFAINERY_STORAGE_DIR`, v1 reads saved real workflow records instead.

## V2 control room

1. **Factory Operations** — simulated Running/Idle/Stopped state; active
   execution, queued task, success, and failure counts; subagent outcome chart;
   input/output token history with an accessible data table. Counts are derived
   from tasks. Success rate uses completed/failed subagents only, excluding
   orchestrators and pending/cancelled work. Token counts are per interval,
   not cumulative. Times and elapsed durations use the frozen fixture snapshot.
2. **Factory Floor** — a shared wall-clock timeline with one compact lane per
   job and a fixed-height detail inspector above it. Select a bar or status icon
   for agent/orchestrator details, timing, status, and available sample transcript.
   Each bar has one left-aligned status icon, vertically centered with its label:
   ▶ running, ✓ finished, × failed, ◇ awaiting review, — cancelled, or ! interrupted.
   Finished does not imply verified success or result acceptance. The inspector
   separates execution outcome from review and shows model/provider, current
   activity, last observation (not a heartbeat), and usage with unknown/partial
   coverage. Optional metadata adds attempt/turn identity, retry/waiting reasons,
   result summaries, artifact labels, diagnostics, and selectable attempt history.
   Missing metadata is explicitly labeled, never synthesized. Review waiting
   does not extend execution bars.
   Bar positions and proportional lengths show execution lifetimes, not CPU activity. Unselected bars have a uniform opaque neutral fill and
   single border; status is shown by text/marker color, and O/S labels identify
   orchestrators/subagents. The selected bar has a light-blue fill and ring
   that persist independently of mouse or keyboard focus. Overlapping executions use up to three thin subrows per
   job, independent of stage numbers. Job labels show overflow and pending counts;
   select a job to access every task, including overflow and unstarted tasks.
   The timeline scrolls internally without growing the page as jobs arrive.
   Sticky labels/ruler, zoom, Earlier, and Follow latest support browsing.
   Browsing away from the latest time pauses following. Selection, zoom, and
   scroll position survive fixture refreshes; removed selections fall back to
   their job or an explicit empty selection. Buttons support Tab and Enter/Space.
   Running bars end at the frozen test snapshot, never the viewer's clock.
3. **Factory Specification** — always-visible reference section at the bottom with
   config-derived agent definitions. These are not active worker processes.

Use **Refresh fixtures** to reload data without reloading the page. Invalid
edits clear the old dashboard instead of leaving apparently healthy stale data.
A non-test server shows honest empty states, never invented live statistics.

## Fast fake-data preview

Keep the three repositories beside one another:

```text
Vibing/
  refAInery/          # app and serve.py
  refAInery-config/
    prod/            # reserved real configuration
    test/config.json # fictional agents and workshop settings
  refAInery-storage/
    prod/            # reserved real run records
    test/workshop.json # fictional operations, runs, and tasks (fixture v2)
    test/transcripts/  # static sample HTML; not Pi-generated
```

```sh
python3 serve.py --test    # optionally: --port 8090
```

Open `http://127.0.0.1:8080` for v1, or `http://127.0.0.1:8080/v2` for the
preserved dashboard. Both modes use the same container launcher,
image, executable/Node-version preflight, dependency setup, and shutdown logic.
No host Node/npm installation is required. Docker (or Podman) must be running.

Test mode supplies explicitly fake `GH_TOKEN` and `STORAGE_REPO` environment
values. It skips 1Password, GitHub authentication, storage cloning, and SDK
installation, and does not mount SDK volumes or production data. Only the sibling
`test/` directories are mounted, read-only. No host credentials or `NODE_OPTIONS`
are forwarded into the container. The server listens on all container interfaces,
but its published host port is loopback-only. There is no production fallback or
write API. Invalid or missing fixtures stop startup; invalid edits after startup
display a preview error. With the image and matching dependencies already cached,
test startup needs no registry access.

For v1, edit the bundled request/workflow JSON and run-relative documents under
`source/fixtures/`, then refresh. The latest complete snapshot drives each run;
older snapshots are retained for inspection, not double-counted in statistics.
For v2, edit either sibling fixture JSON file and refresh the browser. Simulated running,
awaiting-review, completed, and failed runs are frozen design examples, not
live work. All displays are explicitly labeled TEST. Configuration remains
fixture v1; storage uses fixture v2 for telemetry, execution timing, grouping,
and transcript references. The fixture format is intentionally separate from
future production schemas/checkpoints.
See each sibling README for the base fields and references. Optional v2 execution
`details` fields are validated in `source/preview.ts` and covered by
`tests/preview.test.mjs`; existing fixtures need no migration. These fields are fictional presentation
metadata, not a claim of live Pi telemetry. Artifact labels are text only;
artifact downloads and live activity streams are not implemented. Do not put secrets or
real private data in fixtures.

Transcript links open separate tabs containing explicitly labeled sample HTML,
not actual Pi exports. Only files referenced by validated fixture tasks can be
served; symlink escapes and arbitrary paths are rejected. Responses use a
script-free CSP sandbox with an opaque origin. No agent HTML is embedded into
the control room. The supervised backend generates real Pi exports with an added
escaped static transcript for script-free browser inspection.

## Production storage and workflow

`SPEC.md` describes the sequential workflow and saved run state. Each subagent
writes a Markdown handover and stops on completion or at the context boundary.
The application then exports its Pi session to HTML and saves a checkpoint
referencing both files before returning control to the orchestrator. The
orchestrator's session is exported only when the overall run ends, with its HTML
reference in the final checkpoint. Other checkpoints do not trigger exports.

The allowed provider/model list initially contains one choice, with
`contextWindow: 250000` fixed in the run's configuration. The application selects
the orchestrator's model; the orchestrator selects each subagent's model from
that list. The context window is capacity, not an exact handover trigger; the Pi
integration must leave room for handover and verify backend support.

The backend must persist `requestedModel` and provider-reported `actualModel`
per inference call, with unknown/unresolved identities explicit. It must also
fetch the model registry at startup and every hour, durably retain immutable
catalog/pricing snapshots, and expose refresh failures and stale prices. Calls
reference the snapshot current at dispatch so new prices do not rewrite history;
registry estimates remain separate from provider-reported costs. See `SPEC.md`
sections 5.1–5.3. The supervised backend implements registry refresh/snapshots and
per-call identity/usage provenance; economic estimates remain out of scope.

Production request and supervised checkpoint schemas live under
`schemas/storage/v1/`. The backend provides durable publication, explicit
single-request scheduling, and Pi export integration. Other runtime records
currently have TypeScript contracts rather than standalone JSON schemas.
The original preview fixtures remain separate from production records. Full
recovery and unattended scheduling are not implemented.

## Agent personality configuration

`schemas/config/v1/agent.schema.json` defines self-contained agent JSON files
with embedded instructions and explicit `availableTools` allowlists. The sibling
`refAInery-config/prod/agents/` contains initial orchestrator and worker definitions.
These are separate from models, sessions, and preview fixtures. Both personalities
allow provider-native `web_search`; the worker also allows `web_fetch` and Pi's
standard read/write/edit/bash tools. The config repo includes a permission-scoped
web extension adapted from the operator's Pi setup. The supervised runner freezes
these definitions and loads the reviewed web/workflow extensions explicitly;
worker file/shell tools execute in an isolated container. See
`schemas/config/v1/README.md` and `SPEC.md` section 5.4.

## Container launch

```sh
python3 serve.py
```

Open `http://localhost:8080`. The launcher publishes only on host loopback.
It retains the existing 1Password, sibling `refAInery-config` checkout, GitHub,
and Altivec SDK prerequisites. It mounts source and npm manifests read-only,
installs locked production dependencies inside the disposable container, and
starts the default empty production server, selecting `/app/config/prod` and
`/app/storage/prod`. It does not activate the supervised runner. Use the explicit
host-side `run-once.py` recipe for that milestone. Node.js 22.19+, npm, and flock
must be available in the image; schemas are mounted read-only alongside source.

Bootstrap CSS and its JavaScript bundle are served locally, not from a CDN.
No external fonts or image services are used. The initial dependency install
requires npm registry access. Both launch modes mount `developer_cache:/cache`:

- `/cache/npm` stores npm's downloaded package cache.
- `/cache/refainery/dependencies/<key>/node_modules` stores installed production
  dependencies. The key includes both manifests, Node version/platform/architecture,
  npm version, and installation policy. A lock serializes installation; a completion
  marker is written only after success. Matching installations are reused without
  running `npm ci` again, and different keys do not replace active installations.
- `/app/node_modules` is an ephemeral container symlink into that volume. Neither
  launcher creates or uses host `node_modules`. Existing host dependencies are not
  deleted automatically.

Installation uses `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` with
GitHub credentials removed from npm's environment. Old dependency generations
remain in the cache; no automatic pruning is performed. This is a shared trusted
developer volume, not a security boundary against other containers that can write
it. Do not delete the whole volume to clear npm data; it also contains other caches.

## UI-only development and checks

The recommended preview is `python3 serve.py --test`: no host npm or credentials
are needed. The following direct-host commands are optional, not required by either
launcher, and do install dependencies in the checkout:

```sh
npm ci --ignore-scripts
npm start
```

The Node server listens on `0.0.0.0:8080` for container compatibility. Running
`npm start` directly exposes that port on your host interfaces; use the launcher
for loopback-only publication. Do not expose this unauthenticated preview to
untrusted networks.

```sh
npm run check
npm test
```

Tests cover HTTP routes, local assets, dark-theme markup, security headers,
path isolation, fixture validation/isolation/reloading, derived metrics,
shared timeline positioning/overlap packing, chart edge cases, transcript isolation, and both offline
launcher command constructions. Tests use temporary fixtures, so they do not
require the sibling repositories. The automated tests do not access
1Password, start containers, or validate SDK installation.

An optional Chromium interaction regression check uses a separately installed
Playwright (no change to the app's dependencies). Install its Chromium browser,
then run:

```sh
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser-floor.mjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node tests/browser-intake.mjs
```

The v1 check (`browser-intake.mjs`) covers the restored timeline, keyboard
selection, attempt history, handovers, checkpoint inspection, export boundaries,
frozen models, refresh/zoom preservation, exact prompt whitespace, safe text,
mobile width, and empty/error/production states. The floor
check targets `/v2` and uses temporary fixtures and a loopback server to check keyboard selection,
computed bar fills/borders and persistent selection after mouse clicks or blur,
parallel overflow/pending access, zoom/follow, refresh preservation, fixed height,
mobile page width, and empty/error states. It never changes sibling fixtures.

## Files

- `source/public/intake.html` and `intake.js` — full v1 workflow dashboard.
- `source/public/workflow.js` — latest-checkpoint projection into the shared floor.
- `source/intake-preview.ts` — finalized-schema request fixture loading.
- `source/workflow-preview.ts` — provisional workflow validation and document loading.
- `source/fixtures/README.md` — fixture contract and explicit production-model gaps.
- `source/fixtures/requests-v1.json` — fictional, schema-compliant intake records.
- `source/fixtures/workflow-v1.json` and `workflow-v1/` — checkpoint fixtures and documents.
- `source/public/index.html` — preserved v2 Bootstrap page and mobile navigation.
- `source/public/refainery.css` — industrial theme, charts, and timeline layout.
- `source/server.ts` — explicit public asset routes; no general filesystem root.
- `source/main.ts` — shared server entry point and explicit mode selection.
- `source/preview.ts` — read-only, validated test fixture adapter.
- `source/public/preview.js` — safe text/SVG rendering and dashboard interactions.
- `source/public/floor.js` — shared timeline layout, inspector, and navigation.
- `serve.py` — shared container launcher; `--test` selects fictional fixtures.
- `SPEC.md` — implemented web preview and the agreed initial storage/workflow model.

# refAInery

A personal AI workshop with a dark Bootstrap control room and a Pi-backed,
supervised workflow: one request, one worker, plan revisions, handover, review,
checkpoints, native Pi sessions and HTML exports.

## Two environments, all execution in Docker

Keep the three repositories beside each other:

```text
Vibing/
  refAInery/                 # application, extensions, Docker setup and tests
  refAInery-config/
    test/                   # personalities, model.json, catalog and scenarios
    prod/                   # personalities and model.json
  refAInery-storage/
    test/                   # generated scripted runs and legacy UI fixtures
    prod/                   # real run records
```

| | Test | Production |
| --- | --- | --- |
| Config | `refAInery-config/test/` | `refAInery-config/prod/` |
| Storage | `refAInery-storage/test/` | `refAInery-storage/prod/` |
| Pi model provider | Built-in faux provider, scripted responses | OpenRouter |
| Model registry | Local `catalog.json` | Configured OpenRouter catalog |
| 1Password | Not used | API key for an explicit run only |
| Application, tools and checks | Docker | Docker |

Both environments use **the same runner, schemas, workflow tools, persistence,
Pi exporter and dashboard reader**. Only model responses and catalog sourcing
differ. Test runs execute actual tools, not fabricated tool results.

The host needs Python 3 and Docker Compose. Production execution additionally
needs the 1Password CLI. No host Node, npm, Playwright or Apple SDK installation
is needed. Image building downloads dependencies; subsequent runs use the image.
Source is mounted for development, but `node_modules` stays inside the image.
Rebuild after changing dependency manifests or the Dockerfile.

## Start here

From `refAInery/`:

```sh
python3 refinery.py test build
python3 refinery.py test run
python3 refinery.py test serve
```

Open `http://127.0.0.1:8080`. Run and serve are separate actions: starting the
viewer never dispatches a request. Run another command in a second terminal and
click **Refresh saved workflow** to see its records. Use `--port 8090` with
`serve` to view test and production simultaneously. Ctrl-C stops the foreground
container.

The default scenario is `happy-path`. It scripts the orchestrator's plan and
assignment, then exercises the worker's `write`, `read`, `edit` and `bash` tools,
handover, final review and completion. Pi owns the resulting conversation files
and generates the HTML viewers. Model responses are scripted; this is not a
model-quality test or a simulation of OpenRouter's wire protocol.

```sh
python3 refinery.py test run --scenario happy-path
python3 refinery.py test run --scenario provider-error
python3 refinery.py test reset
```

`reset` explicitly removes generated test requests, runs, registry data and writer
lock. Stop test work before resetting. It retains checked-in fixtures and never
operates on production. Nothing is reset at startup.

### Script your own responses

Add `test/scenarios/<name>.json` in the config repository, then pass its name:

```json
{
  "prompt": "A request for the scripted workflow",
  "responses": [
    {
      "agent": "orchestrator",
      "text": "I will save a plan.",
      "tool": "update_plan",
      "arguments": {"markdown": "# Plan\nDescribe the assignment."}
    }
  ]
}
```

Responses are consumed in global execution order: orchestrator, worker, then
orchestrator review. A response can contain text, a tool call, or an `error`
string. Tool arguments use the actual registered Pi schemas. Terminal workflow
tools remain separate calls. See `happy-path.json` for a complete script: the
short example above intentionally exhausts before completing a run.

`--prompt-file request.md` can override the scenario's prompt, but does not make
the scripted provider understand or dynamically solve that request.

## Agent roles and personalities

The harness owns the fundamental orchestrator and subagent contracts. Review
instructions and prompts in the marked top sections of `source/agents/shared.ts`,
`orchestrator.ts`, and `subagent.ts`; workflow descriptions and corrective guidance
have equivalent sections in `source/extensions/workflow.ts` and
`source/backend/workflow.ts`.

Each role has editable `instructions`, `firstPrompt`, `firstReply`, and
`finalAnswer` slots; the orchestrator also has `subagentReview`. `firstReply`
seeds assistant-role history once. A nonblank `finalAnswer` enables one bounded
reminder for a text-only stop without a terminal workflow action. Marker-only
slots are authoring placeholders; request/assignment/handover data is still supplied.

Config files `agents/orchestrator.json` and `agents/worker.json` are optional
personality overlays, not replacements for those contracts. Their optional
`prompts` object uses the same slot names. Each addition is inserted at
`{{ OPTIONAL_PERSONALITY_ADDITION }}` in its harness template; omitted additions
remove the marker, and supplied additions without an insertion point fail
validation. Move old top-level `instructions` into `prompts.instructions`.
With neither file, the built-in roles are used. New run snapshots retain the
resolved prompts, original additions, tools, and original harness templates.
See [the personality contract](schemas/config/v1/README.md) for examples and
legacy tool-allowlist compatibility. Selection remains one orchestrator and one
worker, not a generalized personality catalog.

## Production

Review `refAInery-config/prod/model.json` and `prod/agents/*.json`. The model file
contains the selection previously recorded by the verified milestone; it is
ordinary configuration, not a secret. `MODEL_SELECTED` and `MODEL_REGISTRY` in
1Password are no longer read. Keep the API key in the existing **Dev Key -
refAInery** item as `OPENROUTER_API_KEY`.

```sh
python3 refinery.py prod serve
python3 refinery.py prod run --prompt-file examples/milestone/request.md
```

**Production run makes paid model calls.** Only that action invokes 1Password.
The viewer can refresh the public catalog without credentials. There is no
GitHub login, storage clone, SDK installation, or arbitrary config/storage-root
option in normal startup. Both directories are the sibling `prod/` directories.

The existing worker sandbox is retained: Pi and orchestration run in the app
container; file/shell tools execute in a separate Altivec worker with only its
scratch workspace. The trusted controller has Docker socket access to manage
workers. This implementation adds no network-egress policy or additional
credential/mount enforcement. It does not grant agents access to app checkouts.

The workflow is still supervised and single-request. Existing limits and
recovery behavior remain: one assignment, twelve inference calls, no automatic
queue draining or replay. See [workflow details](docs/supervised-milestone.md).

## Checks

```sh
python3 refinery.py test check
```

This runs inside Docker:

- TypeScript checking, including the application-owned Pi extensions.
- Node unit/contract tests and Python launcher/schema tests.
- End-to-end Pi sessions with real worker tools, checkpoints and HTML exports.
- Scripted inference failure, response exhaustion and tool failure cases.
- Chromium checks of the shared workflow UI, native Pi viewers, and historical
  v1/v2 design fixtures.

Checks use disposable storage under `refAInery-storage/test/.checks/`; they do
not reset or modify the interactive environment's runs. Playwright and its
matching Chromium are installed in the image. No separately installed browser
or host npm commands are needed. Tests do not invoke 1Password or OpenRouter.

## UI and saved records

`/` opens `/v1`. `/v2` redirects to the shared workflow view in both environments.
The timeline/inspector shows saved executions, plans, handovers, checkpoints,
model identities and exports. Saved state is not a heartbeat; successful tool
execution and acceptance of a result remain distinct.

Pi exports open in separate tabs using the existing opaque-origin viewer policy.
Session JSONL, private copies, arbitrary files and workspace contents are not web
routes. Only referenced plan/handover/export documents are served.

Historical design fixtures are retained for regression checks, not another
runtime mode. V1 fixtures now live in `refAInery-storage/test/legacy/v1/`; the
older v2 fixtures remain `test/workshop.json`, `test/transcripts/` and config
`test/config.json`. Neither environment's normal dashboard reads these fixtures.

## Migration notes

- `serve.py [--test]` and `run-once.py [--test]` are small compatibility aliases
  to the same Docker launcher. Prefer the explicit `refinery.py` commands.
- `REFAINERY_BACKEND`, custom storage/config paths and host npm recipes are retired.
- Executable workflow/web extensions and their tests moved from the config repo
  into `source/extensions/` and `tests/`. Both environments use the same code;
  every run still freezes its extension source and hashes.
- Existing milestone artifacts under `build/` have been left untouched. They are
  historical scratch runs, not a third environment. No production data was
  deleted, silently imported, or regenerated.

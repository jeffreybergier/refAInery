# Supervised Pi workflow

The same backend runs in both Docker environments. It executes **one request with
zero or more sequential workers**, then stops; this is not an unattended queue
scheduler or recovery engine.
See the root README for the launcher and setup.

```sh
python3 refinery.py test run --scenario happy-path
python3 refinery.py test serve
# Paid execution, explicitly requested:
python3 refinery.py prod run --prompt-file examples/milestone/request.md
python3 refinery.py prod serve
```

There are no operator-selected storage roots. The launcher mounts the selected
sibling config and storage directories at `/app/config` and `/app/storage`.
The server always reads saved workflow records; no backend-enable flag is needed.
All Node/npm/browser execution occurs in the app container. The host launcher
only constructs Docker commands and obtains a production API key when running.

## Configuration and providers

`model.json` supplies model/provider selection and registry source. Test uses
Pi 1.4.0's built-in faux provider and local `catalog.json`. Scenario JSON supplies
assistant text and tool calls. Production uses OpenRouter and reads only
`OPENROUTER_API_KEY` from the existing 1Password item. Neither test action nor
production viewing needs 1Password. Model selection and registry URL no longer
come from secret fields.

Pi sessions, extension registration, tool dispatch, exports, checkpoint writes
and UI projection are real in both environments. The scripted provider does not
exercise OpenRouter HTTP parsing or model reasoning. Faux usage is recorded as
`faux-estimate`; provider-reported identity/cost remain unknown when absent.

Personalities are loaded from the selected config directory. Executable
extensions now live in `source/extensions/`, not in separate test/prod config.
Their reviewed contents, hashes, SDK version and tool catalog version are frozen
before each execution. `subagents.json` selects exactly `implementer` and `tester`
in both environments. The tool schema and backend enforce these choices; dispatch
uses the selected personality's prompts and tools. Task/attempt records retain
that selection. Test personalities omit native web capabilities; their scripts
only call local/workflow tools. Old configurations without a selection manifest
retain the legacy worker. See `schemas/config/v1/README.md` for the full contract.

Existing resource limits remain: twelve inference requests across all sessions,
2,048 output tokens per call, no provider/agent retries, and a three-minute
deadline per prompted phase. Long-context handback is not live-validated.

## Ownership and sequencing

The application binds caller role/session identity to these tools:

- Orchestrator: `update_plan`, `spawn_subagent`, `finish_request`.
- Worker: `finish_task`, plus its configured file/shell/web capabilities.

Worker stop reasons are `success`, `failure`, and `context-limit`. These report
why the attempt stopped, not independent verification of the request. Request
outcomes are `success`, `failure`, and `question`; the first two produce
`completed` and `failed` run statuses. Any outcome may be reported before worker
dispatch; success does not require a worker handover. A nonempty Markdown handover
is required by `finish_task`, but its headings are not enforced by the backend.

A question retains any saved plan, the question (`resultSummary`), and orchestrator
session export, then saves status/phase `waiting-for-user` without an end
timestamp. It stops execution and blocks new dispatch just like other unfinished
runs. It is not completion or an interruption. Answer ingestion and resuming a
paused run are not implemented yet; operator intervention is required. No
process or inference remains running while waiting.

The application owns dispatch and persistence. Plans are optional; neither
assignment nor finalization requires a plan or a revision in the current turn.
Actions reference the latest plan when present, otherwise `null`. A worker's
`{{ PLAN }}` placeholder receives an empty string when there is no plan. A yielding
workflow tool must be the only tool call in its
assistant message. The tool termination result stops Pi's automatic follow-up.
Receipts make repeat call IDs idempotent; changed arguments with an existing ID
remain an error.

After a worker handover, the application saves its native Pi export, stops the
worker container (including background work), and commits the review checkpoint.
Only then does the orchestrator resume. It may assign another worker without
updating the plan. Each worker has its own session, handover, and export; the next
sandbox uses the same persisted workspace and pinned image but no prior worker
processes or temporary files. The final decision precedes the orchestrator's final
session export and terminal checkpoint.

## Docker workspace

The controller invokes Docker through its socket. Worker tools use Pi's standard
definitions with custom operations delegated to the existing sandbox. The worker
has no network, credentials or Docker socket; its only bind mount is that run's
scratch workspace. Existing read-only root, unprivileged user and resource limits
are retained, not expanded by the environment cleanup.

Docker bind sources are host paths. The launcher supplies the selected host
storage directory so the controller can translate `/app/storage/runs/.../workspace`
to the corresponding host path. Pi-relative tool paths are translated from the
session cwd into `/workspace` too. No host Node process or shell tool execution
is used. Production-native web tools still run through the model API, outside
the worker's shell network policy.

## Storage layout (identical in test and prod)

```text
requests/<request-id>.json
registry/snapshots/<fetch-time>-<snapshot-id>.json
registry/status.json
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

Immutable publication, writer locks, checkpoint validation, explicit interruption
and no automatic recovery are unchanged. Interrupted runs require operator
inspection. For disposable test runs, stop test work and use `test reset`; that
command removes generated records but retains checked-in fixtures. It is not a
production recovery command.

Production registry snapshots refresh at startup and hourly while a runner or
viewer is active, retaining prior observations and explicit failures. Test loads
its local catalog without network calls or hourly refresh. Inference intent is
saved before dispatch, and results before tools execute. Unknown identities and
costs remain unknown; registry observations do not rewrite historical prices.

Pi owns conversation JSONL and generates native HTML via `exportToHtml()`. The
existing viewer policy permits pinned native scripts in an opaque-origin sandbox.
Unknown HTML remains script-free. The old known JSON preamble is removed only in
HTTP responses, not rewritten on disk. Only referenced exports/plans/handovers
are web routes.

## Validation

`python3 refinery.py test check` runs typechecking, unit tests, schema/launcher
checks, scripted end-to-end runs and Chromium checks in Docker. Disposable check
storage is separate from interactive runs. It covers real Pi text and tool-call
streaming, file operations, lifecycle/export boundaries, workflow reads in both
environments, direct completion without workers or plans, repeated assignments
with absent or unchanged plans, workspace continuity across fresh sandboxes, and
scripted provider/tool failures (including failure in a later worker).

Live model quality, OpenRouter transport, paid web tools, crash recovery,
long-context limits and access to actual project checkouts are not established
by scripted tests. No live calls are part of normal checks.

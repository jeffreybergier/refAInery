# refAInery

A personal AI workshop with a dark, industrial Bootstrap control room.
The current dashboard uses fictional, read-only fixtures to design the system
before Pi or real orchestration is connected.

## Control room

1. **Factory Operations** — simulated Running/Idle/Stopped state; active
   execution, queued task, success, and failure counts; subagent outcome chart;
   input/output token history with an accessible data table. Counts are derived
   from tasks. Success rate uses completed/failed subagents only, excluding
   orchestrators and pending/cancelled work. Token counts are per interval,
   not cumulative. Times and elapsed durations use the frozen fixture snapshot.
2. **Factory Floor** — one horizontal execution timeline per run. History is
   ordered by start time, with in-flight groups at the right. Tasks sharing a
   stage stack vertically to represent parallel execution. Timelines initially
   scroll to current/latest work and have keyboard-accessible scrolling and
   Earlier/Latest buttons. Unstarted tasks are listed separately, not drawn as
   past executions. Finished tasks link to sample HTML transcripts when present.
3. **Factory Specification** — always-visible reference section at the bottom with
   config-derived agent definitions. These are not active worker processes.

Use **Refresh fixtures** to reload data without reloading the page. Invalid
edits clear the old dashboard instead of leaving apparently healthy stale data.
A non-test server shows honest empty states, never invented live statistics.

## Fast fake-data preview

Keep the three repositories beside one another:

```text
Vibing/
  refAInery/          # app and tests/serve.py
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
# Compatibility alias: python3 tests/serve.py
```

Open `http://127.0.0.1:8080`. Both modes use the same container launcher,
image, executable/Node-version preflight, dependency setup, and shutdown logic.
No host Node/npm installation is required. Docker (or Podman) must be running.
`tests/serve.py` is only an alias for `serve.py --test`.

Test mode supplies explicitly fake `GH_TOKEN` and `STORAGE_REPO` environment
values. It skips 1Password, GitHub authentication, storage cloning, and SDK
installation, and does not mount SDK volumes or production data. Only the sibling
`test/` directories are mounted, read-only. No host credentials or `NODE_OPTIONS`
are forwarded into the container. The server listens on all container interfaces,
but its published host port is loopback-only. There is no production fallback or
write API. Invalid or missing fixtures stop startup; invalid edits after startup
display a preview error. With the image and matching dependencies already cached,
test startup needs no registry access.

Edit either fixture JSON file and refresh the browser. Simulated running,
awaiting-review, completed, and failed runs are frozen design examples, not
live work. All displays are explicitly labeled TEST. Configuration remains
fixture v1; storage uses fixture v2 for telemetry, execution timing, grouping,
and transcript references. The fixture format is intentionally separate from
future production schemas/checkpoints.
See each sibling README for the fields and references. Do not put secrets or
real private data in fixtures.

Transcript links open separate tabs containing explicitly labeled sample HTML,
not actual Pi exports. Only files referenced by validated fixture tasks can be
served; symlink escapes and arbitrary paths are rejected. Responses use a
script-free CSP sandbox with an opaque origin. No agent HTML is embedded into
the control room. Real Pi export generation is not implemented.

## Container launch

```sh
python3 serve.py
```

Open `http://localhost:8080`. The launcher publishes only on host loopback.
It retains the existing 1Password, sibling `refAInery-config` checkout, GitHub,
and Altivec SDK prerequisites. It mounts source and npm manifests read-only,
installs locked production dependencies inside the disposable container, and
starts the server in production mode, selecting `/app/config/prod` and
`/app/storage/prod` for future integrations. Production config/storage loading
is not implemented yet. Node.js 22.18+, npm, and flock must be available in the image.

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
timeline ordering, chart edge cases, transcript isolation, and both offline
launcher command constructions. Tests use temporary fixtures, so they do not
require the sibling repositories. The automated tests do not access
1Password, start containers, or validate SDK installation.

## Files

- `source/public/index.html` — responsive Bootstrap page and mobile navigation.
- `source/public/refainery.css` — industrial theme, charts, and timeline layout.
- `source/server.ts` — explicit public asset routes; no general filesystem root.
- `source/main.ts` — shared server entry point and explicit mode selection.
- `source/preview.ts` — read-only, validated test fixture adapter.
- `source/public/preview.js` — safe text/SVG rendering and dashboard interactions.
- `serve.py` — shared container launcher; `--test` selects fictional fixtures.
- `tests/serve.py` — compatibility alias for `serve.py --test`.
- `SPEC.md` — intended product architecture and future behavior.

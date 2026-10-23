# refAInery

A personal AI workshop. The current implementation is a Hello World web UI:
Bootstrap 5.3 dark mode, charcoal panels, furnace-orange accents, and a
CSS-drawn refinery. The factory stages are explicitly marked as planned;
no real agents, workflows, or run storage are connected to this page.
A test-only fixture dashboard lets us design configuration and run displays
before implementing Pi or orchestration.

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
    test/workshop.json # fictional runs and tasks
```

```sh
npm ci --ignore-scripts    # one-time setup, or after dependency changes
python3 tests/serve.py     # optionally: --port 8090
```

Open `http://127.0.0.1:8080`. This is the fake-data counterpart to the root
launcher, not a copy of its credential/container operations. Both launch the
same application and assets. Keep both entry points and their tests maintained
when changing startup behavior.

The test launcher binds only to loopback, does not inherit credentials or
`NODE_OPTIONS`, and never runs Docker, `op`, Git, SDK tooling, or Pi. After
installing dependencies it works offline. It reads only the sibling `test/`
fixtures; there is no production fallback and no write API. Invalid or missing
fixtures stop startup. Invalid edits after startup display a preview error.

Edit either fixture JSON file and refresh the browser. Simulated running,
awaiting-review, completed, and failed runs are frozen design examples, not
live work. All displays are explicitly labeled TEST. The versioned fixture
format is intentionally separate from future production schemas/checkpoints.
See each sibling README for the fields and references. Do not put secrets or
real private data in fixtures.

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
is not implemented yet. Node.js 22.18+ and npm must be available in the image.

Bootstrap CSS and its JavaScript bundle are served locally, not from a CDN.
No external fonts or image services are used. The initial dependency install
requires npm registry access. Dependencies are not persisted across container
removal yet.

## UI-only development and checks

The static UI has no authentication or agent integration and can be previewed
without credentials, containers, or Apple SDKs:

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
path isolation, fixture validation/isolation/reloading, and both offline
launcher command constructions. Tests use temporary fixtures, so they do not
require the sibling repositories. They do not access
1Password, start containers, or validate SDK installation.

## Files

- `source/public/index.html` — responsive Bootstrap page and mobile navigation.
- `source/public/refainery.css` — industrial theme and decorative refinery.
- `source/server.ts` — explicit public asset routes; no general filesystem root.
- `source/main.ts` — shared server entry point and explicit mode selection.
- `source/preview.ts` — read-only, validated test fixture adapter.
- `source/public/preview.js` — text-only fixture rendering.
- `tests/serve.py` — fast, credential-free test launcher.
- `SPEC.md` — intended product architecture and future behavior.

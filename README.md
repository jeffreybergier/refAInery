# refAInery

A personal AI workshop. The current implementation is a Hello World web UI:
Bootstrap 5.3 dark mode, charcoal panels, furnace-orange accents, and a
CSS-drawn refinery. The factory stages are explicitly marked as planned;
no agents, workflows, or run storage are connected to this page.

## Container launch

```sh
python3 serve.py
```

Open `http://localhost:8080`. The launcher publishes only on host loopback.
It retains the existing 1Password, sibling `refAInery-config` checkout, GitHub,
and Altivec SDK prerequisites. It mounts source and npm manifests read-only,
installs locked production dependencies inside the disposable container, and
starts the server. Node.js 22.18+ and npm must be available in the image.

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
path isolation, and offline launcher command construction. They do not access
1Password, start containers, or validate SDK installation.

## Files

- `source/public/index.html` — responsive Bootstrap page and mobile navigation.
- `source/public/refainery.css` — industrial theme and decorative refinery.
- `source/server.ts` — explicit public asset routes; no general filesystem root.
- `source/main.ts` — server entry point.
- `SPEC.md` — intended product architecture and future behavior.

# Docker environment consolidation validation

Validated on October 25, 2026, using Docker Desktop's Linux/arm64 engine.

## Commands exercised

- `python3 refinery.py test build`: built the shared app image with Node 24.19.0,
  pinned Pi 1.4.0, Playwright Core 1.64.1 and matching Chromium.
- `python3 refinery.py test check`: all checks ran in Docker:
  - strict application/extension TypeScript check;
  - 77 Node tests;
  - 8 Python launcher tests and 7 JSON Schema tests;
  - real Pi end-to-end execution with scripted responses, actual sandbox
    write/read/edit/bash calls, native sessions/exports, and shared test/prod
    HTTP readers;
  - provider-error, response-exhaustion and tool-error interruption cases;
  - all four Chromium suites (saved workflow, native exports, legacy v1/v2 UI).
- `python3 refinery.py test reset`: retained legacy fixtures.
- `python3 refinery.py test run`: completed the interactive happy-path scenario
  in the fixed sibling test storage. Left the completed example available for
  viewing; generated records are ignored by Git.
- `python3 refinery.py test serve --port 18080`: served that run using the shared
  backend. Verified API mode `test`, source `saved`, completed checkpoint, and
  host-loopback port publication. Stopped the container afterward.

No host Node/npm/browser test execution, 1Password access or OpenRouter model
calls were used. No worker containers remained after the checks. TypeScript
reported no project errors or warnings. Dependency installation still reports
an upstream `node-domexception` deprecation; it is not a new application warning.

## Scope and preserved data

Production provider construction remains the existing Pi/OpenRouter adapter;
the paid production entry point was not executed. Launcher tests cover its
credential retrieval and Docker command construction, and the shared reader was
exercised with generated records under both environment labels. This does not
claim live OpenRouter transport/model/web-tool or crash-recovery validation.

The historical milestone runs under `build/` and pre-existing host dependencies
were not deleted. Production storage was not populated or rewritten. No new
network-egress rules, credential policing or worker restrictions were added;
existing sandbox and workflow behavior remain.

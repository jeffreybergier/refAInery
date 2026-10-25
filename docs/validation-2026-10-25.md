# Supervised milestone validation — October 25, 2026

Historical report from before Docker environment consolidation. The saved run
artifacts are preserved, but the host npm/custom-storage launch recipes are
retired. Use the root README and `environment-validation.md` for current commands
and Docker-only check coverage.

## Verified live result

Final schema-compatible scratch storage: `build/milestone-verified/` (gitignored).

- Run: `run-af020674-f9c8-4ef8-9a87-fa13234725e5`.
- Request: `request-c6755b55-16e2-49cf-a4b7-e0055e1e0040`.
- Outcome: completed.
- One orchestrator session, two orchestrator turns, one worker session/attempt.
- Two Markdown plan revisions, one Markdown handover, and two real Pi exports.
- Seventeen complete checkpoint revisions.
- Seven model calls, each with immutable intent and terminal accounting records.
- Requested model: `~openai/gpt-luna-latest`.
- Provider-reported actual model on all seven calls: `openai/gpt-6-luna`.
- Sum of provider-reported USD costs for this run: `0.001624185`, summed with
  decimal arithmetic for this report. This is not a registry-derived estimate.
- Independently checked the resulting workspace file bytes against
  `refAInery milestone passed\n`; exact match.
- No worker container remained running after completion.

The actual model identifier was observed in provider stream metadata, not inferred
from the requested alias or generated text. The public registry advertised a
1,050,000-token capacity for the requested model; the run explicitly configured
250,000. This checks catalog compatibility, not a live 250,000-token stress test.

There were two earlier successful development runs, plus preflight/registration
failures that made no model calls. Those independent scratch roots were retained
under `build/`; they predate the final checkpoint contract and are not migration
fixtures. They were not automatically resumed or rewritten. Do not point the
current backend at those provisional roots expecting a silent migration.

## Runtime and isolation

- Host: macOS/arm64, Node v26.12.0.
- Pi SDK: pinned `@earendil-works/pi-coding-agent` and `pi-ai` 1.4.0.
- Worker: Linux/arm64 Docker container using the recorded immutable Altivec image
  ID. Network disabled, unprivileged user, read-only root, workspace-only bind
  mount, no credentials, no Docker socket, and resource limits.
- Read/write sandbox preflight passed; the real worker exercised write, read,
  and bash through Pi's standard tool definitions with delegated operations.
- Credentials were obtained through 1Password without printing or saving them.

## Automated/offline checks

- `npm run check`: passed (strict project TypeScript).
- `npm test`: 61 JavaScript tests and 16 Python tests passed.
- Config repository: 12 extension tests passed.
- Config extension SDK typecheck: passed against app-pinned 1.4.0 declarations.
- Personality schema checks: 7 tests passed, including both real config files.
- Chromium production check: real timeline, plans/history, handover, decision,
  requested/actual identities, safe static session export, refresh, and mobile
  layout passed.
- Existing v1 and v2 Chromium preview suites: passed.
- Actual `source/main.ts` opt-in production startup: passed. Startup fetched a new
  registry snapshot while prior inference snapshot references stayed unchanged.
- Hourly idle refresh: tested with a controlled timer, not an hour-long live wait.
- Offline failure checks cover exclusive writers, immutable publication,
  checkpoint corruption, symlink escapes, plan gating, wrong role/session,
  idempotent tool calls, write failure, stale prices, invalid/partial registries,
  and unavailable versus reported model identity/cost.

Upstream declaration compatibility requires `skipLibCheck`: pinned dependencies
contain JSON declaration imports lacking NodeNext attributes and an optional
Google MCP type reference. Implementation code remains strictly checked. The
application's declared Node minimum is 22.19; this run did not separately exercise
that minimum version.

## Explicitly not verified or enabled

- Live context-limit handback, overflow recovery, or exact compaction-boundary
  interception. The current application guard is conservative and compaction is
  disabled, but a long-context test remains necessary.
- Live provider-native web search/fetch. The extension mappings and allowlists
  were tested offline; the live task deliberately required no external research.
- Forced process/power-loss recovery or automatic export repair.
- Unattended FIFO draining, multiple worker assignments, or browser submission.
- Access to real project checkouts or unrestricted worker networking.
- Native Apple builds/devices (not applicable to this web/backend milestone).

Interrupted runs intentionally block further work and require operator inspection.
This milestone demonstrates the successful end-to-end path, not production-ready
autonomous operation.

## Follow-up: native HTML viewer correction

The initial browser check above verified the injected static fallback, not Pi's
actual viewer. That was insufficient: script-free delivery disabled the genuine
export UI. The corrected implementation publishes `session.exportToHtml()` output
unchanged, recognizes the pinned SDK template, and serves it with hash-allowlisted
viewer scripts in an opaque-origin sandbox. It strips the old fallback only from
the HTTP representation; no immutable files or inference records are changed.

Follow-up verification passed:

- Strict application TypeScript, 65 JavaScript tests, and 16 Python tests.
- Both saved milestone exports render native messages and session trees; tool
  controls, parameter expansion, and JSONL downloads work in Chromium.
- An offline fixture generated by Pi's real exporter renders Markdown and tree
  filters. Browser checks confirm blocked arbitrary scripts/event handlers,
  network requests, frames, popups, and origin storage access.
- Native export publication is byte-for-byte, with no transcript synthesis.
- Altered/unknown HTML cannot gain script permissions; Markdown and previews stay
  script-free. GET/HEAD policies agree, and private files remain inaccessible.
- Both existing offline preview browser suites still pass.

No model calls or agent reruns were needed. The already-running server must be
restarted to pick up the code and CSP changes; existing URLs are preserved.

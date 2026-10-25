# Reviewed Pi extensions

`web-search.ts` adapts the operator's local
`~/.pi/agent/extensions/pi-web-search-server.ts`, inspected on 2026-10-25.
It retains that extension's provider-native mappings, but separates permissions
and defaults to granting nothing. It contains no credentials or host paths used
at runtime. The original personal extension was not modified.

## Capabilities, not local tool registrations

This extension modifies provider request payloads. It does not call
`registerTool` and does not implement a local search/fetch client:

| Personality capability ID | OpenRouter mapping | OpenAI Responses mapping |
| --- | --- | --- |
| `web_search` | `openrouter:web_search` | `web_search` |
| `web_fetch` | `openrouter:web_fetch` | Unsupported |

These mappings are inherited from the local extension, not a claim that every
model/provider supports them. Live capability and billing verification remain
part of the Pi spike. Provider-native searches/fetches may incur separate charges.
Search/fetch results are untrusted external content, not workflow instructions.

In production, the orchestrator allows search only. The worker allows search and fetch alongside
Pi's standard read/write/edit/bash tools. The local tools must be constructed by
the backend from the personality allowlist; this extension does not supply them.

## Explicit session-scoped loading

The backend must import `createWebSearchExtension` and pass the frozen
personality's `availableTools` and selected model transport (`provider`, `api`).
Supply the resulting factory through the SDK's explicit extension factory list.
Directly loading the default export enables no web capabilities; it only removes
recognized native web tools already present at this hook.

Factory construction rejects unsupported requested web capabilities and duplicate
allowlist IDs. The backend still owns validation of all other IDs against the
complete catalog. Native capabilities must not be treated as local registered
Pi tools or passed blindly to active-tool selection.

The hook preserves local function declarations and permitted existing native-tool
options, removes recognized denied native web declarations, and avoids duplicates.
A provider/transport mismatch adds nothing and removes recognized native web
declarations; the backend must reject such model changes rather than silently
continue with a different capability set. Malformed payloads are left untouched
for transport validation, not treated as valid requests.

This is not a security boundary against other extensions, shell access, or new
provider tool types. The backend must disable ambient extension discovery, load
only reviewed extensions in a controlled order, validate the final permissions,
and prohibit unauthorized model/transport changes. Do not also load the original
unconditional personal extension. Freeze the reviewed extension code and its
version with the run, together with the personality and tool catalog version.

The application's supervised runner now imports this named factory from a frozen
copy, with explicit session-scoped permissions. It does not load the personal
extension or discover ambient extensions. Live native web behavior remains
unverified; the deterministic first milestone deliberately avoids web calls.

## Workflow tools

`workflow.ts` exports `createWorkflowExtension(Type, availableTools, host)`.
The backend injects TypeBox from its pinned Pi SDK and a caller-bound persistence
callback. This avoids runtime module resolution from the separate config repo.

- `update_plan` saves complete Markdown and returns its revision without ending
  the orchestrator turn.
- `assign_subagent` and `finish_run` save the orchestrator's next action and yield.
- `submit_handover` saves the worker handover/stop reason and yields.

All four execute sequentially. Yielding calls return Pi's termination flag only
after the backend acknowledges durable state. The backend additionally forbids
mixing terminal workflow tools with other calls in a single assistant message;
otherwise a batch could defeat the intended yield. Host errors become failed
tool results, never fabricated success. Default file loading registers no tools.
Role checks, current-turn plan requirements, idempotency, scheduling, exports and
checkpoint transitions are backend responsibilities, not extension-local state.

## Offline checks

Run `python3 refinery.py test check` from the application repository. Extensions
and their tests now live with the application; configuration directories contain
only environment data. Both environments load these same implementations.

The container checks types against pinned Pi 1.4.0 declarations, tests provider
mappings and workflow registration, then runs actual Pi sessions using the faux
provider and Docker worker tools. Test personalities omit native web capabilities.
No host Node installation, 1Password or model service is needed. Third-party
declaration checking remains skipped for the existing upstream NodeNext/optional
dependency issues; extension implementation code is strictly checked.

# Agent Note: Read-only WK and PS service tools in DSH

Status: implemented

English | [中文](2026-08-28-dsh-wk-ps-integration.zh.md)

## Problem

Two sibling local services own durable state for this workspace: the Wiki Server (WK — wiki pages, indexed project-tree source) and the Project Service (PS — projects, missions, attention inbox). A DSH agent had no sanctioned way to read either: dynamic packages cannot POST (the sandbox traps `fetch` and `ctx.web` is URL-only GET), so the self-extension mechanism could not reach either service's API.

## Decision

Two static tool packages in a new `packages/integrations/` group, following the provider pattern of `web-search-exa`: zero-dependency HTTP clients speaking each service's wire envelope directly (WK's `POST /wiki/v1/{family}/{method}` `{ctx, args}` contract; PS's `GET /project/v1/*` `{ok, result}` REST), with no source imports — both services rule that consumers use HTTP only.

- **`tool-wk`** — `wk_search`, `wk_read_nodes` (≤5, server id defaulted from the public metadata route), `wk_roots`, `wk_source_search`, `wk_source_read` over `projectTrees.*`.
- **`tool-ps`** — `ps_projects`, `ps_project`, `ps_missions`, `ps_inbox`; row payloads verbatim as JSON strings, only identity columns extracted (PS owns the shapes; typed projections would drift).

Design rules shared by both:

- **Endpoint resolution is per call, not cached.** WK binds a fresh dynamic port each boot; a cached client would go stale. Config → env → credential file, re-read every call.
- **Credential files follow the services' own convention** — `{clientKey, baseUrl}` JSON (`~/.wiki-service/config/dsh.json`, `~/.project-service/config/dsh.json`). For WK the file doubles as endpoint discovery and absence is a per-call teaching error; for PS it is optional (default port, bootstrap window) and 401/403 maps to mint guidance.
- **Every failure is a teaching error** naming the recovery step (start the service, mint the key, raise `timeoutMs`) — a down service degrades to missing tooling, never a crashed session.
- **Deadlines** fuse the tool-call signal with `timeoutMs` via `dsh-timeout`'s `deadline`; timeout aborts surface as `TimeoutReason` with the elapsed budget in the message.
- **Lossless-JSON-safe views**: optional fields are conditionally spread, never `undefined`-assigned; malformed rows are dropped, not batch-fatal.

Mounting: a new `wkps` agent preset — `standard`'s composition copied and extended with the two rows (the same way the `cordis` preset extends `standard`; presets are complete self-contained compositions, there is no inheritance), so sessions opt in per preset without touching the host bundles. The packages ship as base-bundle dependencies so the preset rows resolve.

## Implementation

- `packages/integrations/tool-wk/src/client.ts` — WK envelope client (`{ctx, args}` in, `{ok, result|error}` out, `WkClientError` with code/status).
- `packages/integrations/tool-wk/src/index.ts` — config/env/file resolution, the five tools, tolerant view projections, `tool:wk` prompt section (`FIRST_PARTY_SECTION_ORDER.TOOL_WK`).
- `packages/integrations/tool-ps/src/{client,index}.ts` — REST twin; `psRowOf` projects `{id, json}` rows; `tool:ps` prompt section.
- `packages/integrations/*/src/invariant.ts` — empty installers: read-only adapters hold no durable state; the external services own every relation.
- `packages/preset/agent-presets/presets/wkps/` — the preset (order 5).

## Tests

37 unit/composition tests: envelope unwrap, error-code mapping, timeout and unreachable branches, credential-file resolution (missing/malformed/valid), and real-Loader composition specs booting a test-only cordis.yml against a 127.0.0.1 stub server — proving the tools register from config and execute end to end, and that missing credentials surface as teaching errors rather than load failures.

## Consequences

Two more local services became first-class knowledge sources for agents on the `wkps` preset, with a repeatable recipe for the next one: a zero-dependency envelope client, per-call endpoint resolution, teaching errors, and lossless-JSON views. The new `packages/integrations/` group is now the home for such adapters. The base bundle carries both packages so any deployment can mount them; `standard` sessions see nothing until the preset is selected.

## Alternatives considered

- **Dynamic packages** — cannot POST; the sanctioned self-extension path does not reach these APIs.
- **A shared seam service (`ctx.wk`/`ctx.ps`) plus separate tool consumers** — the web seam exists because search providers compete; each local service has exactly one backend, so the seam would be ceremony.
- **Importing the services' client SDKs** — both packages are private to their repos; HTTP envelope clients keep DSH decoupled.

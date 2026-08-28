# Agent Note: Model-call admission scheduler on the upstream `llm/stream` waterfall

Status: implemented

English | [中文](2026-08-28-llm-scheduler-on-upstream.zh.md)

## Problem

The harness had no admission control on model calls: any number of concurrent sessions, subagents, and compaction calls hit each provider route unbounded, and a transient provider failure produced one retry-per-caller with no shared view of provider health. The upstream `dsh-llm-retry` package re-runs failed requests at durable agent-step boundaries but does not gate admission: nothing prevented a saturation cascade on one lane from starving compaction and title calls behind interactive traffic.

## Decision

Add one product plugin, `packages/llm/llm-scheduler`, on the upstream `llm/stream` waterfall — not in the agent loop, not behind an HTTP proxy. The architecture splits the admission control into three roles:
- `Plane` — synchronous pure state machine (admission, CAS-fenced mutation, priority-FIFO drain).
- `Coordinator` — bridges the plane's synchronous drain to async waiters, owns cancelable Promise resolutions.
- `Stream gate` — waterfall listener that reserves before `next()` and releases on stream settle.

The plugin exposes `ctx.llmScheduler` (extends `cordisService`) with a `status()` snapshot and a forwarded `llm/scheduler-updated` event. The plugin is registered in `packages/bundle/base/cordis.patch.yml` immediately after `llm-retry` so it gates every call before the retry loop sees them.

## Adaptation against the upstream `LlmFailure` taxonomy

Adapters already classify provider errors into stable `LlmFailure` codes (`TRANSPORT`, `RATE_LIMIT`, `AUTH`, `INVALID_CREDENTIAL`, `INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`, `QUOTA`, `EMPTY`, `TIMEOUT`, `SERVER`, `PI_AI_ERROR`). The scheduler does not classify raw SDK error strings — it projects the upstream code taxonomy into five scheduler-level categories:

| Category | Disposition | Codes |
|---|---|---|
| `TRANSIENT` | Open the lane circuit | `TRANSPORT`, `TIMEOUT`, `SERVER`, `PI_AI_ERROR` |
| `RATE_LIMITED` | Block until `providerRetryAfterMs` | `RATE_LIMIT`, `QUOTA` |
| `AUTH` | Block lane configuration | `AUTH`, `INVALID_CREDENTIAL` |
| `INVALID_CALL` | Fail this call | `INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED` |
| `EMPTY_RESPONSE` | Fail this call (new) | `EMPTY_RESPONSE` |

`EMPTY_RESPONSE` is a new category in the scheduler: a degenerate completion (`stop` finish with zero content blocks) is safe to retry as a fresh call, so the scheduler fails the single call rather than opening the lane circuit. Both `unknown` (over-blocks) and `transport` (over-opens) were wrong.

## Stream settle

The physical attempt is the waterfall's `next()`; settle keys off the upstream stream protocol's finish chunk kind. `stop|tool-calls|max-tokens|aborted` releases the slot and propagates the chunk. `error` calls `decideFailure(category, failure, recovery, nowMs)`, applies the disposition to the lane, then releases. The harness already guarantees central retry authority: `pi-ai` pins SDK `maxRetries` to zero and the DeepSeek adapter uses raw fetch.

## Recovery is process-live

Cooldown timers, the exponential backoff (`initialCooldownMs` capped at `maxCooldownMs`, doubling per consecutive probe failure), `probing` publication, and probe reservation all live in the service class. The plane still owns every availability transition. The unref'd `setInterval` (500ms) advances the plane's clock; on every lane that crosses its cooldown, the lane transitions `CIRCUIT_OPEN` to `PROBING` and the highest-priority queued waiter is promoted as the probe attempt. A successful probe returns the lane to `HEALTHY`; a failed probe doubles the cooldown and reopens the circuit. Configuration-scope blocks never auto-recover.

## What we did not port

- Cross-provider failover stays out (out of scope; future `agent/request` policy with configured fallback chain).
- Per-owner priority semantics — `P0`-`P4` derive from `purpose` (`compaction`, `session-title`, else conversation), not from durable owner types, so the mapping is coarser than the original control plane.
- Durable retry budgets — retry counting stays in `dsh-llm-retry`'s session events; the plane's transient budget exists only as probe-failure backoff.
- Retarget API — the plane reserves one API surface for a future fallback chain that nothing calls yet.

## Rejected alternatives

- A local HTTP proxy (the cc-switch-s-route shape) — cannot see priority or purpose, couples queue lifetime to a desktop app process.
- Loop changes for admission (an `agent/pre-request` gate) — rejected by the plugins-not-loop-changes rule; `llm/stream` already sees every call including compaction, titles, and hand-written `ctx.llm.stream()` calls.

## Implementation

- `packages/llm/llm-scheduler/src/plane.ts` — per-lane registry, status transitions, cooldown timers, probe machinery.
- `packages/llm/llm-scheduler/src/coordinator.ts` — async bridge, cancelable Promise resolutions, disposeAll on plugin unload.
- `packages/llm/llm-scheduler/src/stream-gate.ts` — `llm/stream` waterfall listener, settle by finish chunk kind, reservation error → `LlmError` mapping for stable upstream code dispatch.
- `packages/llm/llm-scheduler/src/failure.ts` — `classifyFailure` and `decideFailure` policy tables.
- `packages/llm/llm-scheduler/src/index.ts` — Service plugin, default-exports `LlmSchedulerService` extending `TypertRemoteService` with `@Remote('status')`, the `llm-scheduler` settings section, and auto-registration of lanes from `ctx.llm.listProviders()` plus first-use `ensureLane`.
- `packages/llm/llm-scheduler/src/invariant.ts` — empty installer with package-specific `No runtime invariant:` reason: process-live state has no durable boundary to check.
- `packages/client/ui-settings-llm-scheduler` — Web Settings Scheduling page over `ctx.remote.llmScheduler.status()` and the bound settings scope.

## Tests

33 unit tests across `failure.spec.ts` (classification + decision policy + providerRetryAfterMs), `plane.spec.ts` (admit/queue/release/decision/cooldown/probe recovery), `coordinator.spec.ts` (async reserve/release flow, signal abort, disposeAll).

Coverage is intentionally not duplicated (no `*-coverage.spec.ts` siblings) — focused behavior tests describe behavior, not correctness.
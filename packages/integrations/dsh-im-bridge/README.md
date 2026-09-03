---
description: "InfiniteMission bridge for users bridging IM workspaces: preset-gated dsh members, receive loops, and arrivals routed into reusable Sessions."
kind: "package-bundle"
---

# @deepseek-ai/dsh-im-bridge

English | [中文](README.zh.md)

## Summary

`dsh-im-bridge` provides the Host `ctx.imBridge`: it watches the preset roster for presets whose `preset.yml` sets `im: true`, joins one `dsh-<preset>` member in every workspace the `im-bridge` settings namespace lists, and owns one `im receive --wait` loop per member. Each mission arrival opens — or reuses — one ordinary DSH Session per (workspace, preset): deterministic id, `meta.cwd` = the workspace, the preset mounted, and the rendered station charter as the opening message. IM is consumed as shipped; the bridge adds no IM-side tools or semantics.

## Table of Contents

- [Composition](#composition)
- [Settings](#settings)
- [Member lifecycle](#member-lifecycle)
- [Routing](#routing)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="composition"></a>

## Composition

Activate as a profile plugin (`dsh plugin --profile web add '@deepseek-ai/dsh-im-bridge'`, or a path spec for a checkout); the shipped `cordis.patch.yml` inserts the single `im-bridge` row. The service statically injects `agents`, `agentPresets`, `sessions`, `settings`, `systemPrompt`, and `workspaceRegistry`, so it composes under any profile carrying the base services. Removing the plugin stops every loop and leaves every member joined.

Config fields (`cordis.yml` row): `imBin` (default `im`), `memberPrefix` (default `dsh`), `receiveTimeoutSec` (default 600), `rescanSec` (default 60). See the [config catalog](../../../docs/config-catalog.md#deepseek-aidsh-im-bridge).

<a id="settings"></a>

## Settings

The `im-bridge` namespace in `<home>/settings.yaml` holds the bridged workspaces:

```yaml
im-bridge:
  workspaces:
    - /absolute/path/to/project
```

Edits apply live (a settings watcher reconciles immediately); preset-directory edits flow in on the rescan interval. A workspace whose path holds no `.im/` directory fails its first `im` command and is retried on the next pass — the bridge does not validate IM workspace state itself.

<a id="member-lifecycle"></a>

## Member lifecycle

Reconcile walks (workspaces × IM-enabled presets). A pair absent from `im agents` joins once, after a roster check — joining an active duplicate id would auto-suffix (`dsh-plan` → `dsh-plan-2`) and silently fork the member, so the bridge re-checks the roster after joining and skips the loop when the exact id did not land. A dropped workspace or cleared `im` flag stops that pair's loop and leaves the member joined; IM-side member deletion is not mirrored (the next reconcile rejoins).

<a id="routing"></a>

## Routing

Each receive cycle's stdout parses into a closed note set and feeds a pure decision table: a mission arrival with a deliverable bound session injects the rendered brief as a follow-up; without one it spawns (re-verifying via `im mission show` first, so a stale queued arrival is dropped rather than spawned); a membership end stops that loop; mission-ended and timeout notes need no session. Sessions carry a deterministic id (`im-<digest>-<preset>`), so a bridge restart adopts the persisted session (`agents.resume`) instead of forking a new one, and every spawned session carries a duty prompt section: work the charter with `im mission doc` / `im mission submit`, never `im join` or `im receive`.

<a id="dev-note"></a>

## Dev Note

The routing core (`src/routing.ts`) is deliberately pure — notes in, decision out, liveness injected — so the decision table is table-testable without a runtime. Process spawning lives only in `src/im-cli.ts`; everything else programs against that interface.

<a id="model-experience"></a>

## Model Experience

### Mission briefs and the duty section

#### What the model sees

A bridged session carries one standing duty prompt section (`im-bridge:duty`, placed after the persona): work each arriving brief with `im mission doc`/`im mission submit`, never `im join` or `im receive`. Each brief is exactly the rendered `im mission show --for` stdout — charter, routes, vocabulary, revision — delivered as one user-turn message from the `im-bridge` source, followed only by later briefs to the same session.

#### Token effect

One brief costs its own text once; the duty section is a fixed few hundred tokens across every turn of the session.

#### KV Cache effect

The duty section is stable across turns; briefs arrive as ordinary user messages, so the request prefix grows only as the conversation does.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One session per (workspace, preset): concurrent missions at one preset's stations queue in that one session (goal: no parallel session pools).
- Arrival staleness is resolved per note by fetching the brief; a member holding several stations sees briefs in arrival order, not station priority.
- No bridge-side tier management: grant/revoke stay IM-side operations.

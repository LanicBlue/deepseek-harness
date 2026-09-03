# Agent Note: The InfiniteMission bridge

Status: implemented

English | [中文](2026-09-03-dsh-im-bridge.zh.md)

## Problem

DSH sessions and the InfiniteMission (`im`) orchestration CLI both manage work, but nothing joined them: an IM mission arriving at a station had no DSH agent to work it, and a DSH agent had no identity inside an IM workspace. The removed WK/PS integration (`d741374765` removed it with "coordination moves to InfiniteMission, integration design to follow") left the follow-up open. The design problem is binding two systems without forking either: IM owns membership, stations, and mission semantics; DSH owns sessions, presets, and composition. The bridge must consume IM exactly as shipped (v0.3.0) and express everything else through DSH's ordinary extension points.

## Decision

The bridge ships as [`@deepseek-ai/dsh-im-bridge`](../../../../packages/integrations/dsh-im-bridge/README.md) in a new `packages/integrations/` group, activated as a profile plugin. Four decisions carry the design:

**Preset opt-in, not a bridge-side roster.** A preset joins the bridge by setting `im: true` in its own `preset.yml` (an opt-in beside the existing display metadata). The bridge reconciles (workspaces × flagged presets) — there is no second list of bridged agents to drift, and the composition a mission is worked by stays owned by the preset it names.

**The bridge is the sole member and listener.** Reconcile guard-joins `dsh-<preset>` per workspace (roster-checked both sides of the join, because `im join` auto-suffixes a taken active id and would silently fork the member) and owns one `im receive --wait` child per member — im's single-consumer lock means nothing else may hang waiters for those ids. The spawned sessions carry a duty prompt section: work the charter with `im mission doc`/`submit`, never `im join`/`im receive`.

**Routing is a pure table; adoption beats forking.** Each cycle's stdout parses into a closed note set feeding a decision function with an injected liveness probe (no runtime in the test). Session ids are deterministic per (workspace, preset) — `im-<digest>-<preset>` — so a bridge restart adopts the persisted session via `agents.resume` rather than spawning a twin. A stale queued arrival is re-verified by fetching the rendered brief first; a membership end stops that member's loop without re-hanging.

**Spawn follows the webhook recipe.** Canonical Workspace, `agents.create` with `meta.cwd` = the workspace and `meta.agentPreset` = the preset, preset mounted in `setup`, then the `im mission show --for` stdout delivered as the opening message through a dedicated `im-bridge` message source. Sessions are ordinary shared-store sessions — visible in the web UI by construction, no hidden types.

## Consequences

One session per (workspace, preset) means concurrent missions queue in that session — visible ordering traded for fan-out. IM-side member deletion is not bridged back; the next reconcile rejoins, so a deleted member reappears until its preset flag or workspace entry goes away. Tier management stays entirely IM-side: the bridge only consumes the tier-tagged roster rows.

## Alternatives considered

**Why not per-mission sessions?** Spawning a session per arrival multiplies processes for the same preset and abandons the working context (tools, editor state, transcript) each mission at that preset builds; the spec also rejected parallel session pools per (workspace, preset).

**Why not mirror IM state in the bridge?** A mirrored member table is a second copy of IM state with its own drift; the roster re-read per reconcile gives the same answers from the source of truth.

**Why not bridge-side grants (tier management)?** Im's manage tier is console-only by design; a bridge verb granting tiers would fork that authority into a second surface.

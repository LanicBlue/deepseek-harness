---
description: "The integrations group map: bridges that bind external orchestrator semantics onto DSH Sessions, for users and maintainers navigating the group."
kind: "package-group"
---

# packages/integrations

English | [中文](README.zh.md)

## Summary

The integrations group hosts bridges between DSH and external orchestration systems. A bridge package consumes the external system's own CLI contract as-is, turns its deployment-side configuration into DSH composition, and routes the system's events into ordinary DSH Sessions — no private session types, no parallel state. The group currently holds the InfiniteMission bridge: agent presets flagged `im: true` become `dsh-<preset>` members in configured IM workspaces, and mission arrivals open or reuse one visible Session per (workspace, preset).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>

## Packages

| Package | Role | ctx key |
|---|---|---|
| [`dsh-im-bridge`](dsh-im-bridge/README.md) | InfiniteMission bridge: preset-gated members, bridge-owned `im receive` loops, arrivals routed into reusable Sessions | provides `ctx.imBridge` |

-----

<a id="related-documentation"></a>

## Related documentation

- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-im-bridge) — the bridge's accepted config fields.
- [InfiniteMission bridge Agent Note](../../.agents/notes/implemented/feature/2026-09-03-dsh-im-bridge.md) — design home for the routing table, member lifecycle, and spawn recipe.

-----

<a id="dev-note"></a>

## Dev Note

Integration packages are consumers twice over: of the external system's CLI contract (pinned to the verified version, every output format parsed in one module) and of DSH's ordinary extension points (agent registry, preset roster, settings namespaces). Anything the external system cannot express through its published surface becomes a documented gap, not a fork of its semantics.

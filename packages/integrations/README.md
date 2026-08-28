---
description: "The integrations group map: read-only model tools over external local services (the Wiki Server and the Project Service) for users and maintainers navigating the group."
kind: "package-group"
---

# integrations/ — local-service tool family

English | [中文](README.zh.md)

## Summary

The integrations group holds model-facing, read-only tool adapters over external local services: each package speaks one service's versioned HTTP envelope with zero source imports, resolves its endpoint and credential per call, and maps every failure to a teaching error naming the recovery step. The group exists because such adapters are neither web-search providers (no competing backends) nor harness services (no in-process seam); they are projections of services that own their own state. Today it covers the Wiki Server (`tool-wk`: wiki search, node reads, indexed project-tree source) and the Project Service (`tool-ps`: projects, missions, attention inbox).

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)

-----

<a id="packages"></a>
## Packages

| Package | Responsibility | ctx key |
|---|---|---|
| [`tool-wk`](tool-wk/README.md) | Five read-only tools over the local Wiki Server contract API | registers into `ctx.tools` |
| [`tool-ps`](tool-ps/README.md) | Four read-only tools over the local Project Service REST API | registers into `ctx.tools` |

-----

<a id="related-documentation"></a>
## Related documentation

- [Tool schema catalog](../../docs/tool-catalog.md) — the generated schemas the model receives.
- [Adding a package](../../docs/cookbook/adding-a-package.md) — the checklist every new package here follows.

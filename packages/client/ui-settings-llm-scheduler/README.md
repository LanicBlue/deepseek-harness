---
description: "The Web Settings scheduling page for users and maintainers configuring lane limits and observing the live admission plane."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-llm-scheduler

English | [中文](README.zh.md)

## Summary

Model-call scheduling panel for Web Settings. The browser plugin registers one localized `settings.section` contribution with id `scheduler`; it owns the whole page: a configuration area over the `llm-scheduler` settings namespace and a read-only runtime observation area.

The configuration area writes through the bound settings scope (`ctx.settingsScope.bind`), one whole top-level field per edit (`lanes`, `priorityByPurpose`, `recovery`), revision-fenced and ordered by the scope itself. Lane rows are the `llm.providers` directory plus any lane key the stored section still carries, so an override for a route the directory no longer lists stays visible and editable. An empty concurrency field means unlimited and drops the row's entry entirely (an absent entry is the scheduler's own unlimited default); a disabled lane persists an explicit entry carrying `Number.MAX_SAFE_INTEGER`, the stored section's unlimited value, so the switch survives while the stored section stays minimal. Priority selects and the two recovery cooldowns write the whole object they belong to. All edits are live: the scheduler re-applies its section on every settings commit.

The observation area reads `llmScheduler.status` once on first open and again on every forwarded `llm/scheduler-updated` notification (status alone) and on `llm/adapters-updated` or `connection/reset` (the whole panel, never before first open). It renders the lane table with availability badges, in-flight and queued counts, and concurrency limits, plus the redacted recent-failure list. A Host composition without the scheduler plugin does not mount this page.

## Table of Contents

- [Summary](#summary)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Model Experience

None, as the section renders a browser configuration and observability UI; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **`statusDebounceMs` is not editable here** — the panel edits the fields the scheduling page needs (`lanes`, `priorityByPurpose`, `recovery`); the debounce window stays in `settings.yaml`.
- **No history** — the runtime area shows the current snapshot only; retained recent failures are the Host's bounded redacted list, with no aggregation or timeline.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer working context — click to expand</summary>

The store joins two independent loads (provider directory, scheduler observation) behind one generation counter; pushed `llm/scheduler-updated` notifications refresh the observation alone, while `llm/adapters-updated` and `connection/reset` reload the whole panel — never before the first explicit open. Lane rows derive from the directory plus stored-section keys so orphaned overrides stay editable.

</details>

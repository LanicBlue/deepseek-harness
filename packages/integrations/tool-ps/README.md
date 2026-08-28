---
description: "The model-facing read-only Project Service tools for users and maintainers choosing, configuring, or debugging ps_projects, ps_project, ps_missions, and ps_inbox."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ps

English | [中文](README.zh.md)

## Summary

`dsh-tool-ps` gives the agent four read-only tools over a local Project Service (PS): `ps_projects` (the project directory), `ps_project` (one project's full record), `ps_missions` (a project's one-shot task contracts), and `ps_inbox` (a project's attention claims). The client speaks PS's REST envelope directly (`GET /project/v1/...`) with zero PS imports — PS's consumers-use-HTTP-only rule. Row payloads ride verbatim as JSON strings: PS owns the shapes, these tools never guess fields beyond the identity columns. Endpoint and Bearer key resolve per call from explicit config, environment, or an optional credential file; every failure maps to a teaching message naming the recovery step.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin in any composition where the agent should read PS-owned project/work state. It requires the `ctx.tools` and `ctx.systemPrompt` services plus a running local PS instance.

### The four tools

- `ps_projects()` — List projects. Each row: the recognized `projectId` column plus the full record verbatim as JSON.
- `ps_project(project_id)` — One project's full record, verbatim as JSON.
- `ps_missions(project_id)` — The project's missions, each row verbatim as JSON.
- `ps_inbox(project_id)` — The project's attention claims, each row verbatim as JSON.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-tool-ps'
```

No config is the expected path against a default-port PS in its bootstrap window. Resolution order per call: explicit `baseUrl`/`apiKey` config, then `$PS_BASE_URL` (endpoint) and `$DSH_PS_API_KEY` (key), then the optional credential file.

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `$PS_BASE_URL`, then the credential file, then `http://127.0.0.1:7600` | PS endpoint |
| `apiKey` | credential file, then `$DSH_PS_API_KEY` | Bearer `psk_` key |
| `credentialFile` | `~/.project-service/config/dsh.json` | Optional `{clientKey, baseUrl}` file |
| `timeoutMs` | `10,000` | Per-request timeout |

Once PS has service clients, reads need a key: mint one (`POST /project/v1/_clients` during the bootstrap window, or with an operator key) and configure `apiKey` or write the credential file. A 401/403 surfaces as a teaching error naming that step.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client.ts` is a stateless REST client: one GET per call, `dsh-timeout`'s `deadline` fusing the tool-call signal with `timeoutMs`, `{ok, result}`/`{ok, error}` unwrapping into `PsClientError` (code + status preserved), 401/403 mapped to credential-minting guidance. `src/index.ts` resolves the endpoint per call and projects rows as `{id, json}` — the id column tried from a per-tool field list, the payload kept verbatim. Unlike WK, a missing credential file is not an error: PS has a default port and an unauthenticated bootstrap window, so keyless operation is legal until clients exist.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains guidance on when to read PS-owned state and how to treat an unreachable or unauthenticated service: as missing tooling, and to ask the user rather than assuming an empty project list.

##### Local project-service guidance

```markdown
A local Project Service (PS) may own the project/work state for this workspace: the project directory, each project's missions, and its attention inbox. When a task references PS-owned state, read it with ps_projects, ps_project, ps_missions, and ps_inbox instead of guessing. These tools are read-only; acting on work (execute, ack, delegate) stays with the service's own consumers. When a PS tool reports the service as unreachable or unauthenticated, treat that as missing tooling and ask the user rather than assuming an empty project list.
```

#### Token effect

Small fixed input cost per request while active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The generated [`ps_projects`, `ps_project`, `ps_missions`, and `ps_inbox` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-ps) while this tool set is visible.

#### Token effect

Fixed schema cost on each request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **Read-only, four routes.** Acting on work — `work/execute`, attention ack/defer/delegate, mission creation — stays with PS's own consumers; the tools never mutate PS state.
- **Verbatim JSON rows, not typed views.** The model reads full records as JSON strings. Typed projections would duplicate PS's contract in this repo and drift; identity columns are the only extracted fields.
- **No event stream.** The SSE feed and consumer gateway (WebSocket) are out of scope; every read is a fresh snapshot.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer working context — click to expand</summary>

Endpoint resolution is deliberately per call: WK binds a fresh dynamic port each boot, so any client cache would go stale across a restart. The cost is one tiny credential-file read per tool call. View projections drop malformed rows instead of failing the batch — a WK field change should never take a tool down.

</details>

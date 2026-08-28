---
description: "The model-facing read-only Wiki Server tools for users and maintainers choosing, configuring, or debugging wk_search, wk_read_nodes, wk_roots, wk_source_search, and wk_source_read."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-wk

English | [中文](README.zh.md)

## Summary

`dsh-tool-wk` gives the agent five read-only tools over a local Wiki Server (WK): `wk_search` (full-text wiki search), `wk_read_nodes` (read up to 5 pages by node id), `wk_roots` (the tree directory), `wk_source_search` and `wk_source_read` (search and read the indexed source of registered project trees). The client speaks WK's contract envelope directly (`POST /wiki/v1/{family}/{method}`) with zero WK imports — WK's consumers-use-HTTP-only rule. Endpoint and Bearer key resolve per call from explicit config, environment, or WK's consumer credential file, so a restarted WK with a rotated dynamic port heals without a remount. Every failure — server down, credential missing, credential rejected, timeout — maps to a teaching message naming the recovery step instead of failing the session.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin in any composition where the agent should consult durable workspace knowledge that lives in WK: wiki pages and per-repository project trees. It requires the `ctx.tools` and `ctx.systemPrompt` services plus a running local WK instance.

### The five tools

- `wk_search(query, limit?)` — Full-text search across knowledge pages. Each hit carries node id, tree id, path, optional name/score/snippet.
- `wk_read_nodes(node_ids[≤5], server_id?)` — Read wiki pages by node id with content; `server_id` defaults to the local server's own id.
- `wk_roots(include_retired?)` — List knowledge roots: id, name, path, retired flag.
- `wk_source_search(tree, pattern, mode?, scope?, file_globs?, limit?)` — Search an indexed repository's source (exact/substring/glob/regex).
- `wk_source_read(tree, path, start_line?, end_line?)` — Read an indexed repository file, optionally a 1-based inclusive line range.

### Configuration

```yaml
- name: '@deepseek-ai/dsh-tool-wk'
```

No config is the expected path when the default credential file exists. Resolution order per call: explicit `baseUrl`/`apiKey` config, then `$DSH_WK_API_KEY` (key) and `$WIKI_SERVER_DATA_ROOT` (data root), then the credential file.

| Field | Default | Meaning |
|---|---|---|
| `dataRoot` | `~/.wiki-service`, then `$WIKI_SERVER_DATA_ROOT` | WK data root holding `config/` |
| `credentialFile` | `<dataRoot>/config/dsh.json` | WK consumer credential `{clientKey, baseUrl}` |
| `baseUrl` | from the credential file | Explicit endpoint override |
| `apiKey` | credential file, then `$DSH_WK_API_KEY` | Explicit Bearer key override |
| `timeoutMs` | `10,000` | Per-request timeout |

Mint the credential once on the WK side (its client administration issues a `wsk_` key); write `{"clientKey": "...", "baseUrl": "http://127.0.0.1:<port>"}` to the credential file. A missing file is a per-call teaching error, never a load failure — mount the plugin freely, mint later.

<a id="understand-the-implementation"></a>
## Understand the implementation

`src/client.ts` is a stateless envelope client: one fetch per call, `dsh-timeout`'s `deadline` fusing the tool-call signal with `timeoutMs`, `{ok, result}`/`{ok, error}` unwrapping into `WkClientError` (code + status preserved). `src/index.ts` resolves the endpoint per call (so credential and port changes apply without a remount), projects wire rows onto lossless-JSON-safe views that drop malformed entries rather than failing the batch, and renders terse per-hit lines. Each tool contributes a generic pending card only; results render from canonical values.

## Model Experience

### System prompt

#### What the model sees

Every request in this plugin's registration scope contains guidance on when to consult WK and how to treat an unreachable or unauthenticated server: as missing tooling, not as absence of the knowledge.

##### Local wiki guidance

```markdown
A local Wiki Server (WK) may hold durable knowledge for this workspace: wiki pages plus per-repository project trees with indexed source. Before re-deriving facts from scratch, wk_search the wiki and wk_source_search the project trees; read exact pages with wk_read_nodes and indexed source with wk_source_read; wk_roots lists the available trees. When a WK tool reports the server as unreachable or unauthenticated, treat that as missing tooling and fall back to other sources — not as absence of the knowledge.
```

#### Token effect

Small fixed input cost per request while active.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation or disposal may invalidate reuse from this prompt section.

### Tool schemas

#### What the model sees

The generated [`wk_search`, `wk_read_nodes`, `wk_roots`, `wk_source_search`, and `wk_source_read` schemas](../../../docs/tool-catalog.md#deepseek-aidsh-tool-wk) while this tool set is visible.

#### Token effect

Fixed schema cost on each request where the tools are visible.

#### KV Cache effect

Prefix-stable while tool definitions and visibility are unchanged. Registration lifecycle or scoped restrictions may invalidate reuse from the first changed schema token.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the tools are a poor fit. They are current package constraints, not a task backlog.

- **Read-only, five routes.** Writes (page create/update, tree registration) stay out of v1; the tools never mutate WK state.
- **Per-call endpoint resolution trades a file read for self-healing.** A busy agent pays one tiny credential-file read per tool call; a cached client would go stale across WK restarts because WK binds a fresh dynamic port each boot.
- **Search-hit shapes are projected, not schema-checked.** Unknown WK field additions pass through the tolerant extractors; unknown removals surface as dropped optional fields, never as failed batches.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Maintainer working context — click to expand</summary>

Endpoint resolution is deliberately per call: WK binds a fresh dynamic port each boot, so any client cache would go stale across a restart. The cost is one tiny credential-file read per tool call. View projections drop malformed rows instead of failing the batch — a WK field change should never take a tool down.

</details>

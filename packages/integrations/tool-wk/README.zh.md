---
description: "面向模型的 Wiki Server 只读工具，供选择、配置或排查 wk_search、wk_read_nodes、wk_roots、wk_source_search 与 wk_source_read 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-wk

[English](README.md) | 中文

## 概述

`dsh-tool-wk` 给 agent 五个作用于本机 Wiki Server（WK）的只读工具：`wk_search`（知识页全文搜索）、`wk_read_nodes`（按节点 id 读至多 5 页）、`wk_roots`（树目录）、`wk_source_search` 与 `wk_source_read`（搜索/读取已注册项目树的索引源码）。客户端直接讲 WK 的 contract 信封（`POST /wiki/v1/{family}/{method}`），零 WK 源码引用——遵守 WK 的“消费者只走 HTTP”规则。端点与 Bearer key 每次调用从显式配置、环境变量或 WK 的消费者凭据文件解析，因此 WK 重启换动态端口后无需重挂插件即自愈。一切失败——服务未启动、凭据缺失、凭据被拒、超时——都映射为点名恢复步骤的教学错误，而不是搞挂会话。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 agent 应当查阅存放于 WK 的持久工作区知识（知识页与按仓库的项目树）的组合里挂载本插件。它需要 `ctx.tools` 与 `ctx.systemPrompt` 服务，以及一个运行中的本机 WK 实例。

### 五个工具

- `wk_search(query, limit?)` — 知识页全文搜索。每个命中带节点 id、树 id、路径，及可选的名称/分数/摘要。
- `wk_read_nodes(node_ids[≤5], server_id?)` — 按节点 id 读知识页内容；`server_id` 缺省取本机服务自身 id。
- `wk_roots(include_retired?)` — 列出知识根：id、名称、路径、是否退役。
- `wk_source_search(tree, pattern, mode?, scope?, file_globs?, limit?)` — 搜索已索引仓库源码（exact/substring/glob/regex）。
- `wk_source_read(tree, path, start_line?, end_line?)` — 读已索引仓库文件，可选 1 起始的闭区间行号。

### 配置

```yaml
- name: '@deepseek-ai/dsh-tool-wk'
```

默认凭据文件存在时，零配置即预期路径。每次调用的解析顺序：显式 `baseUrl`/`apiKey` 配置，然后 `$DSH_WK_API_KEY`（key）与 `$WIKI_SERVER_DATA_ROOT`（数据根），然后凭据文件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dataRoot` | `~/.wiki-service`，然后 `$WIKI_SERVER_DATA_ROOT` | 持有 `config/` 的 WK 数据根 |
| `credentialFile` | `<dataRoot>/config/dsh.json` | WK 消费者凭据 `{clientKey, baseUrl}` |
| `baseUrl` | 取自凭据文件 | 显式端点覆盖 |
| `apiKey` | 凭据文件，然后 `$DSH_WK_API_KEY` | 显式 Bearer key 覆盖 |
| `timeoutMs` | `10,000` | 单请求超时 |

在 WK 侧铸造一次凭据（其客户端管理签发 `wsk_` key）；把 `{"clientKey": "...", "baseUrl": "http://127.0.0.1:<port>"}` 写入凭据文件。文件缺失是每次调用的教学错误，绝不是加载失败——先挂插件、后铸凭据完全可行。

<a id="understand-the-implementation"></a>
## 理解实现

`src/client.ts` 是无状态信封客户端：每次调用一个 fetch，`dsh-timeout` 的 `deadline` 把工具调用信号与 `timeoutMs` 融合，`{ok, result}`/`{ok, error}` 解包为 `WkClientError`（保留 code 与 status）。`src/index.ts` 每次调用解析端点（凭据与端口变更免重挂即生效），把 wire 行投影为 lossless-JSON 安全的视图——畸形条目被丢弃而不是拖垮整批，并渲染紧凑的逐命中行。每个工具只贡献通用 pending 卡片；结果从 canonical 值渲染。

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

本插件注册范围内的每个请求都包含“何时查 WK、如何对待不可达或未认证的服务”的指引：当作工具缺失，而不是知识不存在。

##### 本地 wiki 指引

```markdown
A local Wiki Server (WK) may hold durable knowledge for this workspace: wiki pages plus per-repository project trees with indexed source. Before re-deriving facts from scratch, wk_search the wiki and wk_source_search the project trees; read exact pages with wk_read_nodes and indexed source with wk_source_read; wk_roots lists the available trees. When a WK tool reports the server as unreachable or unauthenticated, treat that as missing tooling and fall back to other sources — not as absence of the knowledge.
```

#### Token 影响

激活期间每请求固定的小额输入成本。

#### KV Cache 影响

插件作用域与指引文本不变时前缀稳定。激活或卸载可能使本提示段的重用失效。

### 工具 schema

#### 模型看到的内容

本工具集可见时，模型看到生成的 [`wk_search`、`wk_read_nodes`、`wk_roots`、`wk_source_search` 与 `wk_source_read` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-wk)。

#### Token 影响

工具可见的每个请求承担固定 schema 成本。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定。注册生命周期或作用域限制可能从首个变更 schema token 起使重用失效。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制定义工具何时不是好选择。它们是当前包约束，不是任务积压。

- **只读、五条路由。** 写入（建页/改页、注册树）不在 v1 内；这些工具绝不改动 WK 状态。
- **每次调用解析端点，用一次文件读换取自愈。** 繁忙 agent 每次工具调用多付一次极小的凭据文件读；缓存客户端会因 WK 每次启动绑定新动态端口而在重启后失效。
- **搜索命中按投影而非 schema 校验。** WK 未来新增字段会经容错提取器透传；未来删字段表现为可选字段缺失，绝不会拖垮整批。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

端点解析刻意逐调用进行：WK 每次启动绑定新的动态端口，任何客户端缓存都会在重启后失效。代价是每次工具调用一次极小的凭据文件读。视图投影丢弃畸形行而不是拖垮整批——WK 字段变更绝不应弄垮工具。

</details>

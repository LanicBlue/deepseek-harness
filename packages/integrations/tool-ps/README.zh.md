---
description: "面向模型的 Project Service 只读工具，供选择、配置或排查 ps_projects、ps_project、ps_missions 与 ps_inbox 的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ps

[English](README.md) | 中文

## 概述

`dsh-tool-ps` 给 agent 四个作用于本机 Project Service（PS）的只读工具：`ps_projects`（项目目录）、`ps_project`（单个项目完整记录）、`ps_missions`（项目的一次性任务契约）、`ps_inbox`（项目的 attention 认领收件箱）。客户端直接讲 PS 的 REST 信封（`GET /project/v1/...`），零 PS 源码引用——遵守 PS 的“消费者只走 HTTP”规则。行载荷以 JSON 字符串逐字透传：PS 拥有形状，这些工具除身份列外绝不猜测字段。端点与 Bearer key 每次调用从显式配置、环境变量或可选凭据文件解析；一切失败都映射为点名恢复步骤的教学错误。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在 agent 应当读取 PS 拥有的项目/工作面状态的组合里挂载本插件。它需要 `ctx.tools` 与 `ctx.systemPrompt` 服务，以及一个运行中的本机 PS 实例。

### 四个工具

- `ps_projects()` — 列项目。每行：可识别的 `projectId` 列 + 完整记录逐字 JSON。
- `ps_project(project_id)` — 单个项目完整记录，逐字 JSON。
- `ps_missions(project_id)` — 项目的 missions，每行逐字 JSON。
- `ps_inbox(project_id)` — 项目的 attention 认领，每行逐字 JSON。

### 配置

```yaml
- name: '@deepseek-ai/dsh-tool-ps'
```

对默认端口、bootstrap 窗口期的 PS，零配置即预期路径。每次调用的解析顺序：显式 `baseUrl`/`apiKey` 配置，然后 `$PS_BASE_URL`（端点）与 `$DSH_PS_API_KEY`（key），然后可选凭据文件。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | `$PS_BASE_URL`，然后凭据文件，然后 `http://127.0.0.1:7600` | PS 端点 |
| `apiKey` | 凭据文件，然后 `$DSH_PS_API_KEY` | Bearer `psk_` key |
| `credentialFile` | `~/.project-service/config/dsh.json` | 可选 `{clientKey, baseUrl}` 文件 |
| `timeoutMs` | `10,000` | 单请求超时 |

PS 一旦存在服务客户端，读取就需要 key：铸一个（bootstrap 窗口内 `POST /project/v1/_clients`，或持 operator key）并配置 `apiKey` 或写凭据文件。401/403 会以点名该步骤的教学错误呈现。

<a id="understand-the-implementation"></a>
## 理解实现

`src/client.ts` 是无状态 REST 客户端：每次调用一个 GET，`dsh-timeout` 的 `deadline` 把工具调用信号与 `timeoutMs` 融合，`{ok, result}`/`{ok, error}` 解包为 `PsClientError`（保留 code 与 status），401/403 映射为铸凭据指引。`src/index.ts` 每次调用解析端点并把行投影为 `{id, json}`——id 列按各工具的字段优先表提取，载荷逐字保留。与 WK 不同，凭据文件缺失不是错误：PS 有默认端口与未认证的 bootstrap 窗口，在出现客户端之前无 key 运行是合法的。

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

本插件注册范围内的每个请求都包含“何时读取 PS 拥有的状态、如何对待不可达或未认证的服务”的指引：当作工具缺失，并询问用户而不是假设项目列表为空。

##### 本地 project-service 指引

```markdown
A local Project Service (PS) may own the project/work state for this workspace: the project directory, each project's missions, and its attention inbox. When a task references PS-owned state, read it with ps_projects, ps_project, ps_missions, and ps_inbox instead of guessing. These tools are read-only; acting on work (execute, ack, delegate) stays with the service's own consumers. When a PS tool reports the service as unreachable or unauthenticated, treat that as missing tooling and ask the user rather than assuming an empty project list.
```

#### Token 影响

激活期间每请求固定的小额输入成本。

#### KV Cache 影响

插件作用域与指引文本不变时前缀稳定。激活或卸载可能使本提示段的重用失效。

### 工具 schema

#### 模型看到的内容

本工具集可见时，模型看到生成的 [`ps_projects`、`ps_project`、`ps_missions` 与 `ps_inbox` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ps)。

#### Token 影响

工具可见的每个请求承担固定 schema 成本。

#### KV Cache 影响

工具定义与可见性不变时前缀稳定。注册生命周期或作用域限制可能从首个变更 schema token 起使重用失效。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

这些限制定义工具何时不是好选择。它们是当前包约束，不是任务积压。

- **只读、四条路由。** 对工作的操作——`work/execute`、attention ack/defer/delegate、创建 mission——留给 PS 自己的消费者；这些工具绝不改动 PS 状态。
- **逐字 JSON 行，非类型化视图。** 模型以 JSON 字符串读完整记录。类型化投影会把 PS 的契约复制进本仓并漂移；身份列是唯一提取的字段。
- **无事件流。** SSE 与 consumer gateway（WebSocket）不在范围内；每次读取都是全新快照。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

端点解析刻意逐调用进行：WK 每次启动绑定新的动态端口，任何客户端缓存都会在重启后失效。代价是每次工具调用一次极小的凭据文件读。视图投影丢弃畸形行而不是拖垮整批——WK 字段变更绝不应弄垮工具。

</details>

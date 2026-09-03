---
description: "面向桥接 IM 工作区用户的 InfiniteMission 桥：preset 门控的 dsh 成员、receive 循环、到达事件路由进可复用会话。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-im-bridge

[English](README.md) | 中文

## 概述

`dsh-im-bridge` 提供 Host 侧 `ctx.imBridge`：它盯住 preset 名册里 `preset.yml` 标了 `im: true` 的 preset，在 `im-bridge` settings 命名空间列出的每个工作区里各加入一个 `dsh-<preset>` 成员，并为每个成员持有一条 `im receive --wait` 循环。mission 每次到达，都会为该（工作区， preset）对开一个——或复用——普通 DSH 会话：确定性 id、`meta.cwd` 指向工作区、preset 挂载完成、渲染后的工位章程作为开场消息。IM 按原样消费，桥不添加任何 IM 侧工具或语义。

## 目录

- [组合](#composition)
- [设置](#settings)
- [成员生命周期](#member-lifecycle)
- [路由](#routing)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知局限与遗留事项](#known-limitations-and-deferred-work)

-----

<a id="composition"></a>
## 组合

作为 profile 插件启用（`dsh plugin --profile web add '@deepseek-ai/dsh-im-bridge'`，或检出目录的路径写法）；自带的 `cordis.patch.yml` 只插入一行 `im-bridge`。服务静态注入 `agents`、`agentPresets`、`sessions`、`settings`、`systemPrompt`、`workspaceRegistry`，因此在任何带基础服务的 profile 下都可组合。移除插件会停掉全部循环并保留所有已加入的成员。

配置字段（`cordis.yml` 行）：`imBin`（默认 `im`）、`memberPrefix`（默认 `dsh`）、`receiveTimeoutSec`（默认 600）、`rescanSec`（默认 60）。见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-im-bridge)。

<a id="settings"></a>
## 设置

`<home>/settings.yaml` 里的 `im-bridge` 命名空间持有被桥接的工作区：

```yaml
im-bridge:
  workspaces:
    - /absolute/path/to/project
```

编辑即时生效（settings 监听器立刻 reconcile）；preset 目录的编辑按重扫间隔流入。路径下没有 `.im/` 目录的工作区会在第一条 `im` 命令上失败并在下一轮重试——桥自己不校验 IM 工作区状态。

<a id="member-lifecycle"></a>
## 成员生命周期

reconcule 遍历（工作区 × 启用 IM 的 preset）。`im agents` 里缺失的一对加入一次，加入前先查名册——对重名活跃 id 执行 join 会自动加后缀（`dsh-plan` → `dsh-plan-2`），悄悄分叉成员身份；因此加入后再查一次名册，精确 id 没落住就跳过该循环。工作区被移除或 `im` 标志被清掉时，该对的循环停止、成员保留；IM 侧的成员删除不回写镜像（下一轮 reconcile 重新加入）。

<a id="routing"></a>
## 路由

每个 receive 周期的 stdout 解析成闭合的通知集合，喂给纯决策表：mission 到达且绑定会话可投递时，渲染后的章程作为 follow-up 注入；没有时走 spawn（先经 `im mission show` 复验，陈旧的排队到达被丢弃而不是误开会话）；成员资格结束则停掉该循环；mission 结束与超时通知不需要会话。会话持有确定性 id（`im-<digest>-<preset>`），桥重启后通过 `agents.resume` 接续持久会话而不是新开一个；每个开出的会话都带一段职责 prompt 章节：按章程用 `im mission doc` / `im mission submit` 作业，绝不执行 `im join` 或 `im receive`。

<a id="dev-note"></a>

## 开发备注

路由核心（`src/routing.ts`）刻意保持纯函数——通知进、决策出、活性注入——决策表因此可以脱离运行时做表驱动测试。进程生成只存在于 `src/im-cli.ts`；其余全部面向该接口编程。

<a id="model-experience"></a>

## 模型体验

### mission 简报与职责章节

#### 模型看到什么

桥接会话带一段常驻职责 prompt 章节（`im-bridge:duty`，位于 persona 之后）：用 `im mission doc`/`im mission submit` 处理每份到达的简报，绝不执行 `im join` 或 `im receive`。每份简报就是 `im mission show --for` 的原始 stdout——章程、路由、词表、revision——作为一条来自 `im-bridge` 源的用户轮次消息投递，其后只有发往同一会话的后续简报。

#### Token 影响

一份简报只花它自身文本的一次成本；职责章节在会话每一轮固定占几百 token。

#### KV 缓存影响

职责章节跨轮次稳定；简报以普通用户消息到达，请求前缀只随对话自然增长。

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与遗留事项

- 每个（工作区， preset）对一个会话：同一 preset 各工位的并发 mission 在这一个会话里排队（目标即不建并行会话池）。
- 到达的陈旧性按单条通知经拉取章程解决；守多个工位的成员按到达顺序看到章程，没有工位优先级。
- 桥不做 tier 管理：授权与收回留在 IM 侧操作。

# Agent Note: 上游 `llm/stream` waterfall 上的模型调用准入调度器

Status: implemented

[English](2026-08-28-llm-scheduler-on-upstream.md) | 中文

## 问题

Harness 对模型调用没有任何准入控制：任意数量的并发 session、子代理与 compaction 调用可以无限制地命中每个 provider 路由，一次瞬时的 provider 失败会在每个调用方各产生一次重试（走 `dsh-llm-retry`），却没有对 provider 健康状况的共享视图。上游的 `dsh-llm-retry` 包只在持久化 agent-step 边界上重跑失败请求，但不做准入：没有任何一条机制能阻止一个 lane 的饱和级联饿死 compaction 与 title 调用。

## 决策

新增一个产品插件 `packages/llm/llm-scheduler`，挂在上游 `llm/stream` waterfall 上——不在 agent loop 里，不在 HTTP 代理后。准入控制拆成三个角色：
- `Plane` ——同步纯状态机（准入、CAS 栅栏变更、优先级 FIFO 出队）。
- `Coordinator` ——把 plane 的同步出队桥接到异步等待者，持有可取消的 Promise 决议。
- `Stream gate` ——waterfall 监听器，在 `next()` 之前预约，stream 落定时释放。

插件暴露 `ctx.llmScheduler`（继承自 `cordisService`），提供 `status()` 快照与转发的 `llm/scheduler-updated` 事件。插件注册在 `packages/bundle/base/cordis.patch.yml` 中紧接 `llm-retry` 之后，这样它在 retry 看到之前就为每个调用把关。

## 针对上游 `LlmFailure` 分类的适配

适配器已经把 provider 错误归类到稳定的 `LlmFailure` 码（`TRANSPORT`、`RATE_LIMIT`、`AUTH`、`INVALID_CREDENTIAL`、`INVALID_REQUEST`、`CONTEXT_WINDOW_EXCEEDED`、`QUOTA`、`EMPTY_RESPONSE`、`TIMEOUT`、`SERVER`、`PI_AI_ERROR`）。调度器不去分类原始 SDK 错误字符串，而是把上游码映射到五个调度器层级的类别：

| 类别 | 裁决 | 码 |
|---|---|---|
| `TRANSIENT` | 熔断 lane | `TRANSPORT`、`TIMEOUT`、`SERVER`、`PI_AI_ERROR` |
| `RATE_LIMITED` | 阻塞到 `providerRetryAfterMs` | `RATE_LIMIT`、`QUOTA` |
| `AUTH` | 阻塞 lane 配置 | `AUTH`、`INVALID_CREDENTIAL` |
| `INVALID_CALL` | 失败本次调用 | `INVALID_REQUEST`、`CONTEXT_WINDOW_EXCEEDED` |
| `EMPTY_RESPONSE` | 失败本次调用（新） | `EMPTY_RESPONSE` |

`EMPTY_RESPONSE` 是调度器新增的类别：退化完成（零内容块的 `stop` finish）作为新调用重试是安全的，所以调度器失败本次调用而不是熔断 lane。`unknown`（过阻塞）与 `transport`（过熔断）都是错的。

## 流落定

物理尝试是 waterfall 的 `next()`；落定基于上游流协议的 finish chunk 种类。`stop|tool-calls|max-tokens|aborted` 释放槽位并向上传播 chunk。`error` 调用 `decideFailure(category, failure, recovery, nowMs)`，把裁决应用到 lane，然后释放。Harness 已经保证中央重试权：`pi-ai` 把 SDK `maxRetries` 钉在零，DeepSeek adapter 用原生 fetch。

## 恢复是进程存活态

冷却定时器、指数回退（`initialCooldownMs` 以 `maxCooldownMs` 为上限，连续探测失败翻倍）、`probing` 状态发布、探测预约都活在服务类里。Plane 仍掌握每一个可用性迁移。unref'd `setInterval`（500ms）推进 plane 的时钟；每当 lane 越过它的冷却，就把 lane 从 `CIRCUIT_OPEN` 转到 `PROBING`，并把优先级最高的排队等待者升格为探测尝试。成功探测使 lane 返回 `HEALTHY`；失败探测把冷却翻倍并重新熔断。配置级阻塞永不自动恢复。

## 没有移植的东西

- 跨 provider failover 不在范围（out of scope；未来 `agent/request` 策略下配置回退链）。
- 按 owner 的优先级语义——`P0`-`P4` 从 `purpose` 派生（`compaction`、`session-title`，其余即 conversation），而不是从持久化 owner 类型，所以映射比原版控制面更粗。
- 持久化重试预算——重试计数完全留在 `dsh-llm-retry` 的 session 事件里；plane 的瞬态预算只以探测失败回退的形式存在。
- Retarget API——plane 保留一个尚无调用的 API 面，给未来的回退链。

## 拒绝的方案

- 本地 HTTP proxy（cc-switch 形）——看不到 priority 或 purpose，把队列寿命绑到桌面 app 进程。
- Loop 改造做准入（`agent/pre-request` gate）——被「plugin-not-loop」规则否决；`llm/stream` 已经看到每一次调用，包括 compaction、title 与手写的 `ctx.llm.stream()` 调用。

## 实现

- `packages/llm/llm-scheduler/src/plane.ts` ——per-lane 注册表、状态迁移、冷却定时器、探测机器。
- `packages/llm/llm-scheduler/src/coordinator.ts` ——异步桥接、可取消的 Promise 决议、插件卸载时的 disposeAll。
- `packages/llm/llm-scheduler/src/stream-gate.ts` ——`llm/stream` waterfall 监听器，按 finish chunk 种类落定，预约错误 → `LlmError` 映射以保证上游码 dispatch 稳定。
- `packages/llm/llm-scheduler/src/failure.ts` ——`classifyFailure` 与 `decideFailure` 策略表。
- `packages/llm/llm-scheduler/src/index.ts` ——Service 插件，默认导出 `LlmSchedulerService`，继承自 `cordisService`。
- `packages/llm/llm-scheduler/src/invariant.ts` ——空 installer，带包级「无 runtime invariant」原因：进程存活态没有持久化边界可校验。

## 测试

33 个单元测试，分布在 `failure.spec.ts`（分类 + 决策策略 + providerRetryAfterMs）、`plane.spec.ts`（admit/queue/release/decision/cooldown/probe recovery）、`coordinator.spec.ts`（异步 reserve/release 流程、signal abort、disposeAll）。

不复制覆盖测试（没有 `*-coverage.spec.ts` 孪生兄弟）——聚焦行为测试描述行为而非正确性。
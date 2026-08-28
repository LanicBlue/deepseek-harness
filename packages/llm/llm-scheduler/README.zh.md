---
description: "模型调用准入调度器，供配置 per-provider lane、优先级、冷却恢复与策略扩展事件的用户与维护者阅读。"
kind: "package-reference"
---

# `@deepseek-ai/dsh-llm-scheduler`

[English](README.md) | 中文

<a id="summary"></a>
## 概述

服务插件：把每一次模型调用经 `llm/stream` waterfall 上的进程内准入平面调度。每个调用在 adapter 边界之前预约一个 per-provider lane 槽位；lane 以 `P0`-`P4` 优先级 FIFO 施加有界并发，物理失败按 scope 降级 lane 或路由可用性，并用冷却探测让真实排队中的 waiter 重新合格。状态是进程存活态：重启即开启新的观察周期，发起请求的 agent turn 与进程同亡，不会悬挂。

调度内核是一个经过实战检验的控制面的忠实移植：同步纯状态机（准入、CAS 栅栏变更、优先级 FIFO 出队）加上把同步出队桥接到异步等待者的 reservation coordinator。两处适配把它落在本 harness 的流协议上：失败事实派生自 harness 已归一化的 `LlmFailure` 分类（`TRANSPORT`、`RATE_LIMIT`、`CONTEXT_WINDOW_EXCEEDED` 等码映射到调度类别；原版的厂商错误分类瀑布不再必要，故不存在），物理尝试就是 `llm/stream` waterfall 的 `next()` 而非 SDK 调用——adapter 原样保留，既有的「adapter 不重试」纪律（pi-ai 把 SDK `maxRetries` 钉在零；DeepSeek adapter 用原生 fetch）本就保证重试权在中央。

每个流终态在 finish chunk 向上游传播之前落定 plane，释放的槽位立即再派发。正常 stop、tool-calls、max-tokens 完成不证明任何 provider 健康信息，静默完结。error finish 被归一化为脱敏失败事实并裁决：瞬态类别（`transport`、`timeout`、`server_overload`）熔断 lane；带重置时间的限流窗口与模型不可用阻塞到该时刻；认证与模型配置错误阻塞配置；调用级类别（`empty_response`、`invalid_request`、策略拒绝）只失败单次调用，不触碰 lane 健康。裁决落定后逻辑调用即取消——重试策略（`dsh-llm-retry`）以全新调用拥有自己的持久预算来负责任何重试，因此被裁决挂起的孤儿调用永远不会被选为探测者、也不会复活进无人认领的槽位。

冷却恢复只用真实流量重新合格化 lane，绝不发合成健康请求：冷却（从 `initialCooldownMs` 指数起步、以以 `maxCooldownMs` 封顶、连续探测失败翻倍）到期时，scope 转入 `probing`，plane 里优先级最高的排队 waiter 作为探测尝试派发。它成功即证明该 scope 健康、释放其余 waiter；失败则以以翻倍冷却重新熔断。配置级配置（`BLOCK_CONFIG`、`BLOCK_MANUAL`）不自动恢复；lane 重 重配置会把可用性重置为 healthy，开启新的观察周期。

```yaml
- name: '@deepseek-ai/dsh-llm-scheduler'
  config:
    priorityByPurpose:
      compaction: P0
      conversation: P1
      'session-title': P4
    lanes:
        openai:
          enabled: true
          maxConcurrency: 2
    recovery:
      initialCooldownMs: 5000
      maxCooldownMs: 300000
```

未配置的 lane 不限并发——默认组合在配置 lane 之前不改变任何行为。

## 目录

- [概述](#summary)
- [策略扩展事件](#policy-extension-events)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="policy-extension-events"></a>
## 策略扩展事件

调度器把两个决策点开放为 Cordis `bail` 事件：策略插件（含 agent 运行时定义的动态包）监听事件即可改写路由与裁决，不必 fork 本包：

- `llm/scheduler-route`——每次准入前咨询。监听器返回目标 lane key 即把本次调用改道（分时路由、维护窗口、金丝雀分流）；返回 `undefined` 或 `false` 弃权。胜出的 key 就地改写 `options.provider`，预约与物理派发保持同一 lane。
- `llm/scheduler-decide`——每个 error finish 之后、内置裁决表之前咨询。监听器返回 `FailureDecision` 即生效；`{ kind: 'retarget', to, openCircuitMs? }` 由 gate 统一执行：释放源槽位、按提示熔断源 lane、在目标 lane 重新准入（每次调用最多 2 跳，防策略回环）。

两个事件按监听器注册顺序分发（`ctx.on(name, listener, true)` 可插队优先）；监听器必须同步且无副作用，抛异常的监听器作废整次咨询并回退内置行为。事件 facts 只含路由/裁决相关字段，失败事实已脱敏。

```ts
// A time-of-day routing policy plugin (host half; the same code mounts
// unchanged as a dynamic package or a patch row).
import type { Context } from '@deepseek-ai/cordis'
import type { RouteFacts } from '@deepseek-ai/dsh-llm-scheduler/types'

export function apply(ctx: Context): void {
  ctx.on('llm/scheduler-route', (facts: RouteFacts) => {
    const hour = new Date(facts.now).getUTCHours()
    return hour >= 9 && hour < 18 && facts.provider === 'deepseek-official'
      ? 'deepseek-backup'
      : undefined
  })
}
```

<a id="model-experience"></a>
## 模型体验

无。调度器只做准入与转发——既不组装也不发送 provider 请求，不在任何模型请求的数据路径上，也不出现在任何模型的输出里。

#### KV Cache 影响

无。调度器既不组装也不发送 provider 请求。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **跨 provider failover** 不在范围：降级 lane 把调用者挂停；路由切换属于未来 `agent/request` 策略下的配置回退链。
- **按 owner 的优先级语义。** 原版从持久化 owner 类型派生 `P0`-`P4`；本 harness 只暴露 `purpose`（`compaction`、`session-title`，其余即 conversation），因此映射是 purpose 到类别，可配置但更粗：一个 session 的后台子代理调用与交互轮次共享 `P1`。
- **持久化重试预算留在 plane。** 重试计数完全放在 `dsh-llm-retry` 的 session 事件里；plane 的瞬态预算只以探测失败回退的形式存在。
- **配置化回退链**暂不做：`retarget` 已可执行监听器指定的失败改道（见 `llm/scheduler-decide`），但持久化的按路由回退链属于未来 `agent/request` 策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

plane 是同步纯状态机；coordinator 把它的出队桥接到异步等待者；stream gate 是 `llm/stream` 上唯一的监听器。设置变更实时重应用（`applySettings`），lane 注册跟随 `llm/adapters-updated`。中止的排队等待者必须同时离开 pending 表与 plane 队列——见 `Plane.removeWaiter`——否则幽灵会虚增 `queued` 并吞掉释放的槽位。

</details>

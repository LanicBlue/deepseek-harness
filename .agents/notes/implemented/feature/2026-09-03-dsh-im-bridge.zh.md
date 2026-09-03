# Agent Note: InfiniteMission 桥

Status: implemented

[English](2026-09-03-dsh-im-bridge.md) | 中文

## 问题

DSH 会话与 InfiniteMission（`im`）编排 CLI 各自管理作业，但没有东西把它们接起来：mission 到达一个工位时没有 DSH agent 来做它，DSH agent 在 IM 工作区里也没有身份。被移除的 WK/PS 集成（`d741374765` 移除，留言"协调移入 InfiniteMission，集成设计随后跟上"）留下了这个尾巴。设计难题在于绑定两个系统而不分叉任何一个：IM 拥有成员、工位与 mission 语义；DSH 拥有会话、preset 与组合。桥必须原样消费 IM（v0.3.0），其余一切通过 DSH 的常规扩展点表达。

## 决策

桥以 [`@deepseek-ai/dsh-im-bridge`](../../../../packages/integrations/dsh-im-bridge/README.zh.md) 落在新 `packages/integrations/` 组，作为 profile 插件启用。四个决策撑起设计：

**preset 侧选择加入，而非桥侧名册。** preset 在自己的 `preset.yml` 里写 `im: true` 即加入桥（与既有展示元数据并排的选择位）。桥对（工作区 × 标志 preset）做 reconcile——不存在第二份会漂移的被桥接 agent 清单，而作业某个 mission 的组合仍由它所指的 preset 拥有。

**桥是唯一的成员与监听者。** reconcile 为每个工作区守卫式加入 `dsh-<preset>`（join 两侧都查名册——`im join` 对占用中的活跃 id 会自动加后缀，悄悄分叉成员），并为每个成员持有唯一一条 `im receive --wait` 子进程——im 的单消费者锁意味着其他任何东西都不能为这些 id 挂 waiter。开出的会话带一段职责 prompt 章节：用 `im mission doc`/`submit` 按章程作业，绝不 `im join`/`im receive`。

**路由是纯决策表；接续优于分叉。** 每个周期的 stdout 解析成闭合通知集，喂给带注入活性探针的决策函数（测试不需要运行时）。会话 id 按（工作区， preset）确定性生成——`im-<digest>-<preset>`——桥重启后经 `agents.resume` 接续持久会话而不是开孪生。陈旧的排队到达先拉取渲染章程复验；成员资格结束则停掉该成员的循环且不再重挂。

**spawn 遵循 webhook 配方。** 规范 Workspace、`agents.create` 带 `meta.cwd` = 工作区与 `meta.agentPreset` = preset、preset 在 `setup` 里挂载，然后 `im mission show --for` 的 stdout 作为开场消息经专用 `im-bridge` 消息源投递。会话是普通的共享存储会话——天然出现在 web UI，没有隐藏类型。

## 后果

每个（工作区， preset）一个会话，并发 mission 在该会话里排队——用可见顺序换掉了扇出。IM 侧删除成员不回写；下一轮 reconcile 重新加入，被删成员因此在 preset 标志或工作区条目移除之前会一直重现。tier 管理完全留在 IM 侧：桥只消费带 tier 标的名册行。

## 备选方案

**为什么不是按 mission 开会话？** 每次到达开会话会让同一 preset 的进程数翻倍，并丢掉该 preset 在每个 mission 里积累的工作上下文（工具、编辑器状态、transcript）；spec 也拒绝了按（工作区， preset）建并行会话池。

**为什么不在桥里镜像 IM 状态？** 镜像成员表是 IM 状态的第二份拷贝，带自己的漂移；每轮 reconcile 重读名册能从真源拿到同样的答案。

**为什么不做桥侧授权（tier 管理）？** im 的 manage 层在设计上仅控制台可设；桥侧动词授权会把这个权力分叉出第二个表面。

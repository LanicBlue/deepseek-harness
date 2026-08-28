# @deepseek-ai/dsh-client-ui-settings-llm-scheduler

[English](README.md) | 中文

Web 设置中的模型调用调度面板。浏览器插件注册一个 id 为 `scheduler` 的本地化 `settings.section` 贡献，并拥有整个页面：基于 `llm-scheduler` 设置命名空间的配置区，以及只读的运行时观测区。

配置区通过绑定的设置 scope（`ctx.settingsScope.bind`）写入，每次编辑写入一个完整的顶层字段（`lanes`、`priorityByPurpose`、`recovery`），版本围栏与写入顺序由 scope 自己保证。通道行是 `llm.providers` 目录加上已存分节中仍存在的通道键，因此目录已不列出的路由的覆盖项依然可见、可编辑。并发上限留空表示不限，并整行丢弃该条目（缺席条目正是调度器自身的不限默认值）；停用一条不限并发的通道时会存下显式条目，携带线路上的不限值 `Number.MAX_SAFE_INTEGER`，使开关状态得以保留，同时已存分节保持最小。优先级下拉与两个恢复冷却字段每次写入其所属的完整对象。所有修改即时生效：调度器在每次设置提交后重新应用其分节。

观测区在首次打开时读取一次 `llmScheduler.status`，此后随转发的 `llm/scheduler-updated` 通知（仅状态）以及 `llm/adapters-updated` 或 `connection/reset`（整个面板，且首次打开前绝不拉取）刷新。页面渲染通道表（可用性徽标、执行中与排队计数、并发上限）以及脱敏后的最近失败列表。未加载调度插件的 Host 组合不会挂载本页。

## 模型体验

无，因为本分区渲染的是浏览器配置与观测界面；不触达任何模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **`statusDebounceMs` 不在此编辑** —— 面板只编辑调度页所需的字段（`lanes`、`priorityByPurpose`、`recovery`）；去抖窗口仍留在 `settings.yaml`。
- **无历史** —— 运行时区只显示当前快照；保留的最近失败是 Host 侧有界脱敏列表，没有聚合或时间线。

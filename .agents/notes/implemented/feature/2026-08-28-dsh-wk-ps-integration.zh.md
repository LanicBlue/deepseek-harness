# Agent Note: DSH 中的 WK 与 PS 服务只读工具

Status: implemented

[English](2026-08-28-dsh-wk-ps-integration.md) | 中文

## 问题

两个姊妹本机服务持有此工作区的持久状态：Wiki Server（WK——知识页、已索引的项目树源码）与 Project Service（PS——项目、missions、attention 收件箱）。DSH agent 此前没有任何受认可的读取途径：动态包不能 POST（沙箱 trap 了 `fetch`，而 `ctx.web` 只有 URL-only GET），自扩展机制够不到任一服务的 API。

## 决策

在新建的 `packages/integrations/` 组里放两个静态工具包，沿用 `web-search-exa` 的 provider 形态：零依赖 HTTP 客户端直接讲各服务的 wire 信封（WK 的 `POST /wiki/v1/{family}/{method}` `{ctx, args}` contract；PS 的 `GET /project/v1/*` `{ok, result}` REST），零源码引用——两个服务都规定消费者只走 HTTP。

- **`tool-wk`** — `wk_search`、`wk_read_nodes`（≤5 个，server id 从公开 metadata 路由取默认）、`wk_roots`、`wk_source_search`、`wk_source_read`，走 `projectTrees.*`。
- **`tool-ps`** — `ps_projects`、`ps_project`、`ps_missions`、`ps_inbox`；行载荷以 JSON 字符串逐字透传，只提取身份列（PS 拥有形状；类型化投影会漂移）。

两包共同的设计规则：

- **端点每次调用解析，不缓存。** WK 每次启动绑定新的动态端口；缓存客户端会在重启后失效。配置 → 环境变量 → 凭据文件，每次调用重读。
- **凭据文件沿用服务自身惯例**——`{clientKey, baseUrl}` JSON（`~/.wiki-service/config/dsh.json`、`~/.project-service/config/dsh.json`）。对 WK，该文件兼任端点发现，缺失是每次调用的教学错误；对 PS 它是可选的（默认端口、bootstrap 窗口），401/403 映射为铸凭据指引。
- **一切失败都是教学错误**，点名恢复步骤（启动服务、铸 key、调大 `timeoutMs`）——服务宕机退化为工具缺失，绝不是会话崩溃。
- **Deadline** 用 `dsh-timeout` 的 `deadline` 把工具调用信号与 `timeoutMs` 融合；超时中止以 `TimeoutReason` 呈现并在消息里带已耗预算。
- **Lossless-JSON 安全视图**：可选字段条件展开，绝不赋 `undefined`；畸形行被丢弃而不是拖垮整批。

挂载：新建 `wkps` agent preset——复制 `standard` 组合并追加两行（与 `cordis` preset 扩展 `standard` 的方式一致；preset 是完整自包含组合，没有继承机制），会话按 preset 选用，不动 host bundle。两包作为 base-bundle 依赖随部署发布，preset 行才能解析。

## 实现

- `packages/integrations/tool-wk/src/client.ts` — WK 信封客户端（进 `{ctx, args}`，出 `{ok, result|error}`，`WkClientError` 带 code/status）。
- `packages/integrations/tool-wk/src/index.ts` — 配置/环境/文件解析、五个工具、容错视图投影、`tool:wk` 提示段（`FIRST_PARTY_SECTION_ORDER.TOOL_WK`）。
- `packages/integrations/tool-ps/src/{client,index}.ts` — REST 孪生；`psRowOf` 投影 `{id, json}` 行；`tool:ps` 提示段。
- `packages/integrations/*/src/invariant.ts` — 空 installer：只读适配器不持有持久状态；外部服务拥有一切关系。
- `packages/preset/agent-presets/presets/wkps/` — preset 本体（order 5）。

## 测试

37 个单元/组合测试：信封解包、错误码映射、超时与不可达分支、凭据文件解析（缺失/畸形/合法），以及真 Loader 组合测试——以 test-only cordis.yml 对着 127.0.0.1 stub 服务启动，证明工具从配置注册并端到端执行，凭据缺失以教学错误呈现而非加载失败。

## 后果

两个本机服务成为 `wkps` preset 上 agent 的一等知识来源，并留下可复制的接入配方：零依赖信封客户端、按调用解析端点、教学错误、lossless-JSON 视图。新建的 `packages/integrations/` 组从此是这类适配器的家。base bundle 随部署携带两包，任何部署都能挂载；未选用该 preset 的 `standard` 会话不受影响。

## 备选方案

- **动态包** — 不能 POST；受认可的自扩展路径够不到这些 API。
- **共享 seam 服务（`ctx.wk`/`ctx.ps`）加独立工具消费者** — web seam 的存在是因为搜索 provider 有竞争；每个本机服务恰有一个后端，seam 只是仪式。
- **导入服务的客户端 SDK** — 两个包都私有于各自仓库；HTTP 信封客户端让 DSH 保持解耦。

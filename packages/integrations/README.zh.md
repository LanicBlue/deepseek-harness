---
description: "integrations 组地图：把外部编排器语义接到 DSH 会话上的桥接包，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# packages/integrations

[English](README.md) | 中文

## 概述

integrations 组收容 DSH 与外部编排系统之间的桥接包。桥接包原样消费外部系统自己的 CLI 契约，把部署侧配置翻译成 DSH 组合，并把系统事件路由进普通 DSH 会话——没有私有会话类型，也没有平行状态。当前组内有 InfiniteMission 桥：标了 `im: true` 的 agent preset 会在配置的 IM 工作区里成为 `dsh-<preset>` 成员，mission 到达则为每个（工作区， preset）对开一个可见会话并持续复用。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发注记](#dev-note)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`dsh-im-bridge`](dsh-im-bridge/README.zh.md) | InfiniteMission 桥：preset 门控成员、桥接方持有的 `im receive` 循环、到达事件路由进可复用会话 | 提供 `ctx.imBridge` |

-----

<a id="related-documentation"></a>
## 相关文档

- [生成配置目录](../../docs/config-catalog.zh.md#deepseek-aidsh-im-bridge) —— 桥接受的配置字段。
- [InfiniteMission 桥 Agent Note](../../.agents/notes/implemented/feature/2026-09-03-dsh-im-bridge.zh.md) —— 路由表、成员生命周期与 spawn 配方的设计定案。

-----

<a id="dev-note"></a>
## 开发注记

桥接包是两重消费者：一重消费外部系统的 CLI 契约（钉在已验证版本，全部输出格式集中在单一模块解析），一重消费 DSH 的常规扩展点（agent 注册表、preset 名册、settings 命名空间）。外部系统无法通过其公开表面表达的东西，记为文档化的空缺，而不是分叉它的语义。

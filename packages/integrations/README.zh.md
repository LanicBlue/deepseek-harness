---
description: "integrations 组地图：外部本机服务（Wiki Server 与 Project Service）的只读模型工具，供浏览本组的用户与维护者阅读。"
kind: "package-group"
---

# integrations/ — 本机服务工具家族

[English](README.md) | 中文

## 概述

integrations 组持有面向模型、只读的外部本机服务适配器：每个包零源码引用地讲一个服务的版本化 HTTP 信封，逐调用解析端点与凭据，并把一切失败映射为点名恢复步骤的教学错误。本组之所以存在，是因为这类适配器既不是 web 搜索 provider（没有相互竞争的后端），也不是 harness 服务（没有进程内 seam）；它们是自有状态之服务的投影。当前覆盖 Wiki Server（`tool-wk`：wiki 搜索、节点读取、已索引项目树源码）与 Project Service（`tool-ps`：项目、missions、attention 收件箱）。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)

-----

<a id="packages"></a>
## 包

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-wk`](tool-wk/README.zh.md) | 作用于本机 Wiki Server contract API 的五个只读工具 | 注册到 `ctx.tools` |
| [`tool-ps`](tool-ps/README.zh.md) | 作用于本机 Project Service REST API 的四个只读工具 | 注册到 `ctx.tools` |

-----

<a id="related-documentation"></a>
## 相关文档

- [工具 schema 目录](../../docs/tool-catalog.zh.md)——模型收到的生成 schema。
- [新增一个包](../../docs/cookbook/adding-a-package.zh.md)——这里每个新包都遵循的清单。

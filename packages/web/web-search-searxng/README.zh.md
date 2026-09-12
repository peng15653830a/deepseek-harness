---
description: "ctx.web 的 SearXNG 搜索提供方：在自托管或本地 SearXNG 实例上进行引擎聚合的 web 搜索，无需 API 密钥。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

[English](README.md) | 中文

## 概述

`dsh-web-search-searxng` 让 harness 通过 SearXNG 实例的 JSON API 搜索 web，把引擎聚合结果映射为 `WebSearchSource` 条目——URL、标题、snippet、发布日期——并把任何非空即时答案并入结果 `content`。SearXNG 无需 API 密钥，因此提供方的可用性是一次 base-URL 检查，默认端点为回环地址（`http://127.0.0.1:8888`）。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8888` | SearXNG 实例地址；附加 `/search`。无法解析的值会使提供方不可用 |

## 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置 schema、提供方注册 |
| [`src/provider.ts`](src/provider.ts) | `SearxngSearchProvider`：请求分发、中止分类、结果映射 |
| [`src/types.ts`](src/types.ts) | SearXNG 协议类型：`SearxngSearchResponse`、`SearxngResult`、`SearxngError` |
| — | 不发布运行时不变量配套入口；除所属 seam 强制执行的约定外，本包没有独立的事件序列或可变数据关系。 |

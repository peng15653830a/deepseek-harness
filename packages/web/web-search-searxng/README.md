---
description: "The SearXNG-backed search provider for ctx.web: engine-aggregated web search on a self-hosted or local SearXNG instance, with no API key."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-searxng

English | [中文](README.zh.md)

## Summary

With `dsh-web-search-searxng`, the harness searches the web through a SearXNG instance's JSON API and gets engine-aggregated results as `WebSearchSource` entries — URL, title, snippet, publication date — with any non-blank instant answers joined into the result `content`. SearXNG needs no API key, so the provider's availability is a base-URL check and the default endpoint is loopback (`http://127.0.0.1:8888`). The model-facing `web_search` tool lives in `dsh-tool-web`.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `baseURL` | `http://127.0.0.1:8888` | SearXNG instance base; `/search` is appended. An unparseable value makes the provider unavailable |

## Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, provider registration |
| [`src/provider.ts`](src/provider.ts) | The `SearxngSearchProvider`: request dispatch, abort classification, result mapping |
| [`src/types.ts`](src/types.ts) | SearXNG wire types: `SearxngSearchResponse`, `SearxngResult`, `SearxngError` |
| — | No runtime invariant companion is published; this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seam. |

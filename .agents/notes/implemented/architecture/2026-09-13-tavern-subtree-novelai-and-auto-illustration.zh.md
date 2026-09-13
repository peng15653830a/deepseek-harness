# Agent Note: Tavern 子树、NovelAI 渠道与自动配图批次

Status: implemented

[English](2026-09-13-tavern-subtree-novelai-and-auto-illustration.md) | 中文

## 问题

本仓库是持续升级的 DeepSeek Harness（DSH）源码，而酒馆体验（人物卡角色扮演与场景配图）是另一个项目，需要跑在它里面。有两个需求靠配置解决不了：场景配图必须来自一个讲官方 `/ai/generate-image` 协议的第三方 NovelAI 中转；一个游玩回合要自己产出多张插图，而不是点一次出一张。两者都必须扛住 DSH 后续升级而不重写，因为只有 DSH 本体在持续变动，酒馆上游不会再重新移植。

## 决策

酒馆以子树形式落在 `packages/tavern/`：`tavern-plugin/` 是运行时宿主，纯 JavaScript（`lib/**` 加组装产物 `lib/client.js`）；`image-gen/` 是生图插件源码，宿主在进程内调用它的 `src/tavern/` 渠道层；`presets/` 存放预设组合。该子树属于根 pnpm 工作区与 Host/Client TypeScript 工程面；lefthook 与第三方声明生成器把它排除在外，因为它是引入的源码，不是 harness 源码。

`dsh-image-gen` 增加 NovelAI 供应商。`image-gen/src/novelai.ts` 提交官方 V4.x 请求体（`params_version: 3`、`v4_prompt`/`v4_negative_prompt` 字幕、64 像素网格尺寸），并按中央目录解开 ZIP 响应，因此把尺寸推迟到尾部描述符的归档也能读。队列已满与限流（`503`、`429`）在一个 `novelaiTimeoutMs` 截止时间内按固定等待重试两次；其余状态只失败一次，且供应方响应正文永不进入错误信息。供应商只通过既有接缝注册：`IMAGE_PROVIDERS`、`Config` 字段、`resolveProvider`、工具分支、Studio 档案与设置卡片。`edit_image` 拒绝 NovelAI，因为该中转拒绝 `action: img2img`。

酒馆运行时新增自动配图批次。`scene-images/settings.json` 增加 Tavern 拥有的 `auto` 策略（`enabled`、`minPerTurn`、`charsPerImage`、`maxPerTurn`）；渠道配置与凭据仍归模块所有。结算提交后，`lib/index.js` 调用 `sceneIllustrations.autoRun(sessionId, turn)`；批次只服务最新且已结算的轮次，张数按 `clamp(ceil(正文投影字数 / charsPerImage), minPerTurn, maxPerTurn)` 计算，只补差额，并把批次与图片请求串行化。每一张在带 shot 限定的方案键（`profile#shotN`）下规划自己的瞬间，同时标签块保持共享，因此后一张只提交真正变化的字段。每张只付一次：只有出图前就被拒绝的应答（NovelAI 渠道的 `503`/`429`）获得一次自动重试，其它失败沿用"结果未确认、不再自动重发"的规则并停止批次。客户端把同一轮的所有版本渲染成竖排条带，重画、调整与参考图仍作用于选中的那一张。

## 考虑过的替代方案

**独立插件或独立补丁集。** 否决：自动批次要读取会话、历史快照、附件服务与凭据库，这些都是 harness 交给进程内插件的能力；"结算完成"目前没有公开事件，暴露它本身就是一处 harness 改动。

**把自动批次放在生图插件而不是酒馆宿主里。** 否决：插件知道的是供应商，不是轮次、结算或酒馆的会话文档，策略终究要跨过这条边界。

**把自动策略与渠道配置存到一起。** 否决：`scene-images/settings.json` 是 Tavern 的文档，`providers.json` 是模块的；保持这条归属切分，宿主升级时两边都能直接读，不需要迁移。

**对所有供应商失败都重试。** 否决：超时或未知 5xx 可能已经计费，只有可证明发生在出图之前的拒绝才允许重试。

## 后果

配置、凭据与已出图片都在酒馆数据目录，因此 DSH 或子树升级都会保留；只有在 harness 自身设置界面大改时才需要重新保存一次。改动是集中的而不是分散的：宿主三个 domain 文件、`lib/index.js` 六行、提示词一段、客户端两个文件加重建的 `lib/client.js`、供应商注册点，以及测试——重移植时是"重放"而不是"重新推导"。回归测试（`tests/scene-illustration.test.mjs`、`tests/scene-image-auto.test.mjs`、`image-gen/tests/novelai.spec.ts`）就是重放后的验收标准。已知代价是：自动批次按设计每轮会发起多张付费请求，边界由 `maxPerTurn` 与"只重试一次"的规则控制；以及让批次跑起来的挂钩位于移植子树内，整棵重新移植酒馆上游会让它们失效，直到被重放。

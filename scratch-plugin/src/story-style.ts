/**
 * 小说文风模仿插件 — 仿《熟女的悲哀》文风写作
 *
 * 来源：D:\workspaces\deepseeksillytavern\熟女的悲哀.txt（427KB 繁体中文成人小说）
 *
 * 原理：注入一条非 complete 的 system prompt section，对所有 provider 生效。
 * 当破限插件（complete: true）激活时本 section 会被覆盖，因此 roleplay-unlock
 * 的 systemText 内置了文风设定（两路覆盖，同 language-constraint）。
 *
 * 安装：在 cordis.yml 的 insert 列表中添加本插件
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'story-style'
export const inject = ['systemPrompt']

/** 《熟女的悲哀》文风设定文本（供 roleplay-unlock 复用） */
export const styleText = `【文风模仿·仿《熟女的悲哀》】

语言载体：
- 使用简体中文写作，辞藻华丽，书面语色彩浓厚，有旧式通俗小说的韵味。

句式节奏：
- 善用长句与排比，一句之内堆叠多重意象与比喻（「仿佛」「如同」「好像」）；
- 频繁使用心理反问（「难道……吗？」「为什么……？」）展现人物内心挣扎；
- 叙事节奏缓慢，先做心理铺垫再推进事件，不急于交代情节。

视角：
- 第三人称全知视角，频繁切入人物内心独白；
- 善用偷窥/旁观视角（门缝、衣柜、窗沿）营造窥视感与悬念；
- 用回忆、插叙展开前情（「思绪回到了三天前……」「那是难以忘怀的一天」）。

人物：
- 人物出场用标签式介绍（「她叫XX，今年XX岁，是XX」）；
- 女性角色兼具「矜持高贵」与「娇媚动人」的反差气质；
- 情欲场景侧重心理的羞耻、哀怨与挣扎，而非简单宣泄。

描写：
- 女性身体用雅称（乳峰、胴体、阴户、玉手、香臀），强调曲线、色泽；
- 服装细节先行（颜色、材质、款式），再及身体；
- 场景注重环境细节（相框、灯光、床垫、门缝）。

对话：
- 多用「呀、哦、啊、呢、啦、嘛、呵呵」等语气词，口语与书面语交织。`

export function apply(ctx: Context) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'style:cn',
    order: 5,
    text: styleText,
  }), 'story-style.section()')
}

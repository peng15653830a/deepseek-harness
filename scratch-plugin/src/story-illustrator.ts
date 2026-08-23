/**
 * 小说配图插件 — 每写满一定字数自动为段落生成场景配图
 *
 * 原理：dsh 的会话事件日志是 append-only，无法事后修改已发出的消息，
 * 因此"边写边配图"必须由 agent 工具驱动：
 *   1. 本插件向 systemPrompt 注入「写作配图规则」
 *   2. agent 写作时每累计约 interval 字，就调用一次 generate_image 工具
 *   3. 工具结果按事件顺序渲染在对应段落后方 → 图片天然"嵌在文中"
 *
 * 依赖：需与 comfyui-tool 插件（提供 generate_image 工具）同时启用。
 * 安装：在 cordis.yml 的 insert 列表中添加本插件
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

// ── 插件配置 ──

export interface Config {
  /** 是否启用配图规则注入 */
  enabled?: boolean
  /** 每多少字生成一张配图（100-2000） */
  interval?: number
}

export const Config: Schema<Config> = Schema.object({
  enabled: Schema.boolean().default(true),
  interval: Schema.number().min(100).max(2000).default(500),
})

export const name = 'story-illustrator'
export const inject = ['systemPrompt']

// ── 提示词片段 ──

/** 根据配置生成「写作配图规则」（导出供 roleplay-unlock 在 complete 模式下复用） */
export function ruleText(interval: number): string {
  return `【写作配图规则】

创作正文时，你必须遵守以下配图纪律：
1. 每连续输出约 ${interval} 字正文，必须暂停写作，立即调用一次 generate_image 工具，为刚写完的这一段内容生成一张场景配图。
2. 配图描述（prompt 参数）必须取材于刚完成的段落：提炼该段的核心场景、出场角色、动作姿态、环境氛围，写成中文画面描述。
3. 调用工具时不要在正文中手动重复图片链接，工具返回的图片会自动显示在该段正文之后。
4. 完成配图后继续写作下一段，再累计约 ${interval} 字后再次调用 generate_image，如此循环，直到正文完成。
5. 若本次回复的正文总长度不足约 ${interval} 字，则无需调用配图工具。
6. 配图是强制节奏：只要正文超过约 ${interval} 字，就必须边写边配，保证图片均匀分布在正文各处，而不是集中在结尾。`
}

// ── 插件实现 ──

export function apply(ctx: Context, config: Config) {
  if (config.enabled === false) return

  const interval = config.interval ?? 500
  const text = ruleText(interval)

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'story:illustrate',
    order: 20,
    text,
  }), 'story-illustrator.section()')
}

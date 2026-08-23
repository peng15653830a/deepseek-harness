/**
 * 纯中文输出约束插件 — 强制模型只输出纯中文，不混入英文
 *
 * 原理：注入一条非 complete 的 system prompt section，在破限插件被跳过时生效。
 * 当破限插件（complete: true）激活时，本插件 section 会被覆盖，因此破限插件
 * 的 systemText 内置了中文约束（两路覆盖）。
 *
 * 安装：在 cordis.yml 的 insert 列表中添加本插件
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'language-constraint'
export const inject = ['systemPrompt']

export function apply(ctx: Context) {
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'lang:cn',
    order: 5,
    text: '语言约束：你只输出纯中文。正文中绝不混入任何英文单词、英文句子或中英混合表达。即使思考过程中出现英文，最终输出也必须全部使用中文。',
  }), 'language-constraint.section()')
}
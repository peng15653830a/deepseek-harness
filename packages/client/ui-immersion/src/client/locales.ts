/** `immersion` namespace dictionaries (view tab label). */

/** Dictionary namespace owned by this plugin. */
export const NS = 'immersion'

/** The immersion dictionary key set. */
export type ImmersionKey =
  | 'view.immersion'
  | 'showToolCalls'
  | 'hideToolCalls'
  | 'noConversation'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'immersion': ImmersionKey
  }
}

/** Simplified Chinese dictionary. */
export const zh: Record<ImmersionKey, string> = {
  'view.immersion': '沉浸',
  'showToolCalls': '显示工具调用',
  'hideToolCalls': '隐藏工具调用',
  'noConversation': '暂无对话内容',
}

/** English dictionary. */
export const en: Record<ImmersionKey, string> = {
  'view.immersion': 'Immersion',
  'showToolCalls': 'Show tool calls',
  'hideToolCalls': 'Hide tool calls',
  'noConversation': 'No conversation yet',
}

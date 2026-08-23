/**
 * Immersion plugin, browser half: contributes the Immersion ebook-style view
 * tab to the conversation view ring.
 *
 * Users can switch between the default "Chat" and "Immersion" view tabs
 * to read the conversation as an ebook/novel flow.
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { EbookView } from './EbookView.tsx'
import { en, NS, zh } from './locales.ts'

/** Required services: slot system, session management, locale service. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the immersion view tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-immersion: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'immersion',
    order: 20,
    locale: NS,
    label: () => t('view.immersion'),
  }, EbookView))
}

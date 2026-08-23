/**
 * EbookView — immersive reading experience for text + image conversations.
 *
 * Renders the conversation as an ebook/novel-style flow:
 * - User messages as right-aligned "thoughts"
 * - Assistant messages as story narrative (left-aligned prose)
 * - Images inline with the text
 * - Tool calls hidden by default (collapsible overlay)
 * - Reasoning blocks collapsed by default
 */

import { memo, useMemo, useState } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  AssistantBlock,
  ConversationSnapshot,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ImmersionKey } from './locales.ts'
import css from './views.module.css'

type EbookViewProps = ConvViewProps & PropsLocale<'immersion'>

/**
 * Resolve the image URL from an ImageAttachmentRef.
 * Uses `attachment.url` if available; otherwise returns `undefined` so the caller
 * can use the `session-authorized` loadImage loader instead.
 */
function imageUrl(attachment: ImageAttachmentRef): string | undefined {
  if ('url' in attachment && typeof attachment.url === 'string') return attachment.url
  return undefined
}

// ── Sub-components ──

/** Render an inline image from an attachment reference. */
const InlineImage = memo(function InlineImage({ attachment }: {
  attachment: ImageAttachmentRef
}) {
  const url = imageUrl(attachment)
  if (!url) return null
  return (
    <div className={css.imageRow}>
      <img
        src={url}
        loading="lazy"
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = 'none'
        }}
      />
    </div>
  )
})

/** Render assistant text blocks and reasoning. */
const AssistantBody = memo(function AssistantBody({
  blocks, t,
}: {
  t: EbookViewProps['t']
  blocks: readonly AssistantBlock[]
}) {
  const [showReasoning, setShowReasoning] = useState(false)
  const [showTools, setShowTools] = useState(false)

  const textBlocks = useMemo(() =>
    blocks.filter(b => b.kind === 'text'),
  [blocks])

  const reasoningBlocks = useMemo(() =>
    blocks.filter(b => b.kind === 'reasoning'),
  [blocks])

  const imageBlocks = useMemo(() =>
    blocks.filter(b => b.kind === 'image'),
  [blocks])

  const toolBlocks = useMemo(() =>
    blocks.filter(b => b.kind === 'tool-call'),
  [blocks])

  const hasTools = toolBlocks.length > 0

  return (
    <>
      {/* Text narrative with Markdown rendering */}
      {textBlocks.map((block, i) => (
        <MarkdownText key={i} text={block.text} />
      ))}

      {/* Images inline */}
      {imageBlocks.map((block, i) => (
        <InlineImage key={`img-${i}`} attachment={block.attachment} />
      ))}

      {/* Reasoning toggle */}
      {reasoningBlocks.length > 0 && (
        <>
          <button
            className={css.reasoningToggle}
            onClick={() => setShowReasoning(v => !v)}
            type="button"
          >
            {showReasoning ? '−' : '+'} {t('showToolCalls' as ImmersionKey)}
          </button>
          {showReasoning && reasoningBlocks.map((block, i) => (
            <div key={`reason-${i}`} className={css.reasoningContent}>
              <MarkdownText text={block.text} />
            </div>
          ))}
        </>
      )}

      {/* Tool calls toggle */}
      {hasTools && (
        <div className={css.toolBar}>
          <button
            className={css.toolToggle}
            onClick={() => setShowTools(v => !v)}
            type="button"
          >
            {showTools ? t('hideToolCalls') : t('showToolCalls')}
          </button>
        </div>
      )}
      {showTools && hasTools && (
        <div className={css.toolCallsArea}>
          {toolBlocks.map((block, i) => (
            <div key={`tool-${i}`} className={css.toolCallItem}>
              <div className={css.toolCallHeader}>
                {block.name}
              </div>
              <div className={css.toolCallArgs}>
                {block.argsRaw}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
})

/** User message bubble. */
const UserBubble = memo(function UserBubble({
  content,
}: {
  content: readonly { type?: string; text?: string; attachment?: ImageAttachmentRef }[]
}) {
  // Separate text and image blocks
  const texts: string[] = []
  const images: { attachment: ImageAttachmentRef }[] = []

  for (const block of content) {
    if (block.type === 'text' && block.text) texts.push(block.text)
    else if (block.type === 'image' && block.attachment) {
      images.push({ attachment: block.attachment as ImageAttachmentRef })
    }
  }

  if (texts.length === 0 && images.length === 0) return null

  return (
    <div className={css.userBlock}>
      <div className={css.body}>
        {images.map((img, i) => (
          <InlineImage key={`uimg-${i}`} attachment={img.attachment} />
        ))}
        {texts.map((text, i) => (
          <MarkdownText key={`utxt-${i}`} text={text} />
        ))}
      </div>
    </div>
  )
})

// ── Main View ──

/**
 * EbookView — the immersion reading tab.
 * Renders user → assistant → tool → image as an ebook flow.
 */
export const EbookView = memo(function EbookView(props: EbookViewProps) {
  const { useSession, t } = props

  // Subscribe to the conversation snapshot
  const snapshot = useSession((s: ConversationSnapshot) => s)
  const { chat, nodes, running } = snapshot

  // Build ordered list of visible content nodes
  const contents = useMemo(() => {
    const items: Array<{
      key: string
      kind: string
      content?: readonly { type?: string; text?: string; attachment?: ImageAttachmentRef }[]
      blocks?: readonly AssistantBlock[]
      turn?: number
    }> = []

    // Use the chat snapshot order for ChatConversationViewNodes
    const seenKeys = new Set<string>()

    for (const key of chat.order) {
      const node = chat.nodes.get(key)
      if (!node) continue
      seenKeys.add(key)

      switch (node.kind) {
        case 'user': {
          const n = node as { kind: 'user'; data: { content: readonly { type?: string; text?: string; attachment?: ImageAttachmentRef }[] } }
          items.push({ key, kind: 'user', content: n.data.content })
          break
        }
        case 'assistant-step': {
          const n = node as { kind: 'assistant-step'; data: { status: string; blocks: readonly AssistantBlock[]; turn: number } }
          items.push({ key, kind: 'assistant', blocks: n.data.blocks, turn: n.data.turn })
          break
        }
        case 'tool-call': {
          // Include tool results that carry images: real image blocks or
          // markdown image syntax inside text blocks (e.g. ComfyUI tool output)
          const n = node as { kind: 'tool-call'; data: { root: { kind?: string; content?: readonly { type?: string; text?: string; attachment?: ImageAttachmentRef }[] } } }
          const root = n.data.root
          if (root.kind === 'tool-result' && root.content) {
            const hasImage = root.content.some((c: { type?: string; text?: string }) =>
              c.type === 'image'
              || (c.type === 'text' && typeof c.text === 'string' && /!\[.*\]\(.*\)/.test(c.text)),
            )
            if (hasImage) {
              items.push({ key, kind: 'tool-image', content: root.content })
            }
          }
          break
        }
        default:
          break
      }
    }

    return items
  }, [chat, nodes])

  // Separate into turns for separator display
  const turns = useMemo(() => {
    const result: typeof contents[] = []
    let currentTurn: typeof contents = []
    let lastTurn: number | undefined

    for (const item of contents) {
      const turn = 'turn' in item ? (item as { turn?: number }).turn : undefined
      if (turn !== undefined && lastTurn !== undefined && turn !== lastTurn) {
        if (currentTurn.length > 0) {
          result.push(currentTurn)
          currentTurn = []
        }
      }
      currentTurn.push(item)
      lastTurn = turn ?? lastTurn
    }
    if (currentTurn.length > 0) result.push(currentTurn)
    return result
  }, [contents])

  if (turns.length === 0 && !running) {
    return (
      <div className={css.view}>
        <div className={css.empty}>
          <div className={css.emptyIcon}>&#128214;</div>
          <span>{t('noConversation')}</span>
        </div>
      </div>
    )
  }

  return (
    <div className={css.view}>
      {/* Turn groups */}
      {turns.map((group, gi) => (
        <div key={`turn-${gi}`}>
          {gi > 0 && <div className={css.turnSeparator}>✦ ✦ ✦</div>}

          {group.map((item) => {
            switch (item.kind) {
              case 'user':
                return (
                  <div key={item.key} className={css.message}>
                    <UserBubble content={item.content ?? []} />
                  </div>
                )
              case 'assistant':
                return (
                  <div key={item.key} className={`${css.message} ${css.assistantBlock}`}>
                    <div className={css.body}>
                      <AssistantBody blocks={item.blocks ?? []} t={t} />
                    </div>
                  </div>
                )
              case 'tool-image':
                return (
                  <div key={item.key} className={css.message}>
                    {item.content?.map((block, i) => {
                      if (block.type === 'image' && block.attachment) {
                        return (
                          <div key={`timg-${i}`} className={css.toolImage}>
                            <InlineImage attachment={block.attachment as ImageAttachmentRef} />
                          </div>
                        )
                      }
                      if (block.type === 'text' && block.text) {
                        return (
                          <div key={`ttxt-${i}`} className={css.toolImage}>
                            <MarkdownText text={block.text} />
                          </div>
                        )
                      }
                      return null
                    })}
                  </div>
                )
              default:
                return null
            }
          })}
        </div>
      ))}

      {/* Running indicator for in-progress assistant */}
      {running && (
        <div className={css.runningIndicator}>
          <span className={css.dot} />
          思考中...
        </div>
      )}
    </div>
  )
})

/** Image attachment resolution for DSH runtime blocks. */
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'

/**
 * Extract the verified durable image attachment from a completed tool result block.
 * Reads the block's own `content`; the legacy rc.2 `resultView` payload no longer exists.
 */
export function imageRef(block: ToolCallBlock): ImageAttachmentRef | undefined {
  if (!('kind' in block)) return undefined
  const fromBlockContent = Array.isArray(block.content)
    ? block.content.find(item => item.type === 'image')
    : undefined
  if (fromBlockContent?.type === 'image') return fromBlockContent.attachment

  return undefined
}

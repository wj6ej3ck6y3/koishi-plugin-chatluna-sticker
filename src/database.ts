import { Context } from 'koishi'

declare module 'koishi' {
  interface Tables {
    sticker_occurrence: StickerOccurrence
    sticker_meta: StickerMeta
  }
}

export interface StickerOccurrence {
  pHash: string
  count: number
  status: string
  firstSeenAt: number
  lastSeenAt: number
  judgeError: string
}

export interface StickerMeta {
  pHash: string
  tags: string[]
  description: string
  usageHint: string
  useCount: number
  lastUsedAt: number
  collectedAt: number
}

export const name = 'auto-sticker-database'

export function apply(ctx: Context) {
  ctx.model.extend('sticker_occurrence', {
    pHash: 'string',
    count: 'unsigned',
    status: 'string',
    firstSeenAt: 'unsigned',
    lastSeenAt: 'unsigned',
    judgeError: 'string',
  }, { primary: 'pHash' })

  ctx.model.extend('sticker_meta', {
    pHash: 'string',
    tags: 'list',
    description: 'string',
    usageHint: 'string',
    useCount: 'unsigned',
    lastUsedAt: 'unsigned',
    collectedAt: 'unsigned',
  }, { primary: 'pHash' })
}
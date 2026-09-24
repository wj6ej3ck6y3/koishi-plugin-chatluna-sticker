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
  judgeStartedAt: number   // 新增：进入 judging 的时间戳
  judgeToken: string       // 新增：占用令牌，防止误重置/误覆盖
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
    judgeStartedAt: 'unsigned',   // 新增
    judgeToken: 'string',         // 新增
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
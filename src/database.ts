import { Context } from 'koishi'

declare module 'koishi' {
  interface Tables {
    sticker_occurrence: StickerOccurrence
    sticker_meta: StickerMeta
    sticker_vdb_snapshot: StickerVdbSnapshot
  }
}

export interface StickerOccurrence {
  pHash: string
  count: number
  status: string
  firstSeenAt: number
  lastSeenAt: number
  judgeError: string
  judgeStartedAt: number
  judgeToken: string
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

export interface StickerVdbSnapshot {
  id: string              // 固定 'main'
  data: string            // luna-vdb serialize() 后的字节，base64 编码
  embeddingModel: string  // 生成该快照时使用的 embeddingModel，用于换模型自动失效
  updatedAt: number
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
    judgeStartedAt: 'unsigned',
    judgeToken: 'string',
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

  ctx.model.extend('sticker_vdb_snapshot', {
    id: 'string',
    data: 'text',
    embeddingModel: 'string',
    updatedAt: 'unsigned',
  }, { primary: 'id' })
}
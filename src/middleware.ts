import { Context } from 'koishi'
import { Config } from './config'
import { StickerLibrary } from './library'

export function apply(ctx: Context, config: Config, library: StickerLibrary) {
  ctx.middleware(async (session, next) => {
    if (!session.guildId) return next() // 只在群聊收集

    const images = (session.elements ?? []).filter(
      el => el.type === 'img' || el.type === 'image' || el.type === 'face'
    )
    if (!images.length) return next()

    for (const img of images) {
      const buf = await downloadElement(ctx, img)
      if (!buf) continue

      const pHash = await library.computePHash(buf)
      if (!pHash) continue

      const { canonicalHash, status, isNew } = await library.recordOccurrence(pHash)

      // 首次见到 / 转入待审时落盘
      if (isNew || status === 'pending_review') {
        await library.saveImage(canonicalHash, buf)
      }

      // 进入待审 → 触发模型判断（异步，不阻塞消息处理）
      // 由 handlePending 内部根据 pHash 读取文件
      if (status === 'pending_review') {
        library
          .handlePending(canonicalHash)
          .catch(e => ctx.logger.error('[sticker] handlePending 失败:', e))
      }
    }

    return next()
  })
}

async function downloadElement(ctx: Context, el: any): Promise<Buffer | null> {
  try {
    const url = el.attrs?.src || el.attrs?.url || el.attrs?.file
    if (!url) return null

    if (url.startsWith('base64://')) {
      return Buffer.from(url.slice('base64://'.length), 'base64')
    }
    if (url.startsWith('data:')) {
      const idx = url.indexOf(',')
      if (idx < 0) return null
      return Buffer.from(url.slice(idx + 1), 'base64')
    }
    if (url.startsWith('http://') || url.startsWith('https://')) {
      const res = await ctx.http.get(url, {
        responseType: 'arraybuffer',
        timeout: 15000,
      })
      const buf = Buffer.from(res)
      return buf.length > 5 * 1024 * 1024 ? null : buf
    }
    if (url.startsWith('file://')) {
      const fs = await import('fs/promises')
      return await fs.readFile(url.slice('file://'.length))
    }
    return null
  } catch (e) {
    ctx.logger.debug('[sticker] 下载图片失败:', e)
    return null
  }
}
import { Context, h } from 'koishi'
import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { Config } from './config'
import { StickerLibrary } from './library'

// 请求级 session 存储：Chatluna 工具调用时能拿到当前会话
const sessionStore = new Map<string, any>()

/**
 * 必须在 Chatluna 之前 prepend 绑定。
 * Chatluna 处理消息也走 middleware，这里最先捕获 session。
 * 延迟清理，避免 Chatluna 异步工具调用时 session 已被删除。
 */
export function bindSession(ctx: Context) {
  ctx.middleware(async (session, next) => {
    const id = `${session.platform}:${session.channelId}:${Date.now()}`
    sessionStore.set('current', session)
    sessionStore.set(id, session)
    try {
      return await next()
    } finally {
      setTimeout(() => {
        if (sessionStore.get('current') === session) {
          sessionStore.delete('current')
        }
        sessionStore.delete(id)
      }, 120000)
    }
  }, true)
}

export function apply(ctx: Context, config: Config, library: StickerLibrary) {
  ctx.chatluna.platform.registerTool('sticker_send', {
    description:
      '从本地表情库检索并发一张合适的表情包。' +
      '当你想用表情包回复、表达情绪、活跃气氛时调用。' +
      '参数 intent 描述你想表达的情绪或场景（如“嘲笑”“开心”“无语”“点赞”）。',
    selector: () => true,
    createTool: () => createStickerSendTool(library, config),
  })
}

/**
 * 用 tool() 工厂函数构造工具，避免 StructuredTool 的泛型递归。
 * 每次调用返回一个新实例，以便闭包捕获 library / config。
 */
function createStickerSendTool(library: StickerLibrary, _config: Config) {
  const toolFactory = tool as unknown as (
    fn: (input: { intent: string }) => Promise<string>,
    opts: {
      name: string
      description: string
      schema: unknown
    }
  ) => unknown

  return toolFactory(
    async (input: { intent: string }) => {
      const { intent } = input
      const session = sessionStore.get('current')
      if (!session) {
        return '无法获取当前会话，请用文字回复。'
      }

      // 检索候选
      const candidates = await library.listCollected(20)
      if (!candidates.length) {
        return '本地表情库为空，请用文字回复。'
      }

      // 关键词打分：tags / description / usageHint
      const lowerIntent = intent.toLowerCase()
      const scored = candidates
        .map(c => {
          const hay = [
            c.description || '',
            c.usageHint || '',
            ...(c.tags || []),
          ]
            .join(' ')
            .toLowerCase()
          let score = 0
          for (const kw of lowerIntent.split(/[\s,，、]+/)) {
            if (kw && hay.includes(kw)) score += 1
          }
          return { c, score: score * 100 + (c.useCount || 0) }
        })
        .sort((a, b) => b.score - a.score)

      const picked = scored[0].c

      // 读取图片字节
      const buf = await library.readImage(picked.pHash)
      if (!buf) {
        return '表情文件丢失，请用文字回复。'
      }

      await session.send(h.image(`base64://${buf.toString('base64')}`))
      await library.markUsed(picked.pHash)

      return `已发送表情：${picked.description || picked.pHash}`
    },
    {
      name: 'sticker_send',
      description: '从本地表情库检索并发一张合适的表情包',
      schema: z.object({
        intent: z
          .string()
          .describe('你想表达的情绪或场景，如“嘲笑”“开心”“无语”“点赞”'),
      }),
    }
  )
}
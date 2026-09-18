import { Context, h } from 'koishi'
import type { Session } from 'koishi'
import { tool } from '@langchain/core/tools'
import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'
import { Config } from './config'
import { StickerLibrary } from './library'

export function apply(ctx: Context, config: Config, library: StickerLibrary) {
  ctx.chatluna.platform.registerTool('sticker_send', {
    description:
      '从本地表情库检索并发一张合适的表情包。' +
      '当你想用表情包回复、表达情绪、活跃气氛时调用。' +
      '参数 intent 描述你想表达的情绪或场景（如“嘲笑”“开心”“无语”“点赞”）。',
    selector: () => true,
    // Chatluna 会为每次工具调用注入当次会话上下文
    createTool: () => createStickerSendTool(library, config),
  })
}

/**
 * 用 tool() 工厂函数构造工具，避免 StructuredTool 的泛型递归。
 * session 由 Chatluna 在每次调用时注入，闭包捕获即可，不需要全局存储。
 */
function createStickerSendTool(library: StickerLibrary, _config: Config) {
  const toolFactory = tool as unknown as (
    fn: (
      input: { intent: string },
      config?: RunnableConfig
    ) => Promise<string>,
    opts: {
      name: string
      description: string
      schema: unknown
    }
  ) => unknown

  return toolFactory(
    async (input: { intent: string }, runnableConfig?: RunnableConfig) => {
      const { intent } = input

      // Chatluna 在每次工具调用时，将当次会话注入 configurable.session
      const session: Session | undefined =
        (runnableConfig?.configurable as any)?.session
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

      await session.send(h.image(`data:image/png;base64,${buf.toString('base64')}`))
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
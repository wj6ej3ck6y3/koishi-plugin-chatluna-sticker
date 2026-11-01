import { Context, h } from 'koishi'
import type { Session } from 'koishi'
import { tool } from '@langchain/core/tools'
import type { RunnableConfig } from '@langchain/core/runnables'
import { z } from 'zod'
import { Config } from './config'
import { StickerLibrary } from './library'
import type { StickerMeta } from './database'

// StructuredTool 泛型递归较深，用统一 cast 避免类型推导爆炸
const toolFactory = tool as unknown as (
  fn: (input: any, config?: RunnableConfig) => Promise<string>,
  opts: { name: string; description: string; schema: unknown }
) => unknown

export function apply(ctx: Context, config: Config, library: StickerLibrary) {
  // 双步发送（sticker_search → sticker_send(pHash)）仅作为
  // 未启用余弦向量匹配时的「关键词回退」兜底；
  // 语义匹配启用时始终走单步直发：向量检索已确定最相关项，
  // 无需 LLM 再从 top-K 中二次挑选。
  const useTwoStep = config.preLLMSelection && !config.enableSemanticMatch

  if (config.preLLMSelection && config.enableSemanticMatch) {
    ctx.logger.info(
      '[sticker] 语义匹配已启用，忽略 preLLMSelection 配置，使用单步直发'
    )
  }

  if (useTwoStep) {
    registerSearchAndSend(ctx, config, library)
  } else {
    registerSingleStepSend(ctx, config, library)
  }
}

// ── 单步模式（默认） ─────────────────────────────────────

function registerSingleStepSend(
  ctx: Context,
  config: Config,
  library: StickerLibrary
) {
  ctx.chatluna.platform.registerTool('sticker_send', {
    description:
      '从本地表情库检索并发一张合适的表情包。' +
      '当你想用表情包回复、表达情绪、活跃气氛时调用。' +
      '参数 intent 请用简短关键词描述情绪或场景，' +
      '多个关键词之间用空格或逗号分隔（例如"开心 可爱"、"疑惑 问号"、"点赞 赞同"），' +
      '不要用连续整句或长词组，以便系统逐词检索更精准。',
    selector: () => true,
    createTool: () => createSingleStepSendTool(library, config),
  })
}

function createSingleStepSendTool(library: StickerLibrary, config: Config) {
  return toolFactory(
    async (input: { intent: string }, runnableConfig?: RunnableConfig) => {
      const session: Session | undefined =
        (runnableConfig?.configurable as any)?.session
      if (!session) return '无法获取当前会话，请用文字回复。'

      const candidates = await buildCandidates(
        library,
        config,
        String(input.intent || ''),
        1
      )
      if (!candidates.length) {
        return '本地表情库为空，请用文字回复。'
      }

      const picked = candidates[0]
      const buf = await library.readImage(picked.pHash)
      if (!buf) return '表情文件丢失，请用文字回复。'

      await session.send(h.image(`data:image/png;base64,${buf.toString('base64')}`))
      await library.markUsed(picked.pHash)

      return `已发送表情（${picked.source}）：${picked.description || picked.pHash}`
    },
    {
      name: 'sticker_send',
      description: '从本地表情库检索并发一张合适的表情包',
      schema: z.object({
        intent: z
          .string()
          .describe(
            '用简短关键词描述你想表达的情绪或场景，多个关键词之间用空格或逗号分隔，' +
            '例如"嘲笑"、"开心 可爱"、"疑惑 问号"、"点赞 赞同"。' +
            '请勿使用连续整句或长词组，以便系统逐个关键词检索。'
          ),
      }),
    }
  )
}

// ── 双工具模式（preLLMSelection = true） ─────────────────

function registerSearchAndSend(
  ctx: Context,
  config: Config,
  library: StickerLibrary
) {
  const topK = config.preLLMSelectionTopK ?? 5

  ctx.chatluna.platform.registerTool('sticker_search', {
    description:
      '从本地表情库检索 top-K 候选，只返回候选的 pHash / 描述 / 标签，不发送图片。' +
      '当你想用表情包回复时，先调用本工具查看候选，再从中挑一张调用 sticker_send(pHash)。' +
      '参数 intent 请用简短关键词描述情绪或场景，多个关键词之间用空格或逗号分隔（例如"开心 可爱"）。',
    selector: () => true,
    createTool: () => createSearchTool(library, config, topK),
  })

  ctx.chatluna.platform.registerTool('sticker_send', {
    description:
      '发送指定 pHash 的表情。pHash 必须来自上一次 sticker_search 的返回结果，' +
      '不要自己编造或凭记忆填写。如果尚未调用 sticker_search，请先调用它。',
    selector: () => true,
    createTool: () => createSendByHashTool(library),
  })
}

function createSearchTool(
  library: StickerLibrary,
  config: Config,
  topK: number
) {
  return toolFactory(
    async (input: { intent: string }, runnableConfig?: RunnableConfig) => {
      const session: Session | undefined =
        (runnableConfig?.configurable as any)?.session
      if (!session) return '无法获取当前会话，请用文字回复。'

      const candidates = await buildCandidates(
        library,
        config,
        String(input.intent || ''),
        topK
      )
      if (!candidates.length) {
        return '本地表情库为空，请用文字回复。'
      }

      const lines: string[] = [
        `候选项（共 ${candidates.length} 条，请用 sticker_send(pHash=...) 发送选定项）：`,
      ]
      candidates.forEach((c, i) => {
        const tags = c.tags.length ? c.tags.join('、') : '无'
        const desc = c.description || '(无描述)'
        lines.push(`${i + 1}. pHash=${c.pHash} | ${desc} | 标签: ${tags} | ${c.source}`)
      })
      lines.push('若均不合适，可直接用文字回复，不要编造 pHash。')
      return lines.join('\n')
    },
    {
      name: 'sticker_search',
      description: '从本地表情库检索候选（不发图）',
      schema: z.object({
        intent: z
          .string()
          .describe(
            '用简短关键词描述情绪或场景，多个关键词之间用空格或逗号分隔，' +
            '例如"开心 可爱"、"疑惑 问号"。'
          ),
      }),
    }
  )
}

function createSendByHashTool(library: StickerLibrary) {
  return toolFactory(
    async (input: { pHash: string }, runnableConfig?: RunnableConfig) => {
      const session: Session | undefined =
        (runnableConfig?.configurable as any)?.session
      if (!session) return '无法获取当前会话，请用文字回复。'

      const raw = String(input.pHash || '').trim().toLowerCase()
      if (!/^[0-9a-f]{16}$/.test(raw)) {
        return `pHash 格式无效："${input.pHash}"。请从 sticker_search 的返回结果中选择。`
      }

      const metas = await library.getMeta(raw)
      if (!metas.length) {
        return `未找到 pHash=${raw} 的表情，请先调用 sticker_search(intent) 获取有效的 pHash。`
      }

      const buf = await library.readImage(raw)
      if (!buf) return '表情文件丢失，请用文字回复。'

      await session.send(h.image(`data:image/png;base64,${buf.toString('base64')}`))
      await library.markUsed(raw)
      return `已发送：${metas[0].description || raw}`
    },
    {
      name: 'sticker_send',
      description: '发送指定 pHash 的表情（pHash 必须来自 sticker_search）',
      schema: z.object({
        pHash: z
          .string()
          .describe('sticker_search 返回结果中的 pHash，16 位十六进制字符串。'),
      }),
    }
  )
}

// ── 共享：候选打分 ──────────────────────────────────────

interface Candidate {
  pHash: string
  description: string
  tags: string[]
  score: number
  source: string // 用于日志 / 返回值中标注命中来源
}

/**
 * 对 intent 做分词。
 * - 按空白 / 常见中英文标点切分
 * - 若某片段仍是中文长词（长度 > 2），追加中文 2-gram 作为兜底，
 *   兼容模型偶发未按提示加空格、把关键词连成一个整串的情况。
 */
function tokenize(text: string): string[] {
  const out = new Set<string>()
  for (const seg of String(text || '').toLowerCase().split(/[\s,，、;；/|]+/)) {
    if (!seg) continue
    out.add(seg)
    if (/[\u4e00-\u9fa5]/.test(seg) && seg.length > 2) {
      for (let i = 0; i + 1 < seg.length; i++) {
        out.add(seg.slice(i, i + 2))
      }
    }
  }
  return Array.from(out)
}

/**
 * 关键词打分（不使用 useCount，避免马太效应）。
 * - 标签命中 intent 文本 → +5
 * - intent 命中某标签（tag 更长时） → +3
 * - intent 分词命中描述 / 使用提示 → +1 各
 */
function scoreCandidate(
  intentLower: string,
  intentTokens: string[],
  c: StickerMeta
): number {
  const tags = (c.tags || []).map(t => String(t).toLowerCase()).filter(Boolean)
  const desc = (c.description || '').toLowerCase()
  const hint = (c.usageHint || '').toLowerCase()

  let score = 0

  for (const tag of tags) {
    if (intentLower.includes(tag)) {
      score += 5
    } else if (intentLower.length >= 2 && tag.includes(intentLower)) {
      score += 3
    }
  }

  for (const tok of intentTokens) {
    if (!tok) continue
    if (desc.includes(tok)) score += 1
    if (hint.includes(tok)) score += 1
  }

  return score
}

/**
 * 统一候选构建：
 *   1) 语义匹配（若启用且有命中）
 *   2) 关键词回退（打分 + 平局随机）
 *
 * 返回值已按相关性排序并截取前 topK 条。
 */
async function buildCandidates(
  library: StickerLibrary,
  config: Config,
  intent: string,
  topK: number
): Promise<Candidate[]> {
  // 1) 语义匹配
  if (config.enableSemanticMatch) {
    const semantic = await library.searchBySemantic(
      intent,
      Math.max(topK, config.sendCandidatePoolSize),
      config.minSemanticSimilarity
    )
    if (semantic && semantic.length) {
      return semantic.slice(0, topK).map(s => ({
        pHash: s.meta.pHash,
        description: s.meta.description || '',
        tags: s.meta.tags || [],
        score: s.score,
        source: `语义 ${s.score.toFixed(3)}`,
      }))
    }
  }

  // 2) 关键词回退
  const candidates = await library.sampleCollected(config.sendCandidatePoolSize)
  if (!candidates.length) return []

  const intentLower = String(intent || '').toLowerCase()
  const intentTokens = tokenize(intent)

  return candidates
    .map(c => {
      const score = scoreCandidate(intentLower, intentTokens, c)
      return {
        pHash: c.pHash,
        description: c.description || '',
        tags: c.tags || [],
        score,
        source: score > 0 ? `关键词 ${score}` : '随机',
      }
    })
    // 仅按分数降序；同分项靠稳定排序保留 sampleCollected 的洗牌顺序 → 均匀随机
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
}
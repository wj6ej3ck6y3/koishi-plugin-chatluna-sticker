import { Schema } from 'koishi'

export interface Config {
  storageDir: string
  judgeThreshold: number
  judgeModel: string
  phashThreshold: number
  maxSendableImages: number
  occurrenceTtlDays: number
  judgeTimeoutMinutes: number
  sendCandidatePoolSize: number
  // 语义匹配（新增）
  enableSemanticMatch: boolean
  embeddingModel: string
  embeddingConcurrency: number
  minSemanticSimilarity: number
  debugDistanceProbe: boolean
}

export const Config: Schema<Config> = Schema.object({
  storageDir: Schema.string().default('data/sticker-library')
    .description('本地图片库目录，图片按 pHash 前两位分桶存储。'),

  judgeThreshold: Schema.number()
    .default(5)
    .min(1)
    .description('一张图全局出现次数达到此值后，提交给模型判断是否收藏。'),
  phashThreshold: Schema.number()
    .default(5)
    .min(1)
    .max(7)
    .description('pHash 汉明距离阈值：≤ 该值视为同一张图，64-bit 哈希拆成 8 段（每段 8 bit）分段索引。'),

  judgeModel: Schema.dynamic('model')
    .default('无')
    .description(
      '用于判断收藏的 Chatluna 模型，必须是多模态模型（支持图片输入）。' +
      '下拉列表来自当前已加载的 Chatluna 模型；' +
      '若模型不支持多模态，插件会记录错误日志并跳过对该图的重复尝试。'
    ),
  judgeTimeoutMinutes: Schema.number()
    .default(10)
    .min(1)
    .max(60)
    .description(
      '单次模型判断的超时时间（分钟）。' +
      '超过此时间仍停留在“判断中”状态的记录，会被视为进程崩溃残留，' +
      '在启动或定时扫描时自动重置并重新提交判断。' +
      '建议设置为大于模型最长响应时间，通常 10 分钟足够。'
    ),

  maxSendableImages: Schema.number()
    .default(1000)
    .min(1)
    .max(10000)
    .description('本地可发送图片（已收藏状态）的最大数量。超过后按最后使用时间淘汰最久未使用的。'),
  occurrenceTtlDays: Schema.number().default(10)
    .description('未收藏的追踪记录及其本地图片，超过此天数未再出现将被自动清理。'),
  // 语义匹配（新增）
  enableSemanticMatch: Schema.boolean()
    .default(false)
    .description(
      '是否启用 embedding 语义匹配。启用后 sticker_send 优先把 intent 编码为向量，' +
      '在 luna-vdb 索引中检索 top-K，取 top-1。' +
      '未启用 / 模型不可用 / 无命中时回退到关键词匹配。'
    ),
  embeddingModel: Schema.dynamic('embeddings')
    .default('无')
    .description(
      '用于生成向量的 Chatluna embedding 模型。' +
      '切换模型后旧向量维度不兼容，插件会依据 sticker_vdb_snapshot.embeddingModel ' +
      '自动判定并重建索引。'
    ),
  embeddingConcurrency: Schema.number()
    .default(3)
    .min(1)
    .description(
      '生成 embedding 时的最大并发数。'
    ),
  minSemanticSimilarity: Schema.number()
    .default(0.3).min(-1).max(1)
    .description(
      '余弦相似度最低阈值。低于此阈值的候选被丢弃；' +
      '全部低于阈值则视为无语义命中，回退关键词。' +
      '不同模型分布差异大，建议先用日志观察实际分数。'
    ),
  sendCandidatePoolSize: Schema.number()
    .default(100)
    .min(1)
    .max(1000)
    .description(
      '发送表情包时，从收藏库中随机抽取的候选池大小（上限）。' +
      '启用语义匹配时，该值同时作为向量检索返回的 top-K。'
    ),
  debugDistanceProbe: Schema.boolean()
    .default(false)
    .description(
      '启动时探测 luna-vdb 的距离语义并打印日志。' +
      '默认关闭。若 luna-vdb 升级后怀疑 score 计算异常，可临时开启对照日志排查。'
    ),
})
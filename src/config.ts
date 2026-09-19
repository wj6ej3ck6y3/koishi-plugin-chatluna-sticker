import { Schema } from 'koishi'
import { JUDGE_MODEL_SCHEMA_KEY } from './model-schema'

export interface Config {
  storageDir: string
  judgeThreshold: number
  judgeModel: string
  phashThreshold: number
  maxSendableImages: number
  occurrenceTtlDays: number
}

export const Config: Schema<Config> = Schema.object({
  storageDir: Schema.string().default('data/sticker-library')
    .description('本地图片库目录，图片按 pHash 前两位分桶存储。'),

  judgeThreshold: Schema.number().default(5)
    .description('一张图全局出现次数达到此值后，提交给模型判断是否收藏。'),

  judgeModel: Schema.dynamic(JUDGE_MODEL_SCHEMA_KEY)
    .default('deepseek/deepseek-v4-flash')
    .description(
      '用于判断收藏的 Chatluna 模型，必须是多模态模型（支持图片输入）。' +
      '下拉列表来自当前已加载的 Chatluna 模型；' +
      '若模型不支持多模态，插件会记录错误日志并跳过对该图的重复尝试。'
    ),

  phashThreshold: Schema.number().default(5)
    .description('pHash 汉明距离阈值：≤ 该值视为同一张图。64-bit 哈希拆成 8 段（每段 8 bit），' +
      '阈值 ≤ 7 时内存分段索引保证不漏检；超过 7 将回退全量遍历。'),

  maxSendableImages: Schema.number().default(10000)
    .description('本地可发送图片（已收藏状态）的最大数量。超过后按最后使用时间淘汰最久未使用的。'),

  occurrenceTtlDays: Schema.number().default(10)
    .description('未收藏（status 非 collected）的追踪记录及其本地图片，超过此天数未再出现将被自动清理。'),
})
import { Context, h } from 'koishi'
import { Config } from './config'
import { StickerLibrary } from './library'

export function apply(ctx: Context, config: Config, library: StickerLibrary) {
  const cmd = ctx.command('sticker', '表情包管理')

  cmd
    .subcommand('.list', '查看待审 / 已收藏列表')
    .option('pending', '-p 只看待审')
    .option('collected', '-c 只看已收藏')
    .option('failed', '-f 只看判断失败')
    .action(async ({ options }) => {
      if (options?.pending) {
        const rows = await ctx.database.get('sticker_occurrence', {
          status: 'pending_review',
        })
        if (!rows.length) return '没有待审图片'
        return (
          '待审图片：\n' +
          rows.map(r => `${r.pHash}  出现 ${r.count} 次`).join('\n')
        )
      }
      if (options?.collected) {
        const rows = await library.listCollected(50)
        if (!rows.length) return '本地库为空'
        return (
          '已收藏：\n' +
          rows
            .map(
              r =>
                `${r.pHash}  |  ${r.description || '无描述'}  |  用过 ${r.useCount || 0} 次`
            )
            .join('\n')
        )
      }
      if (options?.failed) {
        const rows = await ctx.database.get('sticker_occurrence', {
          status: 'judge_failed',
        })
        if (!rows.length) return '没有判断失败的图片'
        return (
          '判断失败：\n' +
          rows
            .map(r => `${r.pHash}  错误：${(r.judgeError || '未知').slice(0, 80)}`)
            .join('\n') +
          '\n\n可用 sticker.retry <pHash> 重试，或 sticker.retry-all 全部重试'
        )
      }
      return '请用 -p / -c / -f 指定查看类型'
    })

  cmd
    .subcommand('.show <pHash:string>', '查看指定 pHash 的图片')
    .action(async ({ session }, pHash) => {
      if (!session) return
      const buf = await library.readImage(pHash)
      if (!buf) return '图片不存在'
      await session.send(h.image(`data:image/png;base64,${buf.toString('base64')}`))
      return ''
    })

  cmd
    .subcommand('.send <pHash:string>', '手动发送指定表情')
    .action(async ({ session }, pHash) => {
      if (!session) return
      const buf = await library.readImage(pHash)
      if (!buf) return '图片不存在'
      await session.send(h.image(`data:image/png;base64,${buf.toString('base64')}`))
      await library.markUsed(pHash)
      return ''
    })

  cmd
    .subcommand('.retry <pHash:string>', '重试对指定图片的模型判断')
    .action(async ({ session }, pHash) => {
      if (!session) return
      const ok = await library.retryJudge(pHash)
      return ok ? `已重新判断 ${pHash}，请查看日志` : '图片不存在'
    })

  cmd
    .subcommand('.retry-all', '重试所有判断失败的图片')
    .action(async ({ session }) => {
      if (!session) return
      const count = await library.clearAllJudgeFailures()
      return `已清除 ${count} 条失败记录，将在图片再次出现时重新判断`
    })

  cmd.subcommand('.stat', '查看本地库统计').action(async () => {
    const all = await ctx.database.get('sticker_occurrence', {})
    const collected = all.filter(r => r.status === 'collected').length
    const pending = all.filter(r => r.status === 'pending_review').length
    const rejected = all.filter(r => r.status === 'rejected').length
    const evicted = all.filter(r => r.status === 'evicted').length
    const failed = all.filter(r => r.status === 'judge_failed').length
    return [
      `追踪中: ${all.length}`,
      `已收藏: ${collected}`,
      `待审: ${pending}`,
      `已拒绝: ${rejected}`,
      `已淘汰: ${evicted}`,
      `判断失败: ${failed}`,
      `可发送上限: ${config.maxSendableImages}`,
    ].join('\n')
  })
}
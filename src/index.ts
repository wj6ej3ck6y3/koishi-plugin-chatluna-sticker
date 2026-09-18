import 'koishi-plugin-chatluna'
import { Context } from 'koishi'
import { Config } from './config'
import * as database from './database'
import * as middleware from './middleware'
import * as tools from './tools'
import * as commands from './commands'
import { StickerLibrary } from './library'
import { registerJudgeModelSchema } from './model-schema'

export const name = 'auto-sticker'
export const inject = ['database', 'chatluna']
export { Config }

export function apply(ctx: Context, config: Config) {
  // 0. 注册动态模型列表（用于 judgeModel 的下拉菜单）
  registerJudgeModelSchema(ctx)

  // 1. 数据库模型
  ctx.plugin(database)

  // 2. 图片库实例（含内存 pHash 索引）
  const library = new StickerLibrary(ctx, config)

  // 4~6.
  middleware.apply(ctx, config, library)
  tools.apply(ctx, config, library)
  commands.apply(ctx, config, library)

  ctx.logger.info('[sticker] 自主表情包插件已启动')
}
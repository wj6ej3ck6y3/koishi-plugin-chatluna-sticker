import { Context, Schema } from 'koishi'

export const JUDGE_MODEL_SCHEMA_KEY = 'chatluna-sticker-model'

const FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'

/**
 * 注册 judgeModel 的动态 Schema（下拉菜单）。
 * 策略：
 *   1. 立即尝试一次
 *   2. ready 事件再试一次（此时 ChatLuna 各 platform 插件已 install）
 *   3. 每 3s 重试，最多 10 次，覆盖模型异步加载
 *   4. 始终拿不到 → 注册只含默认值的 union，保证字段能渲染
 */
export function registerJudgeModelSchema(ctx: Context) {
  const registered: string[] = []

  const register = async (): Promise<boolean> => {
    const names = await getChatlunaModelNames(ctx)
    if (!names.length) return false
    if (
      names.length === registered.length &&
      names.every((n, i) => n === registered[i])
    ) {
      return true
    }
    registered.length = 0
    registered.push(...names)
    ctx.schema.set(
      JUDGE_MODEL_SCHEMA_KEY,
      Schema.union(names.map(n => Schema.const(n).description(n)))
    )
    ctx.logger.info(`[sticker] judgeModel 下拉已注册，共 ${names.length} 个模型`)
    return true
  }

  const ensureFallback = () => {
    if (registered.length) return
    ctx.schema.set(
      JUDGE_MODEL_SCHEMA_KEY,
      Schema.union([Schema.const(FALLBACK_MODEL).description(FALLBACK_MODEL)])
    )
    ctx.logger.warn(
      `[sticker] 未能获取 Chatluna 模型列表，judgeModel 回退为 ${FALLBACK_MODEL}`
    )
  }

  register()
    .then(ok => { if (!ok) ensureFallback() })
    .catch(() => ensureFallback())

  ctx.on('ready', () => {
    register().catch(() => { })
  })

  let tries = 0
  const timer = ctx.setInterval(async () => {
    tries++
    const ok = await register().catch(() => false)
    if (ok || tries >= 10) {
      timer()
      if (!ok) ensureFallback()
    }
  }, 3000)
}

/**
 * 优先从 ChatLuna 的插件表里读 supportedModels；
 * 兜底通过 PlatformService.listPlatformModels 枚举。
 */
async function getChatlunaModelNames(ctx: Context): Promise<string[]> {
  const cl: any = (ctx as any).chatluna
  if (!cl) return []

  const names = new Set<string>()

  // 途径 1：ChatLunaService._plugins —— 每个 ChatLunaPlugin 都暴露 supportedModels
  const plugins = cl._plugins
  if (plugins && typeof plugins === 'object') {
    for (const key of Object.keys(plugins)) {
      const plugin = plugins[key]
      const models = plugin?.supportedModels
      if (Array.isArray(models)) {
        for (const m of models) {
          if (typeof m === 'string' && m) names.add(m)
        }
      }
    }
  }

  // 途径 2：PlatformService.listPlatformModels（只有拿到平台名才走这里）
  if (!names.size && cl.platform) {
    const platform = cl.platform
    const platformNames = new Set<string>()
    for (const key of ['_clients', 'clients', '_providers']) {
      const store = platform[key]
      if (store instanceof Map) {
        for (const k of store.keys()) platformNames.add(String(k))
      } else if (store && typeof store === 'object') {
        for (const k of Object.keys(store)) platformNames.add(k)
      }
    }
    for (const name of platformNames) {
      try {
        // ModelType.llm 在 ChatLuna 里就是字符串 'llm'
        const ref = platform.listPlatformModels(name, 'llm')
        const list = ref?.value ?? []
        for (const m of list) {
          const mn = typeof m === 'string' ? m : (m?.name ?? m?.model)
          if (mn) names.add(`${name}/${mn}`)
        }
      } catch {
        // 单个平台解析失败不影响其它平台
      }
    }
  }

  return Array.from(names).sort()
}
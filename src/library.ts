import { Context, h } from 'koishi'
import * as fs from 'fs/promises'
import * as path from 'path'
import imghash from 'imghash'
import { Config } from './config'
import { StickerOccurrence } from './database'   // 新增

const HASH_BITS = 8           // imghash 网格边长 → 8×8 = 64 bit
const HASH_LENGTH = 16        // 64-bit = 16 个十六进制字符

export interface OccurrenceResult {
  canonicalHash: string
  count: number
  status: string
  isNew: boolean
}

// 简易信号量，限制并发数
class Semaphore {
  private tasks: (() => void)[] = []
  private count: number
  constructor(count: number) { this.count = count }
  async acquire() {
    if (this.count > 0) { this.count--; return }
    await new Promise<void>(resolve => this.tasks.push(resolve))
  }
  release() {
    this.count++
    if (this.tasks.length > 0) {
      this.count--
      const next = this.tasks.shift()
      next?.()
    }
  }
}

export class StickerLibrary {
  private judgeModelRef: any = null
  private judgeSemaphore = new Semaphore(3) // 最多同时判断 3 张图
  private judging = new Set<string>()   // 保留：单进程快速短路

  constructor(private ctx: Context, private config: Config) {
    ctx.on('ready', async () => {
      try {
        this.judgeModelRef = await ctx.chatluna.createChatModel(config.judgeModel)
        ctx.logger.info(`[sticker] 判断模型已就绪: ${config.judgeModel}`)
      } catch (e) {
        ctx.logger.error(
          `[sticker] 无法创建 Chatluna 模型引用（${config.judgeModel}）：` +
          `${(e as Error)?.message ?? e}。请确认 judgeModel 配置正确、模型已加载。`
        )
      }
      // 崩溃恢复：启动时立即执行一次
      this.recoverStuckJudges().catch(e =>
        ctx.logger.error('[sticker] 恢复超时判断失败:', e)
      )
      // 启动时清理一次，之后每小时清理
      this.pruneStaleOccurrences().catch(e =>
        ctx.logger.error('[sticker] occurrence 清理失败:', e)
      )
      ctx.setInterval(() => {
        this.recoverStuckJudges().catch(e =>
          ctx.logger.error('[sticker] 恢复超时判断失败:', e)
        )
        this.pruneStaleOccurrences().catch(e =>
          ctx.logger.error('[sticker] occurrence 清理失败:', e)
        )
      }, 60 * 60 * 1000)
    })
  }

  // ── pHash 计算 ────────────────────────────────────────
  async computePHash(buf: Buffer): Promise<string | null> {
    try {
      const hash = await imghash.hash(buf, HASH_BITS)
      if (typeof hash !== 'string' || hash.length !== HASH_LENGTH) {
        this.ctx.logger.warn(
          `[sticker] imghash 返回非法哈希 (length=${hash?.length}): ${hash}`
        )
        return null
      }
      return hash.toLowerCase()
    } catch (e) {
      this.ctx.logger.warn('[sticker] pHash 计算失败:', e)
      return null
    }
  }

  private hammingDistance(a: string, b: string): number {
    const len = Math.min(a.length, b.length)
    let dist = 0
    for (let i = 0; i < len; i++) {
      let xor = parseInt(a[i], 16) ^ parseInt(b[i], 16)
      while (xor) {
        dist += xor & 1
        xor >>= 1
      }
    }
    dist += Math.abs(a.length - b.length) * 4
    return dist
  }

  // ── 记录出现（全局统计） ──────────────────────────────
  async recordOccurrence(pHash: string): Promise<OccurrenceResult> {
    const threshold = this.config.phashThreshold

    // 【优化】先精确匹配，绝大多数情况会命中这里，避免全表拉取
    let matched = (await this.ctx.database.get('sticker_occurrence', { pHash }))[0]

    // 【优化】如果没有精确匹配，再尝试相似匹配。
    // 注意：如果表数据量极大（>5万），这里的全量拉取依然有风险，建议引入专门的哈希索引库。
    if (!matched) {
      const all = await this.ctx.database.get('sticker_occurrence', {})
      for (const row of all) {
        if (this.hammingDistance(pHash, row.pHash) <= threshold) {
          matched = row
          break
        }
      }
    }

    if (matched) {
      const canonicalHash = matched.pHash
      const newCount = matched.count + 1
      let newStatus = matched.status
      if (newCount >= this.config.judgeThreshold && matched.status === 'new') {
        newStatus = 'pending_review'
      }
      await this.ctx.database.set(
        'sticker_occurrence',
        { pHash: canonicalHash },
        { count: newCount, lastSeenAt: Date.now(), status: newStatus }
      )
      return { canonicalHash, count: newCount, status: newStatus, isNew: false }
    }

    await this.ctx.database.create('sticker_occurrence', {
      pHash,
      count: 1,
      status: 'new',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      judgeError: '',
    })
    return { canonicalHash: pHash, count: 1, status: 'new', isNew: true }
  }

  // ── 图片文件存取 ──────────────────────────────────────
  filePath(pHash: string) {
    return path.join(this.config.storageDir, pHash.slice(0, 2), pHash + '.png')
  }

  async saveImage(pHash: string, buf: Buffer) {
    const fp = this.filePath(pHash)
    try {
      await fs.access(fp)
      return
    } catch { }
    await fs.mkdir(path.dirname(fp), { recursive: true })
    await fs.writeFile(fp, buf)
  }

  async readImage(pHash: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(this.filePath(pHash))
    } catch {
      return null
    }
  }

  /** 删除本地图片文件（忽略不存在等错误） */
  private async removeImageFile(pHash: string) {
    try {
      await fs.unlink(this.filePath(pHash))
    } catch { }
  }

  // ── 模型判断入口 ──────────────────────────────────────
  async handlePending(pHash: string) {
    if (!this.judgeModelRef?.value) {
      this.ctx.logger.error(
        `[sticker] 模型 ${this.config.judgeModel} 不可用，跳过对 ${pHash} 的判断。` +
        `请检查 judgeModel 配置与 Chatluna 模型加载状态。`
      )
      return
    }
    const rows = await this.ctx.database.get('sticker_occurrence', { pHash })
    if (!rows.length) return

    // 只处理 pending_review；judging / collected / rejected / judge_failed 跳过
    if (rows[0].status !== 'pending_review') return

    // 内部读取图片
    const buf = await this.readImage(pHash)
    if (!buf) {
      this.ctx.logger.error(`[sticker] 无法读取图片文件 ${pHash}，跳过判断`)
      return
    }

    await this.judgeByModel(pHash, buf)
  }
  private async tryAcquireJudge(pHash: string): Promise<string | null> {
    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`

    await this.ctx.database.set(
      'sticker_occurrence',
      { pHash, status: 'pending_review' },
      {
        status: 'judging',
        judgeStartedAt: Date.now(),
        judgeToken: token,
        judgeError: '',
      }
    )

    const rows = await this.ctx.database.get('sticker_occurrence', { pHash })
    if (rows[0]?.status === 'judging' && rows[0]?.judgeToken === token) {
      return token
    }
    return null
  }
  private async releaseJudge(
    pHash: string,
    token: string,
    update: Partial<StickerOccurrence>
  ) {
    await this.ctx.database.set(
      'sticker_occurrence',
      { pHash, status: 'judging', judgeToken: token },
      { ...update, judgeToken: '', judgeStartedAt: 0 }
    )
  }
  // ── 模型判断 ──────────────────────────────────────────
  private async judgeByModel(pHash: string, buf: Buffer) {
    // 单进程快速短路
    if (this.judging.has(pHash)) return

    const token = await this.tryAcquireJudge(pHash)
    if (!token) {
      this.ctx.logger.debug(`[sticker] ${pHash} 已被占用或状态不符，跳过`)
      return
    }

    this.judging.add(pHash)

    try {
    // 并发控制，防止瞬间大量请求导致 OOM
    await this.judgeSemaphore.acquire()
    try {
      const model = this.judgeModelRef.value
      const result = await model.invoke([
        {
          role: 'system',
          content:
            '你是表情包收藏助手。判断这张在群聊中反复出现的图片是否适合收藏为表情包。\n' +
            '适合：有趣、有梗、能表达情绪、可复用。\n' +
            '不适合：低俗、色情、性暗示、纯截图、文字图、低质量、现实照片。\n' +
            '一旦有符合的不适合条件则忽略合适部分\n' +
            '只回复 JSON，不要解释：{"collect": true/false, "tags": ["标签1","标签2"], "description": "简短描述", "usageHint": "适合什么场景用"}',
        },
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: {
                url: `data:image/png;base64,${buf.toString('base64')}`,
              },
            },
            { type: 'text', text: '这张图是否值得收藏为表情包？' },
          ],
        },
      ])

      const text =
        typeof result.content === 'string'
          ? result.content
          : Array.isArray(result.content)
            ? result.content
              .map((c: any) => (typeof c === 'string' ? c : c?.text || ''))
              .join('')
            : String(result.content)

      const parsed = this.parseJson(text)

      if (parsed.collect) {
        await this.ctx.database.upsert('sticker_meta', [{
          pHash,
          tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
          description: String(parsed.description || ''),
          usageHint: String(parsed.usageHint || ''),
          useCount: 0,
          collectedAt: Date.now(),
        }])
        await this.releaseJudge(pHash, token, { status: 'collected' })
        this.ctx.logger.info(
          `[sticker] 模型已收藏 ${pHash}: ${parsed.description || '(无描述)'}`
        )
        await this.enforceLibraryLimit()
      } else {
        // 模型判定不适合收藏：若此前已在收藏库中，需要一并从收藏列表移除
        const wasCollected = await this.evictFromCollection(pHash)
        await this.releaseJudge(pHash, token, { status: 'rejected' })
        this.ctx.logger.info(
          `[sticker] 模型拒绝 ${pHash}` +
          (wasCollected ? '（已从收藏库移除）' : '（已清理本地文件）')
        )
      }
    } catch (e: any) {
      const errMsg = String(e?.message ?? e ?? '未知错误')
      const visionUnsupported = this.isVisionUnsupportedError(errMsg)

      if (visionUnsupported) {
        this.ctx.logger.error(
          `[sticker] 模型 ${this.config.judgeModel} 不支持多模态图片输入，` +
          `已跳过后续判断。请更换为支持图片的模型后重启插件。\n` +
          `原始错误: ${errMsg}`
        )
      } else {
        this.ctx.logger.error(
          `[sticker] 模型判断失败 pHash=${pHash}: ${errMsg}`
        )
      }
      await this.releaseJudge(pHash, token, {
        status: 'judge_failed',
        judgeError: errMsg.slice(0, 500),
      })
    } finally {
      this.judgeSemaphore.release() // 释放并发锁
      }
    } finally {
      this.judging.delete(pHash)
    }
  }

  private isVisionUnsupportedError(msg: string): boolean {
    const lower = msg.toLowerCase()
    return (
      /(does not support|unsupported).{0,40}(image|vision|multimodal)/.test(lower) ||
      /(image|vision|multimodal).{0,40}(not supported|unsupported)/.test(lower) ||
      /invalid[_ ]?content[_ ]?type/.test(lower) ||
      /不支持.{0,10}(图片|图像|多模态)/.test(msg) ||
      /(图片|图像|多模态).{0,10}不支持/.test(msg)
    )
  }

  // ── 手动重试判断 ──────────────────────────────────────
  // 内部读取图片
  async retryJudge(pHash: string): Promise<boolean> {
    const buf = await this.readImage(pHash)
    if (!buf) return false

    const rows = await this.ctx.database.get('sticker_occurrence', { pHash })
    if (rows[0]?.status === 'judging') {
      this.ctx.logger.warn(`[sticker] ${pHash} 正在判断中，忽略本次重试`)
      return false
    }

    await this.ctx.database.set(
      'sticker_occurrence',
      { pHash },
      { status: 'pending_review', judgeError: '' }
    )
    await this.judgeByModel(pHash, buf)
    return true
  }
  async recoverStuckJudges(): Promise<number> {
    const timeoutMs = this.config.judgeTimeoutMinutes * 60 * 1000
    const deadline = Date.now() - timeoutMs

    const stuck = await this.ctx.database.get('sticker_occurrence', {
      status: 'judging',
      judgeStartedAt: { $lt: deadline },
    })

    let recovered = 0
    for (const row of stuck) {
      await this.ctx.database.set(
        'sticker_occurrence',
        {
          pHash: row.pHash,
          status: 'judging',
          judgeToken: row.judgeToken,
        },
        {
          status: 'pending_review',
          judgeError: '',
          judgeToken: '',
          judgeStartedAt: 0,
        }
      )

      recovered++
      this.ctx.logger.warn(
        `[sticker] 检测到超时判断 ${row.pHash}` +
        `（超过 ${this.config.judgeTimeoutMinutes} 分钟），已重置并重新提交`
      )

      this.handlePending(row.pHash).catch(e =>
        this.ctx.logger.error(`[sticker] 恢复判断 ${row.pHash} 失败:`, e)
      )
    }

    if (recovered) {
      this.ctx.logger.info(
        `[sticker] 共恢复 ${recovered} 条超时判断记录` +
        `（超时阈值 ${this.config.judgeTimeoutMinutes} 分钟）`
      )
    }
    return recovered
  }
  async clearAllJudgeFailures(): Promise<number> {
    const failed = await this.ctx.database.get('sticker_occurrence', {
      status: 'judge_failed',
    })
    for (const row of failed) {
      await this.ctx.database.set(
        'sticker_occurrence',
        { pHash: row.pHash },
        { status: 'pending_review', judgeError: '' }
      )
    }
    return failed.length
  }

  // ── 已收藏列表 ────────────────────────────────────────
  async listCollected(limit = 20) {
    const rows = await this.ctx.database.get('sticker_meta', {})
    return rows
      .sort((a, b) => (b.useCount || 0) - (a.useCount || 0))
      .slice(0, limit)
  }

  async markUsed(pHash: string) {
    const rows = await this.ctx.database.get('sticker_meta', { pHash })
    if (rows.length) {
      await this.ctx.database.set('sticker_meta', { pHash }, {
        useCount: (rows[0].useCount || 0) + 1,
        lastUsedAt: Date.now(),
      })
    }
  }
  /**
   * 模型判定为“不适合收藏”时的统一淘汰动作：
   *   - 删除 sticker_meta 收藏记录（若存在）
   *   - 删除本地图片文件（若存在）
   *
   * 与 enforceLibraryLimit 的区别：这里保留 occurrence 记录为 rejected，
   * 避免图片再次出现时被反复重新判断。已收藏的被重新判为不合适、
   * 以及首次判为不合适（此时通常无 meta、仅有刚落的 PNG），都走此路径。
   *
   * @returns 是否确实从收藏库移除了一条 sticker_meta
   */
  private async evictFromCollection(pHash: string): Promise<boolean> {
    const meta = await this.ctx.database.get('sticker_meta', { pHash })
    if (meta.length) {
      await this.ctx.database.remove('sticker_meta', { pHash })
    }
    // removeImageFile 内部吞掉“文件不存在”，首次判定时同样安全
    await this.removeImageFile(pHash)

    if (meta.length) {
      this.ctx.logger.info(
        `[sticker] 重新判定为不合适，已从收藏库移除 ${pHash}` +
        `（原描述: ${meta[0].description || '无'}）`
      )
    }
    return meta.length > 0
  }
  // ── 定时清理：未收藏 + lastSeenAt 超期 ────────────────
  /*
   * 已收藏（collected）的记录永不在此处清理，由收藏淘汰逻辑负责。
   * 被清掉的图若再次出现，会作为新图重新进入收集 / 判断流程。
   */
  async pruneStaleOccurrences(): Promise<number> {
    const ttlMs = this.config.occurrenceTtlDays * 24 * 60 * 60 * 1000
    const deadline = Date.now() - ttlMs

    // 【优化】使用数据库条件查询，替代全表拉取后在内存过滤
    const targets = await this.ctx.database.get('sticker_occurrence', {
      status: { $ne: 'collected' },
      lastSeenAt: { $lt: deadline }
    })

    if (!targets.length) return 0

    const hashes = targets.map(r => r.pHash)

    // 分批删除，避免一次性 IN 查询过大
    const BATCH = 500
    for (let i = 0; i < hashes.length; i += BATCH) {
      const batch = hashes.slice(i, i + BATCH)
      await this.ctx.database.remove('sticker_occurrence', {
        pHash: { $in: batch },
      })
      for (const h of batch) await this.removeImageFile(h)
    }

    this.ctx.logger.info(
      `[sticker] 已清理 ${targets.length} 条未收藏且超过 ${this.config.occurrenceTtlDays} 天未出现的记录及其本地图片`
    )
    return targets.length
  }
  // ── 可发送图淘汰（最久未使用优先） ────────────────────
  /**
   * 当已收藏图片（sticker_meta）超过 maxSendableImages 时，
   * 按「最久未使用」升序淘汰，直到数量回到上限。
   *
   * 排序键：lastUsedAt（从未使用过的用 collectedAt 兜底，
   * 避免「刚收藏、还没被用过」的新表情因 lastUsedAt=0 被立即淘汰）。
   *
   * 淘汰动作：
   *   - 删除 sticker_meta 记录
   *   - 删除 sticker_occurrence 记录
   *   - 删除本地图片文件
   * 该图若再次出现，会作为新图重新进入收集 / 判断流程。
   */
  private async enforceLibraryLimit() {
    const all = await this.ctx.database.get('sticker_meta', {})
    if (all.length <= this.config.maxSendableImages) return

    const activityTime = (m: typeof all[number]) =>
      m.lastUsedAt || m.collectedAt || 0

    const sorted = all.sort((a, b) => activityTime(a) - activityTime(b))
    const removeCount = all.length - this.config.maxSendableImages
    const toRemove = sorted.slice(0, removeCount)

    for (const m of toRemove) {
      await this.ctx.database.remove('sticker_meta', { pHash: m.pHash })
      await this.ctx.database.remove('sticker_occurrence', { pHash: m.pHash })
      await this.removeImageFile(m.pHash)
    }

    this.ctx.logger.info(
      `[sticker] 可发送图上限 ${this.config.maxSendableImages} 触发，` +
      `已淘汰 ${toRemove.length} 张最久未使用的收藏表情（含记录与本地文件）`
    )
  }

  // ── 工具方法 ──────────────────────────────────────────
  private parseJson(text: string): any {
    try {
      const m = text.match(/\{[\s\S]*\}/)
      return m ? JSON.parse(m[0]) : { collect: false }
    } catch {
      return { collect: false }
    }
  }
}
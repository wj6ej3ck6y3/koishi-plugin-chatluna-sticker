import { Context, h } from 'koishi'
import * as fs from 'fs/promises'
import * as path from 'path'
import imghash from 'imghash'
import { Config } from './config'

const HASH_BITS = 8           // imghash 网格边长 → 8×8 = 64 bit
const HASH_LENGTH = 16        // 64-bit = 16 个十六进制字符
const SEGMENT_COUNT = 8       // 拆 8 段
const SEGMENT_SIZE = HASH_LENGTH / SEGMENT_COUNT // 每段 2 字符

export interface OccurrenceResult {
  canonicalHash: string
  count: number
  status: string
  isNew: boolean
}

export class StickerLibrary {
  private judgeModelRef: any = null

  // ── 内存 pHash 索引 ──────────────────────────────────
  // allHashes: 所有见过的 pHash（含 rejected/evicted，避免重复审核）
  // segmentMap: 段值 → pHash 集合，用于快速缩小候选集
  private allHashes: Set<string> = new Set()
  private segmentMap: Map<string, Set<string>> = new Map()

  // 模型判断失败过的 pHash：避免同一张图反复触发失败（日志/成本）
  private judgeFailedHashes: Set<string> = new Set()

  constructor(private ctx: Context, private config: Config) {
    ctx.on('ready', async () => {
      await this.loadIndex()
      try {
        this.judgeModelRef = await ctx.chatluna.createChatModel(config.judgeModel)
        ctx.logger.info(`[sticker] 判断模型已就绪: ${config.judgeModel}`)
      } catch (e) {
        ctx.logger.error(
          `[sticker] 无法创建 Chatluna 模型引用（${config.judgeModel}）：` +
          `${(e as Error)?.message ?? e}。请确认 judgeModel 配置正确、模型已加载。`
        )
      }
    })
  }

  // ── 索引加载与维护 ────────────────────────────────────
  private async loadIndex() {
    try {
      const rows = await this.ctx.database.get('sticker_occurrence', {})
      this.allHashes.clear()
      this.segmentMap.clear()
      this.judgeFailedHashes.clear()
      for (const row of rows) {
        this.addToIndex(row.pHash)
        if (row.status === 'judge_failed') this.judgeFailedHashes.add(row.pHash)
      }
      this.ctx.logger.info(`[sticker] 内存 pHash 索引已加载 ${rows.length} 条`)
    } catch (e) {
      this.ctx.logger.error('[sticker] 加载内存索引失败:', e)
    }
  }

  private addToIndex(pHash: string) {
    if (this.allHashes.has(pHash)) return
    this.allHashes.add(pHash)
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      const seg = pHash.slice(i * SEGMENT_SIZE, (i + 1) * SEGMENT_SIZE)
      let set = this.segmentMap.get(seg)
      if (!set) {
        set = new Set()
        this.segmentMap.set(seg, set)
      }
      set.add(pHash)
    }
  }

  // ── pHash 计算 ────────────────────────────────────────
  async computePHash(buf: Buffer): Promise<string | null> {
    try {
      const hash = await imghash.hash(buf, HASH_BITS)
      if (typeof hash !== 'string' || hash.length !== HASH_LENGTH) {
        this.ctx.logger.warn(`[sticker] imghash 返回非法哈希: 長度: (length=${hash?.length}): ${hash},值: ${hash}`)
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

  // ── 内存索引相似查询 ──────────────────────────────────
  private findSimilar(pHash: string): string | null {
    const threshold = this.config.phashThreshold

    if (threshold > SEGMENT_COUNT - 1) {
      // 阈值过大，分段无法保证不漏检 → 全量遍历
      for (const h of this.allHashes) {
        if (this.hammingDistance(pHash, h) <= threshold) return h
      }
      return null
    }

    // 分段预筛选：收集所有段值命中的 pHash
    const candidates = new Set<string>()
    for (let i = 0; i < SEGMENT_COUNT; i++) {
      const seg = pHash.slice(i * SEGMENT_SIZE, (i + 1) * SEGMENT_SIZE)
      const set = this.segmentMap.get(seg)
      if (set) for (const h of set) candidates.add(h)
    }

    // 候选集内计算真实汉明距离
    for (const h of candidates) {
      if (this.hammingDistance(pHash, h) <= threshold) return h
    }
    return null
  }

  // ── 记录出现（全局统计） ──────────────────────────────
  async recordOccurrence(pHash: string): Promise<OccurrenceResult> {
    const similar = this.findSimilar(pHash)
    const canonicalHash = similar || pHash

    const existing = await this.ctx.database.get('sticker_occurrence', {
      pHash: canonicalHash,
    })

    if (existing.length) {
      const row = existing[0]
      const newCount = row.count + 1
      let newStatus = row.status
      // 仅 'new' 达到阈值时转入待审
      if (newCount >= this.config.judgeThreshold && row.status === 'new') {
        newStatus = 'pending_review'
      }
      await this.ctx.database.set(
        'sticker_occurrence',
        { pHash: canonicalHash },
        { count: newCount, lastSeenAt: Date.now(), status: newStatus }
      )
      return { canonicalHash, count: newCount, status: newStatus, isNew: false }
    }

    // 新条目
    await this.ctx.database.create('sticker_occurrence', {
      pHash: canonicalHash,
      count: 1,
      status: 'new',
      firstSeenAt: Date.now(),
      lastSeenAt: Date.now(),
      judgeError: '',
    })
    this.addToIndex(canonicalHash)
    return { canonicalHash, count: 1, status: 'new', isNew: true }
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
    } catch {}
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

  // ── 模型判断入口 ──────────────────────────────────────
  async handlePending(pHash: string, buf: Buffer) {
    // 该 pHash 之前判断失败过 → 跳过，避免反复触发
    if (this.judgeFailedHashes.has(pHash)) return
    if (!this.judgeModelRef?.value) {
      // 模型引用尚未就绪（如启动时创建失败），记录一次错误
      this.ctx.logger.error(
        `[sticker] 模型 ${this.config.judgeModel} 不可用，跳过对 ${pHash} 的判断。` +
        `请检查 judgeModel 配置与 Chatluna 模型加载状态。`
      )
      return
    }
    await this.judgeByModel(pHash, buf)
  }

  // ── 模型判断 ──────────────────────────────────────────
  private async judgeByModel(pHash: string, buf: Buffer) {
    try {
      const model = this.judgeModelRef.value
      const result = await model.invoke([
        {
          role: 'system',
          content:
            '你是表情包收藏助手。判断这张在群聊中反复出现的图片是否适合收藏为表情包。\n' +
            '适合：有趣、有梗、能表达情绪、可复用。\n' +
            '不适合：低俗、色情、纯截图、文字图、低质量、过于个人化（如某人自拍）。\n' +
            '一旦有符合的不适合条件则忽略合适部分\n'+
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
        await this.ctx.database.set(
          'sticker_occurrence',
          { pHash },
          { status: 'collected', judgeError: '' }
        )
        this.ctx.logger.info(
          `[sticker] 模型已收藏 ${pHash}: ${parsed.description || '(无描述)'}`
        )
        await this.enforceLibraryLimit()
      } else {
        await this.ctx.database.set(
          'sticker_occurrence',
          { pHash },
          { status: 'rejected', judgeError: '' }
        )
        this.ctx.logger.info(`[sticker] 模型拒绝 ${pHash}`)
      }
    } catch (e: any) {
      const errMsg = String(e?.message ?? e ?? '未知错误')
      const visionUnsupported = this.isVisionUnsupportedError(errMsg)

      if (visionUnsupported) {
        // 模型不支持多模态：记录明确错误，标记为 judge_failed，不再重试
        this.ctx.logger.error(
          `[sticker] 模型 ${this.config.judgeModel} 不支持多模态图片输入，` +
          `已跳过后续判断。请更换为支持图片的模型后重启插件。\n` +
          `原始错误: ${errMsg}`
        )
        await this.ctx.database.set(
          'sticker_occurrence',
          { pHash },
          { status: 'judge_failed', judgeError: errMsg.slice(0, 500) }
        )
        this.judgeFailedHashes.add(pHash)
      } else {
        // 其他错误：记录错误日志并标记失败，避免反复触发
        this.ctx.logger.error(
          `[sticker] 模型判断失败 pHash=${pHash}: ${errMsg}`
        )
        await this.ctx.database.set(
          'sticker_occurrence',
          { pHash },
          { status: 'judge_failed', judgeError: errMsg.slice(0, 500) }
        )
        this.judgeFailedHashes.add(pHash)
      }
    }
  }

  /** 检测错误信息是否表明模型不支持多模态图片输入 */
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
  /**
   * 清除某个 pHash 的判断失败记录并重新触发判断。
   * 用于更换模型后重试之前失败的图片。
   */
  async retryJudge(pHash: string): Promise<boolean> {
    const buf = await this.readImage(pHash)
    if (!buf) return false
    this.judgeFailedHashes.delete(pHash)
    await this.ctx.database.set(
      'sticker_occurrence',
      { pHash },
      { status: 'pending_review', judgeError: '' }
    )
    await this.judgeByModel(pHash, buf)
    return true
  }

  /** 清除所有判断失败记录，下次出现时会重新判断 */
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
    this.judgeFailedHashes.clear()
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

  // ── 可发送图淘汰 ──────────────────────────────────────
  /**
   * 当已收藏图片（sticker_meta）超过 maxSendableImages 时，
   * 按 collectedAt 升序删除最旧的，直到数量回到上限。
   *
   * 淘汰动作：
   *   - 删除 sticker_meta 记录
   *   - 删除本地图片文件
   *   - sticker_occurrence.status 改为 'evicted'（避免重复审核）
   *   - 内存索引保留该 pHash（仍在 allHashes 中，语义上"见过"）
   */
  private async enforceLibraryLimit() {
    const all = await this.ctx.database.get('sticker_meta', {})
    if (all.length <= this.config.maxSendableImages) return

    const sorted = all.sort(
      (a, b) => (a.collectedAt || 0) - (b.collectedAt || 0)
    )
    const removeCount = all.length - this.config.maxSendableImages
    const toRemove = sorted.slice(0, removeCount)

    for (const m of toRemove) {
      await this.ctx.database.remove('sticker_meta', { pHash: m.pHash })
      await this.ctx.database.set(
        'sticker_occurrence',
        { pHash: m.pHash },
        { status: 'evicted' }
      )
      try {
        await fs.unlink(this.filePath(m.pHash))
      } catch {}
    }

    this.ctx.logger.info(
      `[sticker] 可发送图上限 ${this.config.maxSendableImages} 触发，` +
      `已淘汰 ${toRemove.length} 张最旧的收藏表情`
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

  getIndexStats() {
    return {
      totalHashes: this.allHashes.size,
      totalSegments: this.segmentMap.size,
      judgeFailed: this.judgeFailedHashes.size,
    }
  }

  isJudgeFailed(pHash: string) {
    return this.judgeFailedHashes.has(pHash)
  }
}
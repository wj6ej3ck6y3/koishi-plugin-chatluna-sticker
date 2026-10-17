import { Context, h } from 'koishi'
import * as fs from 'fs/promises'
import * as path from 'path'
import imghash from 'imghash'
import { Config } from './config'
import { StickerOccurrence, type StickerMeta } from './database'
import { LunaVDB } from '@chatluna/luna-vdb'

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
  private judging = new Set<string>()   // 单进程快速短路
  private embeddingModelRef: any = null
  private embeddingSemaphore: Semaphore
  private semanticReady = false
  private vdb: LunaVDB | null = null
  private vdbDirty = false
  private vdbPersistTimer: (() => void) | null = null
  private normalize(vec: number[]): number[] {
    let norm = 0
    for (const v of vec) norm += v * v
    norm = Math.sqrt(norm)
    if (norm === 0) return vec
    return vec.map(v => v / norm)
  }
  constructor(private ctx: Context, private config: Config) {
    this.embeddingSemaphore = new Semaphore(this.config.embeddingConcurrency ?? 3)
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
      // 新增：先建 embedding，再初始化 / 恢复 VDB
      await this.initEmbedding()
      await this.initVDB()
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
      // ↓ 新增：进程退出前尽力落盘 VDB
      ctx.on('dispose', () => {
        this.persistVDB().catch(() => { })
      })
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
        const desc = String(parsed.description || '')
        const hint = String(parsed.usageHint || '')
        const tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : []

        await this.ctx.database.upsert('sticker_meta', [{
          pHash,
          tags,
          description: desc,
          usageHint: hint,
          useCount: 0,
          collectedAt: Date.now(),
        }])
        // 新增：生成向量并入库 VDB
        let hasVec = false
        if (this.semanticReady && this.vdb) {
          const vec = await this.generateEmbedding(
            this.buildEmbeddingText({ description: desc, usageHint: hint, tags })
          )
          if (vec) {
            this.addToVDB(pHash, vec)
            hasVec = true
          } else {
            // 重判更新了描述但向量生成失败 → 移除旧向量，避免与新描述不一致
            this.removeFromVDB(pHash)
            this.ctx.logger.warn(
              `[sticker] ${pHash} 重判后向量生成失败，已移除旧向量，下次 rebuild-vdb 时补回`
            )
          }
        } else if (this.vdb) {
          // semanticReady = false 但 VDB 中存在旧向量 → 也应清理
          this.removeFromVDB(pHash)
        }

        await this.releaseJudge(pHash, token, { status: 'collected' })
        this.ctx.logger.info(
          `[sticker] 模型已收藏 ${pHash}: ${desc || '(无描述)'}` +
          (hasVec ? '（已入库向量）' : '（未入库向量）')
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

  // 语义匹配 / luna-vdb
  private async initEmbedding() {
    if (!this.config.enableSemanticMatch) {
      this.ctx.logger.info('[sticker] 语义匹配未启用')
      return
    }
    if (!this.config.embeddingModel) {
      this.ctx.logger.warn('[sticker] 启用了语义匹配但未配置 embeddingModel，跳过')
      return
    }
    try {
      this.embeddingModelRef = await this.ctx.chatluna.createEmbeddings(this.config.embeddingModel)
      this.semanticReady = !!this.embeddingModelRef?.value
      if (this.semanticReady) {
        this.ctx.logger.info(`[sticker] Embedding 模型已就绪: ${this.config.embeddingModel}`)
      } else {
        this.ctx.logger.error(`[sticker] Embedding 模型引用为空: ${this.config.embeddingModel}`)
      }
    } catch (e) {
      this.ctx.logger.error(
        `[sticker] 无法创建 Embedding 模型引用（${this.config.embeddingModel}）：` +
        `${(e as Error)?.message ?? e}`
      )
    }
  }

  // 在 initVDB 成功后调用
  private detectDistanceSemantics() {
    const probe = new LunaVDB()
    try {
      probe.add({
        embeddings: [
          { id: 'self', embeddings: [1, 0, 0] },
          { id: 'ortho', embeddings: [0, 1, 0] },
        ]
      })
      const r = probe.search(new Float32Array([1, 0, 0]), 2)
      const self = r.neighbors.find(n => n.id === 'self')?.distance
      const ortho = r.neighbors.find(n => n.id === 'ortho')?.distance
      // 期望 self≈0, ortho≈1.414（L2）
      const isL2 = Math.abs((self ?? 0)) < 0.01
        && Math.abs((ortho ?? 0) - Math.SQRT2) < 0.01
      this.ctx.logger.info(
        `[sticker] luna-vdb 距离语义探测: self=${self}, ortho=${ortho}` +
        (isL2 ? ' (L2 ✓)' : ' (⚠ 非预期 L2，请检查 score 转换)')
      )
    } finally {
      probe.free()
    }
  }

  private async initVDB() {
    if (!this.semanticReady) {
      this.ctx.logger.info('[sticker] Embedding 未就绪，跳过 VDB 初始化')
      return
    }
    // 探测 luna-vdb 的 distance 语义（独立临时实例，与 this.vdb 无关）
    if (this.config.debugDistanceProbe) {
      this.detectDistanceSemantics()
    }

    const rows = await this.ctx.database.get('sticker_vdb_snapshot', { id: 'main' })
    const snap = rows[0]

    if (snap && snap.embeddingModel === this.config.embeddingModel) {
      try {
        const buf = Buffer.from(snap.data, 'base64')
        this.vdb = LunaVDB.deserialize(new Uint8Array(buf))
        this.ctx.logger.info('[sticker] VDB 已从快照恢复')
        return
      } catch (e) {
        this.ctx.logger.error('[sticker] VDB 快照损坏，将重建:', e)
      }
    } else if (snap) {
      this.ctx.logger.warn(
        `[sticker] embedding 模型变更（${snap.embeddingModel} → ${this.config.embeddingModel}），` +
        `旧快照作废，将重建索引`
      )
    }

    this.vdb = new LunaVDB()
    await this.backfillEmbeddings()
  }

  async generateEmbedding(text: string): Promise<number[] | null> {
    if (!this.semanticReady || !this.embeddingModelRef?.value || !text) return null

    await this.embeddingSemaphore.acquire()
    try {
      // 本地推理极快时，undici 连接池复用容易撞上服务端的 FIN 包，
      // 故意加 20ms 延迟让 Node 事件循环处理完 TCP 关闭信号。
      await new Promise(resolve => setTimeout(resolve, 20))

      for (let i = 0; i <= 2; i++) {
        try {
          const vec = await this.embeddingModelRef.value.embedQuery(text)
          return Array.isArray(vec) && vec.length ? (vec as number[]) : null
        } catch (e: any) {
          const msg = String(e?.message ?? e)
          const isTransient = /ECONNRESET|fetch failed|socket hang up/i.test(msg)

          if (!isTransient || i === 2) {
            this.ctx.logger.warn('[sticker] embedding 生成失败:', e)
            return null
          }
          // 瞬时断连，静默退避重试，避免刷屏红字
          await new Promise(resolve => setTimeout(resolve, 20 * (i + 1)))
        }
      }
      return null
    } finally {
      this.embeddingSemaphore.release()
    }
  }

  private buildEmbeddingText(m: { description?: string; usageHint?: string; tags?: string[] }): string {
    return [m.description || '', m.usageHint || '', ...(m.tags || [])].filter(Boolean).join(' ')
  }

  private addToVDB(pHash: string, vector: number[]) {
    if (!this.vdb) return
    try { this.vdb.remove([pHash]) } catch { }
    const normalized = this.normalize(vector)
    this.vdb.add({ embeddings: [{ id: pHash, embeddings: normalized }] })
    this.markVdbDirty()
  }

  private removeFromVDB(pHash: string) {
    if (!this.vdb) return
    try {
      this.vdb.remove([pHash])
      this.markVdbDirty()
    } catch (e) {
      this.ctx.logger.warn(`[sticker] VDB 移除 ${pHash} 失败:`, e)
    }
  }

  private markVdbDirty() {
    this.vdbDirty = true
    if (this.vdbPersistTimer) return
    this.vdbPersistTimer = this.ctx.setTimeout(async () => {
      this.vdbPersistTimer = null
      if (!this.vdbDirty) return
      await this.persistVDB().catch(e =>
        this.ctx.logger.error('[sticker] VDB 持久化失败:', e)
      )
    }, 5000)
  }

  private async persistVDB() {
    if (!this.vdb) return
    const b64 = Buffer.from(this.vdb.serialize()).toString('base64')
    await this.ctx.database.upsert('sticker_vdb_snapshot', [{
      id: 'main',
      data: b64,
      embeddingModel: this.config.embeddingModel,
      updatedAt: Date.now(),
    }])
    this.vdbDirty = false
  }

  async searchBySemantic(
    intent: string,
    topK: number,
    minScore: number
  ): Promise<Array<{ meta: StickerMeta; score: number }> | null> {
    if (!this.semanticReady || !this.vdb) return null
    const queryVec = await this.generateEmbedding(intent)
    if (!queryVec) return null
    const normalizedQuery = this.normalize(queryVec)

    const result: any = this.vdb.search(new Float32Array(normalizedQuery), topK)
    // 已实测 luna-vdb 返回 L2 欧氏距离（self=0, ortho≈√2），
    // 归一化向量下 cos = 1 - d²/2
    const neighbors: any[] = result?.neighbors ?? []
    const hits = neighbors
      .map((n: any) => {
        const d = n.distance ?? 0
        return { pHash: n.id as string, score: 1 - (d * d) / 2 }
      })
      .filter((h: any) => h.score >= minScore)
      .sort((a: any, b: any) => b.score - a.score)
    if (!hits.length) return []

    const metas = await this.ctx.database.get('sticker_meta', {
      pHash: { $in: hits.map((h: any) => h.pHash) },
    })
    const map = new Map(metas.map(m => [m.pHash, m]))
    const out: Array<{ meta: StickerMeta; score: number }> = []
    for (const h of hits) {
      const m = map.get(h.pHash)
      if (m) out.push({ meta: m, score: h.score })
    }
    return out
  }

  async backfillEmbeddings(): Promise<number> {
    if (!this.semanticReady || !this.vdb) return 0
    const metas = await this.ctx.database.get('sticker_meta', {})
    if (!metas.length) return 0

    this.ctx.logger.info(`[sticker] 开始构建向量索引，共 ${metas.length} 条`)

    let count = 0
    // 每批 batchSize 个任务并发提交，batchSize 略大于信号量容量，让信号量保持饱和
    const concurrency = this.config.embeddingConcurrency ?? 4
    const batchSize = Math.max(concurrency * 2, 10)
    let processed = 0

    for (let i = 0; i < metas.length; i += batchSize) {
      const batch = metas.slice(i, i + batchSize)
      const results = await Promise.all(
        batch.map(async m => {
          const text = this.buildEmbeddingText(m)
          if (!text) return null
          const vec = await this.generateEmbedding(text)
          if (!vec) return null
          return { pHash: m.pHash, vec: this.normalize(vec) }
        })
      )
      // 写 VDB 是同步的，放主线程顺序 add，避免并发写索引
      for (const r of results) {
        if (!r) continue
        this.vdb.add({ embeddings: [{ id: r.pHash, embeddings: r.vec }] })
        count++
      }
      processed += batch.length
      this.ctx.logger.info(
        `[sticker] 向量构建进度: ${processed}/${metas.length}（成功 ${count}）`
      )
    }

    this.vdbDirty = true
    await this.persistVDB()
    this.ctx.logger.info(`[sticker] 向量索引构建完成，共 ${count} 条`)
    return count
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

  //手動重建VDB索引
  async rebuildVDB(): Promise<number> {
    if (!this.semanticReady) return 0
    this.vdb = new LunaVDB()
    return await this.backfillEmbeddings()
  }

  // ── 已收藏列表 ────────────────────────────────────────
  async listCollected(limit = 20) {
    return this.ctx.database.get('sticker_meta', {}, {
      sort: { useCount: 'desc' },
      limit,
    })
  }

  /**
   * 从收藏库中随机抽取最多 limit 条作为发送候选池。
   *
   * - 收藏总数 ≤ limit：直接返回全部（顺序打乱，避免同一批总是排在前面）
   * - 收藏总数 > limit：使用部分 Fisher-Yates 洗牌，只随机前 limit 个位置，
   *   时间复杂度 O(limit)，不整体排序，避免大库时的开销。
   *
   * 与 listCollected 的区别：
   *   listCollected 按 useCount 排序，适合“查看列表”；
   *   sampleCollected 随机取样，适合“发送时挑一张”，避免高频表情长期霸屏。
   */
  async sampleCollected(limit: number) {
    const rows = await this.ctx.database.get('sticker_meta', {})
    if (!rows.length) return rows

    const n = Math.min(limit, rows.length)
    const copy = rows.slice()

    // 部分 Fisher-Yates：只洗前 n 个位置
    for (let i = 0; i < n; i++) {
      const j = i + Math.floor(Math.random() * (copy.length - i))
      if (i !== j) {
        const tmp = copy[i]
        copy[i] = copy[j]
        copy[j] = tmp
      }
    }

    return copy.slice(0, n)
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
      this.removeFromVDB(pHash)
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
      this.removeFromVDB(m.pHash)
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
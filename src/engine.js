import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { SummaryCache } from './cache.js'
import { collectMemory, renderMemory, stripManagedMemory } from './memory.js'
import {
  blocksText,
  codePointLength,
  extractAnchors,
  messagesText,
  alnumCount,
} from './text-utils.js'

const BASE_POLICY_KEYS = [
  'thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens',
  'summarizationProvider', 'summarizationModel', 'maxTokens',
  'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
]

function pickBaseConfig(config) {
  const out = {}
  for (const k of BASE_POLICY_KEYS) if (config[k] !== undefined) out[k] = config[k]
  return out
}

const economicsSchema = z.object({
  /** 开启 SoL-Pi 式经济门控；默认关（宿主官方阈值策略原样生效）。 */
  enabled: z.boolean().default(false),
  /** 缓存写价/读价比值（SoL-Pi 默认 12.5，对应主流 API 缓存定价结构）。 */
  cacheWriteReadRatio: z.number().default(12.5),
  /** 摘要自身占用的常量估计（SoL-Pi memoTokens=1000）。 */
  memoTokens: z.number().step(1).min(0).default(1000),
  /** 窗口保护余量：距窗口不足该值时连冷却/经济门都豁免（绝对压缩）。 */
  windowReserveTokens: z.number().step(1).min(0).default(4096),
  /** 首次压缩视界放大倍数（乐观）。 */
  firstCompactionScale: z.number().default(2.0),
  /** 后续压缩要求的安全裕度倍数。 */
  subsequentMargin: z.number().default(1.5),
  /** 冷却期：距上次压缩至少经过的模型请求数。 */
  cooldownRequests: z.number().step(1).min(0).default(2),
})

const budgetsSchema = z.object({
  minRegionTokens: z.number().step(1).min(0).default(512),
  minSavingsTokens: z.number().step(1).min(0).default(96),
  checkpointReserveTokens: z.number().step(1).min(0).default(128),
  maxCheckpointTokens: z.number().step(1).min(1).default(2048),
  maxExtrasTokens: z.number().step(1).min(0).default(384),
})
const cacheSchema = z.object({
  enabled: z.boolean().default(true),
  maxEntries: z.number().step(1).min(0).default(16),
  maxBytes: z.number().step(1).min(0).default(262144),
  ttlMs: z.number().step(1).min(0).default(300000),
  failureTtlMs: z.number().step(1).min(0).default(30000),
})
const memorySchema = z.object({
  maxItems: z.number().step(1).min(0).default(8),
  maxTodos: z.number().step(1).min(0).default(4),
  maxItemChars: z.number().step(1).min(1).default(160),
  allowedKeys: z.array(z.string()).default([]),
})

/** Host-owned selection and transactions; bounded work in the summarization hook. */
export class CtxoptCompactionEngine extends BasicCompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config = z.object({
    // —— 官方 basic 策略字段（原样透传给 super）——
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    summarizationProvider: z.string(),
    summarizationModel: z.string(),
    maxTokens: z.number().step(1).min(1),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
    modelPolicies: z.array(z.any()),
    auto: z.boolean(),
    // —— ctxopt 扩展开关（上阶段成果的对照旋钮）——
    /** 摘要后锚点校验：缺失的关键事实由确定性规则补齐（fail-open，不再调模型）。 */
    anchorValidation: z.boolean().default(true),
    /** 启用显式 MEMORY / 记住 键值记忆块。 */
    memoryBlock: z.boolean().default(true),
    /** 生成"下一步待办"提醒段并置于摘要尾部（近因位，R4+ 教训）。 */
    reminders: z.boolean().default(true),
    /** 退化门：自适应内容下限；默认不重试，拒绝退化摘要并保留原历史。 */
    degenerateGate: z.boolean().default(true),
    budgets: budgetsSchema.default({}),
    cache: cacheSchema.default({}),
    memory: memorySchema.default({}),
    degenerateRetries: z.number().step(1).min(0).max(1).default(0),
    minSummaryChars: z.number().step(1).min(0).default(500),
    minSummaryAlnum: z.number().step(1).min(0).default(300),
    summaryFloorRatio: z.number().min(0).max(1).default(0.1),
    /** 经济门控参数（见上）。 */
    economics: economicsSchema.default({}),
  })

  constructor(ctx, config = {}) {
    // 先构造官方引擎（自动触发监听随 auto 注册，动态分派到本类覆盖方法）。
    super(ctx, pickBaseConfig(config))
    this.ctxoptConfig = CtxoptCompactionEngine.Config(config)
    this.ctx = ctx
    if (this.ctxoptConfig.budgets.maxCheckpointTokens <= this.ctxoptConfig.budgets.checkpointReserveTokens) {
      throw new Error('ctxopt: maxCheckpointTokens must exceed checkpointReserveTokens')
    }
    for (const key of this.ctxoptConfig.memory.allowedKeys) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(key)) throw new Error('ctxopt: memory.allowedKeys contains an invalid key')
    }
    this.summaryCache = new SummaryCache(this.ctxoptConfig.cache)
    ctx.effect(() => () => this.summaryCache.clear())
    ctx.logger.info('ctxopt loaded: version=0.0.1 ' + JSON.stringify({
      budgets: this.ctxoptConfig.budgets, cache: this.ctxoptConfig.cache,
      memoryBlock: this.ctxoptConfig.memoryBlock, reminders: this.ctxoptConfig.reminders,
    }))
  }

  /**
   * 经济门控（SoL-Pi economics.ts 的宿主移植）：压缩固定成本 = 缓存重写债务，
   * 必须由剩余请求视界摊薄。返回 { allow, reason, breakeven?, horizon? }。
   */
  async _gatePressure(agent, signal) {
    const econ = this.ctxoptConfig.economics
    const session = agent.session
    const measurement = this.ctx.tokenMeter.measure(session)
    const total = measurement?.totalTokens ?? 0

    // 路由目标与窗口（宿主已有解析路径）
    const config = session.requestHeader()?.config
    if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
      return { allow: true, reason: 'no-route: delegate to host policy' }
    }
    let contextWindow
    try {
      const info = await this.ctx.llm.resolveModelInfo(config.provider, config.model, signal)
      contextWindow = info.context?.contextWindow
    } catch { contextWindow = undefined }
    if (contextWindow === undefined) {
      return { allow: true, reason: 'unknown-window: delegate to host policy' }
    }

    // 窗口保护（绝对，连冷却都豁免）
    if (total >= contextWindow - econ.windowReserveTokens) {
      return { allow: true, reason: `window-protection (${total} ≥ ${contextWindow - econ.windowReserveTokens})` }
    }

    // 保留/节省账面（SoL-Pi：saving = archiveTokens − memoTokens）
    const retain = this.config.retainTokens
      ?? Math.floor(contextWindow * (this.config.retainRatio ?? 0.16))
    const post = Math.max(0, retain)
    const saving = Math.max(0, total - post - econ.memoTokens)
    const newDebt = post * (econ.cacheWriteReadRatio - 1)
    const breakeven = saving > 0 ? newDebt / saving : Infinity

    // 视界：距阈值的剩余请求数 ≈ (阈值 − 当前) / 平均每请求增量
    const surfaceSeqs = [...session.surface.nodes]
    let assistantCount = 0
    let lastCheckpointSeq = -1
    for (const seq of surfaceSeqs) {
      // oxlint-disable-next-line typescript/no-deprecated -- 与宿主 pruner 相同的历史读法；迁移随宿主进行。
      const event = session.eventAt(seq)
      if (event?.type === 'assistant/message') assistantCount++
      if (event?.type === 'user/message') {
        const msg = session.deriveEventMessage(event)
        if (msg?.source?.kind === 'compact-checkpoint') lastCheckpointSeq = seq
      }
    }
    const thresholdTokens = contextWindow * (this.config.thresholdRatio ?? 0.8)
    const avgIncrement = total / Math.max(1, assistantCount)
    const horizon = 1 + Math.floor(Math.max(0, thresholdTokens - total) / Math.max(1, avgIncrement))

    // 冷却：上次 checkpoint 之后的模型请求数
    let requestsSinceCompaction = Infinity
    if (lastCheckpointSeq >= 0) {
      requestsSinceCompaction = 0
      for (const seq of surfaceSeqs) {
        if (seq <= lastCheckpointSeq) continue
        // oxlint-disable-next-line typescript/no-deprecated -- 同上。
        if (session.eventAt(seq)?.type === 'assistant/message') requestsSinceCompaction++
      }
      if (requestsSinceCompaction < econ.cooldownRequests) {
        return { allow: false, reason: `cooldown (${requestsSinceCompaction}/${econ.cooldownRequests} requests since last compaction)` }
      }
    }
    const first = lastCheckpointSeq < 0
    const margin = first ? econ.firstCompactionScale : econ.subsequentMargin
    const allow = breakeven <= horizon * margin
    return {
      allow,
      reason: allow
        ? `economic-pass (breakeven=${breakeven.toFixed(2)} ≤ horizon=${horizon}×${margin})`
        : `breakeven ${breakeven.toFixed(2)} > horizon ${horizon} × ${margin}`,
      breakeven, horizon,
    }
  }

  /**
   * pressure 触发先过经济门（可观测日志 + 可配置开关）；
   * context-overflow 属于"提供商实锤"绝对直通宿主官方恢复。
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (this.ctxoptConfig.economics.enabled && trigger === 'pressure') {
      // SoL-Pi 正确语义：免费的确定性裁剪永远先行（即使门否决付费摘要）。
      // 宿主把 prune 放在 super.compactIfNeeded 内部，门若就此拦截会把缝合点
      // 一并压死——必须先以自己一次等价的公开调用补上（与宿主同协议的幂等操作，
      // 门放行后 super 内第二次裁剪天然为空转）。
      const pruner = this.ctx.get('toolResultPruner')
      if (pruner !== undefined) {
        try {
          pruner.pruneSession(agent.session)
        } catch (err) {
          this.ctx.logger.warn(`ctxopt economics: prune pass failed (${err?.message ?? err}), gate continues on pre-prune measurement`)
        }
      }
      const gate = await this._gatePressure(agent, signal)
      this.ctx.logger.info(
        `ctxopt economics gate: session=${agent.session.id} decision=${gate.allow ? 'allow' : 'skip'} — ${gate.reason}`,
      )
      if (!gate.allow) return null
    }
    return super.compactIfNeeded(agent, trigger, signal)
  }

  /** Expose only counts, never cached conversation text. Clearing does not erase session logs. */
  cacheStats() { return this.summaryCache.stats() }
  clearCache() { this.summaryCache.clear() }

  /** Small or rejected regions retain their original surface without another paid summary. */
  async summarize(input, agent, signal) {
    signal?.throwIfAborted()
    const started = performance.now()
    let modelMs = 0
    const cfg = this.ctxoptConfig, budgets = cfg.budgets
    const estimate = text => this.ctx.tokenMeter.estimateMessage({ role: 'user', content: [{ type: 'text', text }] })
    // The host replays the unshadowed system head for prefix-cache reuse. It is not savings.
    const region = input.messages.filter(message => message.role !== 'system')
    const regionTokens = region.reduce((sum, message) => sum + this.ctx.tokenMeter.estimateMessage(message), 0)
    const regionChars = codePointLength(messagesText(region))
    const summaryBudget = Math.min(budgets.maxCheckpointTokens - budgets.checkpointReserveTokens,
      regionTokens - budgets.minSavingsTokens - budgets.checkpointReserveTokens)
    const log = (decision, data = {}) => this.ctx.logger.info('ctxopt decision: ' + JSON.stringify({
      session: agent.session.id, decision, regionTokens, regionChars, ...data,
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      modelMs: Math.round(modelMs * 100) / 100,
      localMs: Math.round((performance.now() - started - modelMs) * 100) / 100,
      cache: this.cacheStats(),
    }))
    const reject = reason => { const error = new Error(`ctxopt: ${reason}; original history retained`); error.code = 'CTXOPT_NO_GAIN'; throw error }
    if (regionTokens < budgets.minRegionTokens || summaryBudget <= 0) {
      log('skip-small-region'); reject('region below useful compression budget')
    }
    const key = cfg.cache.enabled ? this.summaryCache.key({
      session: agent.session.id, input, config: this.config, ctxopt: cfg,
      route: agent.session.requestHeader()?.config,
      fallback: { provider: agent.options.provider, model: agent.options.model },
      toolHistory: agent.session.toolHistory(),
    }) : null
    const cached = this.summaryCache.get(key)
    if (cached) {
      log(cached.error ? 'cached-rejection' : 'cache-hit')
      if (cached.error) reject(cached.error)
      return cached.result
    }
    const rememberRejection = reason => {
      this.summaryCache.set(key, { error: reason }, cfg.cache.failureTtlMs)
      log('reject', { reason }); reject(reason)
    }
    const quality = text => !cfg.degenerateGate || (
      codePointLength(text) >= Math.min(cfg.minSummaryChars, Math.floor(regionChars * cfg.summaryFloorRatio))
      && alnumCount(text) >= Math.min(cfg.minSummaryAlnum, Math.floor(regionChars * cfg.summaryFloorRatio * 0.6)))
    let result, text, calls = 0
    for (let attempt = 0; attempt <= (cfg.degenerateGate ? cfg.degenerateRetries : 0); attempt++) {
      const callStarted = performance.now()
      try {
        result = await super.summarize(input, agent, signal)
      } catch (error) {
        modelMs += performance.now() - callStarted
        log('model-error', { code: error?.code ?? 'unknown' })
        throw error
      }
      modelMs += performance.now() - callStarted
      calls++
      signal?.throwIfAborted()
      text = stripManagedMemory(blocksText(result.summary))
      log('model-summary', { calls, usage: result.usage, summaryTokens: estimate(text) })
      if (quality(text)) break
    }
    if (!quality(text)) rememberRejection('summary quality floor failed')
    const baseTokens = estimate(text)
    if (baseTokens > summaryBudget) rememberRejection('summary exceeds useful checkpoint budget')

    // One shared budget: explicit state first, diagnostic supplements only if space remains.
    const extraBudget = Math.min(budgets.maxExtrasTokens, summaryBudget - baseTokens)
    const state = collectMemory(region, cfg.memory)
    if (!cfg.memoryBlock) state.facts = []
    if (!cfg.reminders) state.todos = []
    const memory = renderMemory(state, extraBudget, estimate)
    let extra = memory.text
    if (cfg.anchorValidation) {
      const anchors = extractAnchors(region.filter(message => message.source?.kind !== 'compact-checkpoint').map(message => ({
        ...message, content: message.content.map(block => block.type !== 'text' ? block : { ...block,
          text: block.text.split('\n').filter(line => !/^(?:MEMORY|FORGET|TODO|DONE|记住|忘记|待办|完成|取消待办)(?:\s|:)/i.test(line.trim())).join('\n'),
        }),
      })))
      for (const [label, entries] of [['错误锚点', anchors.errors], ['文件', anchors.files], ['命令', anchors.commands], ['工单', anchors.ids]]) {
        for (const item of entries) {
          if (text.includes(item)) continue
          const next = [extra, `- ${label}: ${item}`].filter(Boolean).join('\n')
          if (estimate(next) <= extraBudget && estimate(text + '\n' + next) <= summaryBudget) extra = next
        }
      }
    }
    // Meter overhead/rounding can differ between separate blocks and a joined message.
    if (extra && estimate(text + '\n' + extra) > summaryBudget) extra = ''
    const summary = [{ type: 'text', text: text + (extra ? '\n' + extra : '') }]
    const final = { ...result, summary }
    // Cache hits are local reuse: never attribute old provider usage or a new stream call to them.
    const reusable = { summary, provider: result.provider, model: result.model, maxTokens: result.maxTokens }
    this.summaryCache.set(key, { result: reusable })
    log('summary-ready', { calls, summaryTokens: estimate(summary[0].text), extraTokens: extra ? estimate(extra) : 0,
      memoryItems: memory.items, pendingTodos: memory.todos, droppedMemoryItems: memory.dropped })
    return final
  }
}

export default CtxoptCompactionEngine

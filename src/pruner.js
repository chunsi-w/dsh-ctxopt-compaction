/**
 * ctxopt 工具结果裁剪器：子类化官方 ToolResultPruner，
 * 只替换 `pruneContent()` 的内容算法（上阶段 R2 SmartDiagnosticTruncatorV2 移植）：
 *   头(保持行对齐) + 指纹去重诊断摘要 + 尾部，代码围栏平衡；
 * 日志 shadow-price 协议、surface 替换、tokenMeter 计费全部沿用宿主的
 * `pruneSession()`，不重复实现。
 * 任何内部不满足"更小且低于阈值"的情况回退官方算法（fail-open）。
 * @module dsh-ctxopt-compaction/pruner
 */

import z from '@deepseek-ai/schemastery'
import { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { codePointLength, smartDiagnosticTruncate } from './text-utils.js'

export class CtxoptToolResultPruner extends ToolResultPruner {
  static inject = ['tokenMeter']

  static Config = z.object({
    thresholdChars: z.number().step(1).min(1).default(8192),
    headChars: z.number().step(1).min(0).default(2048),
    tailChars: z.number().step(1).min(0).default(2048),
    /** 中段诊断摘要预算（指纹去重后按序装入）。 */
    digestChars: z.number().step(1).min(0).default(1536),
    /** 智能诊断截断开关；关闭即回退官方 head/marker/tail 行为。 */
    smartDiagnostic: z.boolean().default(true),
  })

  constructor(ctx, config = {}) {
    // 官方 resolveConfig 严格拒绝未知键——先过滤基础字段再交给 super。
    const parsed = CtxoptToolResultPruner.Config(config)
    const base = {}
    for (const k of ['thresholdChars', 'headChars', 'tailChars']) {
      base[k] = parsed[k]
    }
    super(ctx, base)
    this.ctxoptConfig = parsed
  }

  /**
   * 覆盖官方纯头/尾硬切：单文本块工具结果走智能诊断截断；
   * 复合块或任何异常回退 `super.pruneContent()`（协议不变量由宿主保证）。
   */
  pruneContent(blocks) {
    if (!this.ctxoptConfig.smartDiagnostic) return super.pruneContent(blocks)
    const totalChars = this.measureContent(blocks)
    if (totalChars <= this.config.thresholdChars) return null

    const textBlocks = blocks.filter(b => b.type === 'text')
    // 复合内容（多文本块/图文混合）属于宿主官方实现已覆盖的安全路径，不冒险重排。
    if (textBlocks.length !== 1 || blocks.length !== 1) return super.pruneContent(blocks)

    try {
      const budget = this.config
      const marker = '…[ctxopt 截断]…'
      // 预算 = 头 + 摘要 + 尾 ≤ threshold − marker 余量
      const markerReserve = codePointLength(marker) + 16
      const available = Math.max(1, budget.thresholdChars - markerReserve)
      const head = Math.min(this.ctxoptConfig.headChars, available)
      const digest = Math.min(this.ctxoptConfig.digestChars, Math.max(0, available - head))
      const tail = Math.min(this.ctxoptConfig.tailChars, Math.max(0, available - head - digest))
      const pruned = smartDiagnosticTruncate(textBlocks[0].text, head, digest, tail, marker)
      if (pruned === null) return super.pruneContent(blocks)
      const charsAfter = codePointLength(pruned)
      if (charsAfter >= totalChars || charsAfter > budget.thresholdChars) {
        return super.pruneContent(blocks)
      }
      this.ctx.logger.info(
        `ctxopt smart-prune: ${totalChars} → ${charsAfter} chars (head≈${head} digest≈${digest} tail≈${tail})`,
      )
      return [{ ...textBlocks[0], text: pruned }]
    } catch {
      return super.pruneContent(blocks)
    }
  }
}

export default CtxoptToolResultPruner

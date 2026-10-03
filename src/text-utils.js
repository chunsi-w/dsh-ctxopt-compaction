/**
 * ctxopt 文本工具：锚点抽取、错误指纹聚类、智能诊断截断。
 * 算法分别移植自 ctxopt-lab R4 (pipeline.compact_r4 锚点校验) 与
 * R2 (smart_diagnostic_truncate_v2)，保持规则一致、口径换成字符。
 * @module dsh-ctxopt-compaction/text-utils
 */

/** 诊断行识别（与上阶段 ANOMALY_PATTERN 一致）。 */
export const ANOMALY_PATTERN =
  /(error\[E\d+\]|FAILED|panicked at|Traceback \(most recent|Exception:|ERROR[:\s]|FATAL[:\s]|fatal:|Segmentation fault|AssertionError|context_length_exceeded)/i

/** 指纹归一：动态数字与十六进制地址折叠（上阶段 FINGERPRINT_NORM_RE）。 */
const FINGERPRINT_NORM_RE = /(0x[0-9a-fA-F]+|\d+)/g

export function errorFingerprint(line) {
  return line.trim().replace(FINGERPRINT_NORM_RE, '<N>')
}

/** 提取消息数组中的纯文本。 */
export function messagesText(messages) {
  const parts = []
  for (const m of messages ?? []) {
    for (const b of m.content ?? []) {
      if (b?.type === 'text') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

function blocksTextOf(blocks) {
  return (blocks ?? []).filter(b => b?.type === 'text').map(b => b.text).join('\n')
}
export { blocksTextOf as blocksText }

/** Unicode code point 长度（与宿主 pruner 口径一致）。 */
export const codePointLength = (s) => Array.from(s).length

/**
 * 从会话重放消息中确定性抽取"压缩后也必须保住"的锚点。
 * 返回分类清单，全部有上限，绝不泄露给日志之外的地方。
 */
export function extractAnchors(messages) {
  const text = messagesText(messages.filter(m => m.role !== 'system' && m.source?.kind !== 'compact-checkpoint'))
  const lines = text.split('\n')
  const errors = new Map()  // fingerprint → sample
  const files = new Set()
  const commands = new Set()
  const ids = new Set()
  const prefs = []
  const todos = []
  for (const raw of lines) {
    const line = raw.trim()
    // 跳过超长行（多为复述任务原文/文档），锚点只瞄日志式短行
    if (!line || line.length > 300 || /^#{1,6}\s/.test(line)) continue
    // A mention of "error code" in a question is not a diagnostic. Require a
    // concrete code, a log severity prefix, or a recognizable failure signature.
    const concrete = /\bE\d{2,6}\b|(?:^|\]\s*)(?:ERROR|FATAL)(?::|\s)|FAILED|panicked at|Traceback \(most recent|Exception:|fatal:|Segmentation fault|AssertionError|context_length_exceeded/.test(line)
    if (ANOMALY_PATTERN.test(line) && concrete && errors.size < 6) {
      const fp = errorFingerprint(line)
      if (!errors.has(fp)) errors.set(fp, line.slice(0, 160))
    }
    for (const m of line.matchAll(/[\w./*-]+\.(?:rs|ts|js|py|json|toml|ya?ml|md|go|java|c|h)\b/g)) {
      if (files.size < 6 && m[0].length > 8) files.add(m[0])
    }
    for (const m of line.matchAll(/\b(cargo [\w -]+|npm [\w -]+|pnpm [\w -]+|pytest[\w ./-]*|go test[\w ./-]*|vitest[\w ./-]*)\b/g)) {
      if (commands.size < 4) commands.add(m[0].trim())
    }
    for (const m of line.matchAll(/\b[A-Z]{2,8}-\d{3,6}\b/g)) {
      if (ids.size < 4) ids.add(m[0])
    }
    if (prefs.length < 4 && /(请用中文|用中文回复|Conventional Commits|偏好|必须|不要)/.test(line) && line.length < 200) {
      prefs.push(line)
    }
    // 排除工具状态行（"Updated todo list: N pending..."），只留自然语言待办
    if (todos.length < 5 && !/^updated todo list:/i.test(line)
        && /(待办|TODO|下一步|remaining|next step)/i.test(line) && line.length < 200) {
      todos.push(line)
    }
  }
  return {
    errors: [...errors.values()],
    files: [...files],
    commands: [...commands],
    ids: [...ids],
    prefs,
    todos,
    get any() { return this.errors.length + this.files.length + this.commands.length
      + this.ids.length + this.prefs.length + this.todos.length > 0 },
  }
}

/** 统计文本里字母数字字符数（退化门内容下限，grok patch 0002 语义）。 */
export function alnumCount(text) {
  let n = 0
  for (const ch of text) if (/\p{L}|\p{N}/u.test(ch)) n++
  return n
}

/**
 * 智能诊断截断：头(保持行对齐) + 去重诊断摘要(digest) + 尾(60%)，代码围栏平衡。
 * 移植 ctxopt-lab R2 smart_diagnostic_truncate_v2；字符口径（宿主 pruner 用 code point）。
 * @returns {string | null} 截断结果；行数/预算不足返回 null。
 */
export function smartDiagnosticTruncate(text, headChars, digestChars, tailChars, marker) {
  const lines = text.split('\n')
  if (lines.length <= 3) return null
  const head = [], tail = []
  let headUsed = 0, tailUsed = 0, headIdx = 0, tailIdx = lines.length
  for (; headIdx < lines.length; headIdx++) {
    const line = lines[headIdx], cost = codePointLength(line) + 1
    if (headUsed + cost > headChars) {
      if (head.length === 0 && headChars > 0) head.push(Array.from(line).slice(0, Math.max(0, headChars - 1)).join(''))
      break
    }
    head.push(line); headUsed += cost
  }
  for (; tailIdx > headIdx; tailIdx--) {
    const line = lines[tailIdx - 1], cost = codePointLength(line) + 1
    if (tailUsed + cost > tailChars) {
      if (tail.length === 0 && tailChars > 1) tail.push(Array.from(line).slice(-(tailChars - 1)).join(''))
      break
    }
    tail.push(line); tailUsed += cost
  }
  tail.reverse()
  if (headIdx >= tailIdx) return null
  const clusters = new Map()
  for (let i = headIdx; i < tailIdx; i++) {
    const line = lines[i]
    if (!ANOMALY_PATTERN.test(line)) continue
    const fp = errorFingerprint(line), c = clusters.get(fp)
    if (c) { c.last = i + 1; c.count++ }
    else if (clusters.size < 64) clusters.set(fp, { first: i + 1, last: i + 1, count: 1, sample: line.trim() })
  }
  const digest = []
  let used = 0
  for (const c of clusters.values()) {
    const loc = c.count === 1 ? `line ${c.first}` : `lines ${c.first}..${c.last}, ${c.count}x`
    const prefix = `[${loc}] `
    const remaining = digestChars - used - 1
    if (remaining <= codePointLength(prefix)) break
    const sampleBudget = remaining - codePointLength(prefix)
    const sample = Array.from(c.sample)
    const entry = prefix + (sample.length > sampleBudget ? sample.slice(0, Math.max(0, sampleBudget - 1)).join('') + '…' : c.sample)
    digest.push(entry); used += codePointLength(entry) + 1
  }
  // Fence closers and separators fit in the caller's explicit marker reserve.
  if (head.filter(l => l.trimStart().startsWith('```')).length % 2) head.push('```')
  if (tail.filter(l => l.trimStart().startsWith('```')).length % 2) tail.unshift('```')
  return [...head, marker, ...digest, ...tail].join('\n')
}

/** 退化门：字符数 ≥ 500 且字母数字 ≥ 300（patch 0002 移植）。 */
export function passesDegenerateGate(text) {
  return codePointLength(text) >= 500 && alnumCount(text) >= 300
}

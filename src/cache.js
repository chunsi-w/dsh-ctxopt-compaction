import { createHash } from 'node:crypto'

/** Bounded process-local LRU. Bytes mean UTF-8 serialized payload, not V8 heap. */
export class SummaryCache {
  constructor(config, now = Date.now) {
    this.config = config
    this.now = now
    this.entries = new Map()
    this.bytes = 0
    this.queries = 0
    this.hits = 0
  }

  key(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

  delete(key) {
    const entry = this.entries.get(key)
    if (entry) this.bytes -= entry.bytes
    this.entries.delete(key)
  }

  sweep() {
    for (const [key, entry] of this.entries) if (entry.expires <= this.now()) this.delete(key)
  }

  get(key) {
    if (!this.config.enabled) return undefined
    this.queries++
    this.sweep()
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.hits++
    this.entries.delete(key)
    this.entries.set(key, entry)
    return JSON.parse(entry.json)
  }

  set(key, value, ttlMs = this.config.ttlMs) {
    if (!this.config.enabled || ttlMs === 0) return
    this.sweep()
    this.delete(key)
    const json = JSON.stringify(value)
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(json)
    if (bytes > this.config.maxBytes || this.config.maxEntries === 0) return
    while (this.entries.size >= this.config.maxEntries || this.bytes + bytes > this.config.maxBytes) {
      this.delete(this.entries.keys().next().value)
    }
    this.entries.set(key, { json, bytes, expires: this.now() + ttlMs })
    this.bytes += bytes
  }

  clear() { this.entries.clear(); this.bytes = 0 }
  stats() { this.sweep(); return { hits: this.hits, queries: this.queries, entries: this.entries.size, bytes: this.bytes } }
}

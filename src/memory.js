import { blocksText, codePointLength } from './text-utils.js'

const OPEN = '<ctxopt-memory-v1>'
const CLOSE = '</ctxopt-memory-v1>'
const BLOCK = /<ctxopt-memory-v1>\n([\s\S]*?)\n<\/ctxopt-memory-v1>/g
const KEY = '[a-zA-Z0-9_.-]{1,64}'
const SET = new RegExp(`^(?:MEMORY|记住)\\s+(${KEY})\\s*=\\s*(.+)$`, 'i')
const FORGET = new RegExp(`^(?:FORGET|忘记)\\s+(${KEY})$`, 'i')
const TODO = new RegExp(`^(?:TODO|待办)\\s+(${KEY})\\s*=\\s*(.+)$`, 'i')
const DONE = new RegExp(`^(?:DONE|完成|取消待办)\\s+(${KEY})$`, 'i')

export function stripManagedMemory(text) { return text.replace(BLOCK, '').trim() }

/** Only explicit user directives and our own checkpoint state can change managed memory. */
export function collectMemory(messages, config) {
  const facts = new Map(), todos = new Map()
  const allowed = key => config.allowedKeys.length === 0 || config.allowedKeys.includes(key)
  let dropped = 0
  const put = (map, key, value, limit) => {
    if (!allowed(key) || typeof value !== 'string' || codePointLength(value) > config.maxItemChars || limit === 0) { dropped++; return }
    map.delete(key); map.set(key, value)
    while (map.size > limit) { map.delete(map.keys().next().value); dropped++ }
  }
  for (const message of messages) {
    if (message.source?.kind === 'compact-checkpoint') {
      // Arbitrary assistant text or user-supplied tags cannot impersonate stored state.
      const matches = [...blocksText(message.content).matchAll(BLOCK)]
      const match = matches.at(-1)
      if (!match) continue
      try {
        const state = JSON.parse(match[1])
        for (const [kind, map, limit] of [['facts', facts, config.maxItems], ['todos', todos, config.maxTodos]]) {
          if (!Array.isArray(state[kind])) continue
          for (const entry of state[kind]) {
            if (Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && new RegExp(`^${KEY}$`).test(entry[0])) put(map, entry[0], entry[1], limit)
          }
        }
      } catch (error) { /* A malformed checkpoint block is not restored as managed memory. */ }
      continue
    }
    if (message.role !== 'user' || (message.source && message.source.kind !== 'user')) continue
    let fence = null
    for (const raw of blocksText(message.content).split('\n')) {
      const line = raw.trim()
      const opening = line.match(/^(`{3,}|~{3,})(.*)$/)
      if (opening) {
        const marker = opening[1]
        if (fence === null) fence = marker
        else if (fence[0] === marker[0] && marker.length >= fence.length && opening[2].trim() === '') fence = null
        continue
      }
      if (fence !== null) continue
      if (/^(?:MEMORY RESET|清空记忆)$/i.test(line)) { facts.clear(); todos.clear(); continue }
      let m
      if ((m = line.match(SET))) put(facts, m[1], m[2], config.maxItems)
      else if ((m = line.match(FORGET))) facts.delete(m[1])
      else if ((m = line.match(TODO))) put(todos, m[1], m[2], config.maxTodos)
      else if ((m = line.match(DONE))) todos.delete(m[1])
    }
  }
  return { facts: [...facts], todos: [...todos], dropped }
}

/** Emit whole entries only; newest facts and pending tasks take priority under the token cap. */
export function renderMemory(state, maxTokens, estimate) {
  const kept = { facts: [], todos: [] }
  const render = () => `${OPEN}\n${JSON.stringify(kept)}\n${CLOSE}`
  let dropped = state.dropped
  for (const kind of ['todos', 'facts']) {
    for (const entry of [...state[kind]].reverse()) {
      kept[kind].unshift(entry)
      if (estimate(render()) > maxTokens) { kept[kind].shift(); dropped++ }
    }
  }
  return { text: kept.facts.length || kept.todos.length ? render() : '', dropped, items: kept.facts.length, todos: kept.todos.length }
}

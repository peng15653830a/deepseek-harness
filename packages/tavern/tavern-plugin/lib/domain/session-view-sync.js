import { createHash, randomUUID } from 'node:crypto'

// Reader cursors retain fingerprints only; never retain another full chat snapshot.
export function createSessionViewSync({ maxReaders = 32 } = {}) {
  const readers = new Map()
  function parts(view) {
    const result = new Map()
    function add(path, value) {
      if (value === undefined) return
      const json = JSON.stringify(value)
      result.set(JSON.stringify(path), { path, value, hash: createHash('sha256').update(json).digest('hex') })
    }
    for (const [key, value] of Object.entries(view)) {
      if (key === 'replyProjections' && Array.isArray(value)) {
        add([key, 'length'], value.length)
        value.forEach((row, index) => add([key, index], row))
      } else if (['inputSources', 'inputTemplateDisplays', 'tavernHelper'].includes(key) && value && typeof value === 'object') {
        add([key], {})
        for (const [field, item] of Object.entries(value)) {
          if (key === 'tavernHelper' && field === 'messages' && Array.isArray(item)) {
            add([key, field, 'length'], item.length)
            item.forEach((row, index) => add([key, field, index], row))
          } else add([key, field], item)
        }
      } else add([key], value)
    }
    return result
  }
  return function synchronize(sessionId, view, cursor) {
    if (view === null) return { view: null, viewCursor: null }
    const previous = readers.get(cursor)
    const current = parts(view)
    const nextCursor = randomUUID()
    readers.set(nextCursor, { sessionId, hashes: new Map([...current].map(([key, item]) => [key, item.hash])) })
    while (readers.size > maxReaders) readers.delete(readers.keys().next().value)
    if (!previous || previous.sessionId !== sessionId) return { view, viewCursor: nextCursor }
    const set = [], remove = []
    for (const [key, item] of current) if (previous.hashes.get(key) !== item.hash) set.push([item.path, item.value])
    for (const key of previous.hashes.keys()) if (!current.has(key)) remove.push(JSON.parse(key))
    return { viewCursor: nextCursor, viewDelta: { baseCursor: cursor, set, remove } }
  }
}

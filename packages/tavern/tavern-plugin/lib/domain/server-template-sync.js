/** Coalesce display work without losing a write received during execution. */
export function createServerTemplateSync({ run, onError, delayMs = 250 }) {
  const records = new Map()
  let disposed = false
  function schedule(id, version) {
    if (disposed || !id || id.startsWith('opening:')) return
    let record = records.get(id)
    if (record && record.version === version) return
    if (!record) { record = { version, dirty: true }; records.set(id, record) }
    else { record.version = version; record.dirty = true }
    arm(id, record)
  }
  function arm(id, record) {
    if (disposed || record.timer || record.running) return
    record.timer = setTimeout(async () => {
      record.timer = null; record.running = true; record.dirty = false
      try { if ((await run(id))?.deferred) record.dirty = true }
      catch (error) { onError?.(error) }
      finally {
        record.running = false
        if (record.dirty) arm(id, record)
        // Bound completed-version bookkeeping; never evict queued/running work.
        if (records.size > 256) for (const [key, item] of records) {
          if (records.size <= 256) break
          if (!item.running && !item.timer && key !== id) records.delete(key)
        }
      }
    }, delayMs)
    record.timer.unref?.()
  }
  return { schedule, dispose() { disposed = true; for (const record of records.values()) clearTimeout(record.timer); records.clear() } }
}

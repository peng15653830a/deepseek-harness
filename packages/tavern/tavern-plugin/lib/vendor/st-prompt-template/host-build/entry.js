import { createNativeTemplateConnection } from './native-connection.js'
import { configureTemplateHost, disposeTemplateHost, eventSource, runTemplateCommand, templateCommandNames } from './host.js'

/** This must be loaded in a dedicated disposable frame, once per session. */
export async function initializeTemplatePlugin({ snapshot, callbacks, libraries }) {
  configureTemplateHost(snapshot, callbacks, libraries)
  const initialized = []
  try {
    const { modules } = await import('./upstream-entry.js')
    for (const module of modules) { initialized.push(module); await module.init() }
    if (!globalThis.EjsTemplate?.evalTemplate) throw new Error('Official template exports did not initialize')
    let disposed = false
    let tail = Promise.resolve()
    const run = action => {
      const pending = tail.then(() => {
        if (disposed) throw new Error('Template instance disposed')
        return action()
      })
      tail = pending.catch(() => {})
      return pending
    }
    return {
      version: '1.17.9',
      api: globalThis.EjsTemplate,
      commands: templateCommandNames(),
      emit: (...args) => run(() => eventSource.emit(...args)),
      command: (...args) => run(() => runTemplateCommand(...args)),
      processChatCompletion: ({ messages, type = 'normal' }) => run(async () => {
        if (!Array.isArray(messages) || !messages.length) throw new TypeError('Template request requires messages')
        const request = { messages: structuredClone(messages), type }
        await eventSource.emit('GENERATION_AFTER_COMMANDS', type, {}, false)
        await eventSource.emit('CHAT_COMPLETION_SETTINGS_READY', request)
        return request
      }),
      async dispose() {
        if (disposed) return
        disposed = true
        await tail
        try { for (const module of initialized.reverse()) await module.exit() } finally { disposeTemplateHost() }
      }
    }
  } catch (error) {
    for (const module of initialized.reverse()) { try { await module.exit() } catch {} }
    disposeTemplateHost()
    throw error
  }
}

/** Connect the official plugin to DSH's versioned native state APIs. */
export async function connectTemplateSession({ sessionId, rpc, services, settingsHtml, libraries }) {
  const connection = await createNativeTemplateConnection({ sessionId, rpc, services, settingsHtml })
  const plugin = await initializeTemplatePlugin({ ...connection, libraries })
  try { await connection.flush(); return { ...plugin, context: connection.snapshot } } catch(error) { await plugin.dispose(); throw error }
}

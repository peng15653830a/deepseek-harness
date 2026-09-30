// In-memory host/client patch for DSH 0.2.0-rc.2. Official package files stay unchanged.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join, sep } from 'node:path'

export async function prepareExpandedPatch(runtime, options = {}) {
  const expectedVersion = options.version ?? '0.1.6-alpha.2'
  const marker = 'dsh-tavern/required-session-patch-v1'
  const require = createRequire(join(runtime, 'package.json'))
  const originals = new Map()
  const urls = new Map()
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  // Tavern rollback preserves the original provider, so provider allowlists
  // cannot represent ownership. This experimental profile-wide fix permits
  // citations on replacement only, for every provider; append stays native.
  const own = "(event.surfaceOp?.op === 'replace')"
  async function source(name) {
    const path = require.resolve(name)
    const text = await readFile(path, 'utf8')
    originals.set(path, text)
    return { path, text }
  }
  function once(text, before, after) {
    assert.equal(text.split(before).length, 2, 'Pinned patch target drifted: ' + before)
    return text.replace(before, after)
  }
  async function compile(name, transform = text => text) {
    const { path, text } = await source(name)
    const localRequire = createRequire(path)
    let modified = transform(text)
    modified = modified.replace(/from "([^"]+)"/g, (_, specifier) => {
      const url = urls.get(specifier) ?? (/^(node:|file:|data:)/.test(specifier) ? specifier : pathToFileURL(localRequire.resolve(specifier)).href)
      return 'from ' + JSON.stringify(url)
    })
    // A module compiled into a data URL resolves nothing on its own: dynamic
    // imports of bare specifiers need absolute URLs too (win32 JSONL durability
    // loads koffi this way, which the Windows path alone exercises).
    modified = modified.replace(/import\("([^"]+)"\)/g, (_, specifier) => {
      const url = urls.get(specifier) ?? (/^(node:|file:|data:)/.test(specifier) ? specifier : pathToFileURL(localRequire.resolve(specifier)).href)
      return 'import(' + JSON.stringify(url) + ')'
    })
    modified = modified.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path).href))
    // The compiled copy is a data URL with no map beside it; a sourceMappingURL
    // there is unresolvable and the ESM loader rejects the whole module.
    modified = modified.replace(/^\/\/# sourceMappingURL=.*$/gm, '')
    const url = 'data:text/javascript;base64,' + Buffer.from(modified).toString('base64')
    urls.set(name, url)
    return import(url)
  }
  function facade(name, selectedExports) {
    const text = `export * from ${JSON.stringify(pathToFileURL(require.resolve(name)).href)};\nexport { ${selectedExports.join(', ')} } from ${JSON.stringify(urls.get(name))};`
    urls.set(name, 'data:text/javascript;base64,' + Buffer.from(text).toString('base64'))
  }
  const pkg = JSON.parse(await readFile(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'))
  assert.equal(pkg.version, expectedVersion)
  const { Session } = await load('@deepseek-ai/dsh-session')
  const patchedSurface = await compile('@deepseek-ai/dsh-session/surface', text => once(text,
    "if (event.type === 'assistant/message' && raw !== undefined) {",
    `if (event.type === 'assistant/message' && raw !== undefined && !${own}) {`))
  const surfacePrototype = Object.getPrototypeOf(Session.create('patch-prototype-probe').surface)
  const surfaceDescriptors = Object.fromEntries(['validateNext', '_processDelta'].map(key => [key, Object.getOwnPropertyDescriptor(surfacePrototype, key)]))
  // Append admission, coverage validation, and system-head protection stay native.
  for (const key of Object.keys(surfaceDescriptors)) Object.defineProperty(surfacePrototype, key, Object.getOwnPropertyDescriptor(patchedSurface.SurfaceManager.prototype, key))
  const originalAppend = Session.prototype.append
  const markedSessions = new WeakSet()
  Session.prototype.append = function (type, data, ...args) {
    if (type === 'assistant/message' && args[0]?.surfaceOp?.op === 'replace' && !markedSessions.has(this)) {
      if (!this.snapshotEvents().some(event => event.type === marker)) {
        originalAppend.call(this, marker, { version: 1, hostVersion: pkg.version })
      }
      markedSessions.add(this)
    }
    return originalAppend.call(this, type, data, ...args)
  }
  const restoreSurface = () => {
    Session.prototype.append = originalAppend
    Object.defineProperties(surfacePrototype, surfaceDescriptors)
  }
  try {
    // Stored-event adoption has another bundled copy of the local validator.
    // Cloned storage modules use this copy; the already-live Session service
    // keeps its original identity and the prototype patch above.
    const patchedSession = await compile('@deepseek-ai/dsh-session', text => once(text,
      'if (event.type === "assistant/message" && raw !== void 0) throw',
      `if (event.type === "assistant/message" && raw !== void 0 && !${own}) throw`))
    // Only the in-memory cloned vocabulary understands this required marker.
    // Stock readers refuse the archive instead of treating the edit as a torn tail.
    patchedSession.KNOWN_SESSION_EVENT_TYPES.add(marker)
    // Preserve public class identities: service owners and error consumers
    // imported those classes before this patch. Only validation is replaced.
    facade('@deepseek-ai/dsh-session', ['adoptSessionEvent', 'snapshotSessionEvent', 'foldSurface', 'KNOWN_SESSION_EVENT_TYPES'])
    await compile('@deepseek-ai/dsh-session-persistence', text =>
      `import * as NativeErrors from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence')).href)};\n` +
      text.replace(/\bnew (Session\w+Error)\(/g, 'new NativeErrors.$1(').replace(/\binstanceof (Session\w+Error)\b/g, 'instanceof NativeErrors.$1'))
    facade('@deepseek-ai/dsh-session-persistence', ['validateStoredEvents'])
    await compile('@deepseek-ai/dsh-session-format-v2-to-v3', text => once(text,
      'if (event.type === "assistant/message" && sources !== void 0) throw',
      `if (event.type === "assistant/message" && sources !== void 0 && !${own}) throw`))
    // 0.2 migrates stored v3 journals to v4 on read; teach that migration the
    // tavern marker so history written by the 0.1.5 port still loads, and let
    // tavern's system prompts and greeting/edit narrative messages sit outside
    // an open turn like they always did. The catalog clone compiled below
    // reroutes to this clone via the urls map.
    // v4 also retired the 0.1 `source.kind 'plugin'` wrapper; tavern rows with
    // it (written before this fix, or by a mixed-version install) must still
    // load, so the reader-side refusals are relaxed and classification is left
    // to tavern's own source helpers.
    await compile('@deepseek-ai/dsh-session-format-v3-to-v4', text => once(once(once(once(once(text,
      '\t"workspace/changes"\n]);',
      '\t"workspace/changes",\n\t"dsh-tavern/required-session-patch-v1"\n]);'),
      'if (STEP_EVENT_TYPES.has(event.type)) this.requireStep(event, data);',
      'if (event.type === "developer/message" || event.type === "assistant/attempt") this.requireStep(event, data);'),
      '\t\t\treturn;\n\t\t}\n\t\tthis.requireStep(event, data);',
      '\t\t\treturn;\n\t\t}\n\t\tif (event.type !== "assistant/message") this.requireStep(event, data);'),
      '|| value["kind"] === "plugin") throw new SessionFormatError("format v4 message requires a producer-owned source kind");',
      ') throw new SessionFormatError("format v4 message requires a producer-owned source kind");'),
      'if (isSessionFormatJsonObject(value) && value["kind"] === "plugin") source(message);',
      'if (false) source(message);'))
    const cloneCatalog = await compile('@deepseek-ai/dsh-session-format-catalog')
    const catalog = cloneCatalog.sessionFormatCatalog
    const catalogWithChildren = cloneCatalog.createSessionFormatCatalogWithChildren
    // The migrated generation is verified by a worker thread whose fresh copy
    // of the format packages would refuse tavern's marker and out-of-turn
    // messages. Verify physically in-process instead: the patched restore
    // above already did the full logical validation.
    const { default: PatchedPersistence } = await compile('@deepseek-ai/dsh-session-persistence-jsonl', text => once(text,
      'verifyCurrentFile: verifyCurrentGenerationInWorker,',
      `verifyCurrentFile: async (path, compression, expectedId, expectedEventCount, expectedPrefix, signal) => {
        signal?.throwIfAborted?.();
        const fsp = await import("node:fs/promises");
        const { createHash } = await import("node:crypto");
        const [info, file] = await Promise.all([fsp.stat(path, { bigint: true }), fsp.readFile(path)]);
        const digest = createHash("sha256").update(file).digest("hex");
        return { identity: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(":"), bytes: file.length, digest };
      },`))
    const query = await compile('@deepseek-ai/dsh-session-query', text =>
      `import { SessionQueryError as NativeQueryError } from ${JSON.stringify(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-query')).href)};\n` +
      text.replace(/\bnew SessionQueryError\(/g, 'new NativeQueryError(').replace(/\binstanceof SessionQueryError\b/g, 'instanceof NativeQueryError') +
      '\nexport { SessionCorpus, SessionObservationReader };')
    const { text: originalClient } = await source('@deepseek-ai/dsh-api-session-controller/client')
    const clientSource = once(originalClient,
      'if (event.type === "assistant/message" && raw !== void 0) throw',
      `if (event.type === "assistant/message" && raw !== void 0 && !${own}) throw`)
    const undoPersistence = []
    return {
      catalog, catalogWithChildren, patchedSurface, clientSource, marker,
      patchQuery(instance) {
        assert.equal(instance._observations.cache.size, 0, 'Install before querying Session history')
        for (const [target, prototype] of [
          [instance, query.SessionQueryEngine.prototype],
          [instance._corpus, query.SessionCorpus.prototype],
          [instance._observations, query.SessionObservationReader.prototype],
        ]) {
          const keys = Reflect.ownKeys(prototype).filter(key => key !== 'constructor')
          const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(target, key)]))
          for (const key of keys) Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(prototype, key))
          undoPersistence.push(() => {
            for (const [key, descriptor] of descriptors) {
              if (descriptor) Object.defineProperty(target, key, descriptor)
              else delete target[key]
            }
          })
        }
      },
      patchPersistence(instance) {
        // Existing handles must be closed before this experimental installation.
        // Install own methods on ONE backend instance, not its shared prototype.
        assert.equal(instance.tracker.openHandles.size, 0, 'Install before opening Session handles')
        assert.equal(instance.tracker.writers.size, 0, 'Install before acquiring Session writers')
        const keys = Reflect.ownKeys(PatchedPersistence.prototype).filter(key => key !== 'constructor')
        const descriptors = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(instance, key)]))
        const format = instance.generationFormat
        for (const key of keys) Object.defineProperty(instance, key, Object.getOwnPropertyDescriptor(PatchedPersistence.prototype, key))
        instance.generationFormat = {
          ...format,
          currentVersion: catalog.currentVersion,
          createRestore: header => catalog.createRestore(header, { recovery: 'strict', validation: 'current' }),
          encodeHeader: (header, count) => catalog.encodeCurrentHeader(header, count),
          encodeEvent: event => catalog.encodeCurrentEvent(event),
        }
        instance.coldLogMemo.clear()
        undoPersistence.push(() => {
          for (const [key, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(instance, key, descriptor)
            else delete instance[key]
          }
          instance.generationFormat = format
          instance.coldLogMemo.clear()
        })
      },
      async verifyFilesUnchanged() {
        const hashes = []
        for (const [path, text] of originals) {
          assert.equal(await readFile(path, 'utf8'), text)
          hashes.push({ packageFile: path.split('/node_modules/').at(-1), sha256: createHash('sha256').update(text).digest('hex') })
        }
        return hashes
      },
      dispose() {
        for (const undo of undoPersistence.reverse()) undo()
        restoreSurface()
      },
    }
  } catch (error) {
    restoreSurface()
    throw error
  }
}

export const SESSION_PATCH_PROTOCOL = 1
export const SESSION_PATCH_VERSION = '0.2.0-rc.2'
const INSTALLED = Symbol.for('dsh-tavern.host-session-patch.v1')
const PINNED_SHA256 = Object.freeze({
  '@deepseek-ai/dsh-session/surface': '7e9d4bd3b7c5b2eceed0f8b035e9c021237c72baa2b53e4c6fc941e8b417580e',
  '@deepseek-ai/dsh-session': '87ea85e2fb5318bf1f826db9a1c88c1b26d3ea328027a7f32b211880c4d62b9d',
  '@deepseek-ai/dsh-session-persistence': 'cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb',
  '@deepseek-ai/dsh-session-format-v2-to-v3': '0dc56fb447e9046fc25995bcd08dbac26e832eba6e9eb583ef49d26467c27cd7',
  '@deepseek-ai/dsh-session-format-v3-to-v4': '382a3f28b95e0b9504969ac6f407f909aef0ba4699c3175d36c0ef91b31cfde2',
  '@deepseek-ai/dsh-session-format-catalog': '836bbb772ab505c299f1a4a246164c50c7c08b67ab0d17f1251d7ea2cd8c1818',
  '@deepseek-ai/dsh-session-persistence-jsonl': '0845707017acc2b4a8a75eab2244fa3fd88587b8094ab32014321dce7ca1e31b',
  '@deepseek-ai/dsh-session-query': 'dd8056fad008063c7e85169d4306720abe8efa6b32eac98f1b3053c6f89894aa',
  '@deepseek-ai/dsh-api-session-controller/client': '60ec6a006443b40e5ab718f3fa53c301559c5c28427ca650c3851127ce370d43',
})

function hostRequireFrom(anchor) {
  const fromAnchor = createRequire(anchor)
  const hostAnchored = (() => {
    try { return createRequire(fromAnchor.resolve('@deepseek-ai/dsh-tools')) } catch { return undefined }
  })()
  // A packaged host keeps every DSH package in one node_modules, so anchoring on
  // dsh-tools reaches them all. A workspace checkout links each package's own
  // dependencies instead, so that scope may miss the session packages and the
  // anchor itself (the plugin) wins.
  if (hostAnchored !== undefined) {
    try { hostAnchored.resolve('@deepseek-ai/dsh-session-persistence'); return hostAnchored } catch { /* fall through */ }
  }
  return fromAnchor
}

// The plugin file lives in this repo. The running host packages live next to
// the dsh launcher. Pick the copy that actually constructed the live store.
async function defaultHostRequire(persistence) {
  const anchors = [fileURLToPath(new URL('../../package.json', import.meta.url))]
  if (process.argv[1]) anchors.push(process.argv[1])
  const found = []
  const errors = []
  for (const anchor of anchors) {
    try { found.push(hostRequireFrom(anchor)) }
    catch (error) { errors.push(error) }
  }
  if (!found.length) throw errors.at(-1) || new Error('无法解析宿主包')
  if (!persistence) return found[0]
  for (const candidate of found) {
    const loaded = await import(pathToFileURL(candidate.resolve('@deepseek-ai/dsh-session-persistence')).href)
    if (Object.values(loaded).some(exported => typeof exported === 'function' && persistence instanceof exported)) return candidate
  }
  throw new Error('解析到的宿主包与正在运行的会话存储不是同一份')
}

function runtimeRoot(sessionFile) {
  const parts = sessionFile.split(sep)
  const index = parts.lastIndexOf('node_modules')
  if (index > 0) return parts.slice(0, index).join(sep)
  // A workspace checkout links the host packages without a node_modules segment,
  // so the plugin directory — which declares them — is the resolution root.
  return fileURLToPath(new URL('../../', import.meta.url))
}

function createHandle(fields) {
  const handle = {
    protocol: SESSION_PATCH_PROTOCOL,
    status: fields.status,
    serverReady: fields.status === 'ready',
    clientReady: false,
    hostVersion: fields.hostVersion || '',
    reason: fields.reason || '',
    clientReason: '',
    clientSource: fields.clientSource || '',
    confirmClient(report = {}) {
      if (this.status !== 'ready') return
      if (report.protocol !== SESSION_PATCH_PROTOCOL || report.installed !== true) {
        this.clientReady = false
        this.clientReason = report.reason || '客户端会话补丁没有装上'
        return
      }
      this.clientReady = true
      this.clientReason = ''
    },
    replacementAllowed() {
      return this.status === 'skipped' || (this.serverReady && this.clientReady)
    },
    blockReason() {
      if (this.status === 'failed') return this.reason
      if (this.serverReady && !this.clientReady) return this.clientReason || '页面尚未完成会话补丁握手，请刷新后再试'
      return this.reason || '会话补丁未就绪'
    },
    view() {
      const waitingForClient = this.serverReady && !this.clientReady
      return {
        protocol: this.protocol,
        status: this.status,
        ready: this.replacementAllowed(),
        serverReady: this.serverReady,
        clientReady: this.clientReady,
        hostVersion: this.hostVersion,
        reason: waitingForClient ? this.blockReason() : this.reason,
      }
    },
  }
  return handle
}

export async function installHostSessionPatch({ hostRequire, persistence, query } = {}) {
  let require
  try { require = hostRequire || await defaultHostRequire(persistence) }
  catch (error) {
    return createHandle({ status: 'failed', reason: '无法解析宿主 DSH 包：' + (error.message || error) })
  }
  let hostVersion = ''
  try {
    hostVersion = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version || ''
  } catch (error) {
    return createHandle({ status: 'failed', reason: '无法读取宿主 Session 版本：' + (error.message || error) })
  }
  const loadSessionCatalog = async () => {
    const loaded = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
    return loaded.sessionFormatCatalog
  }
  const finish = fields => Object.assign(createHandle(fields), { loadSessionCatalog })
  if (hostVersion !== SESSION_PATCH_VERSION) return finish({ status: 'skipped', hostVersion })
  if (persistence?.[INSTALLED]) {
    const installed = persistence[INSTALLED]
    if (!installed.loadSessionCatalog) installed.loadSessionCatalog = loadSessionCatalog
    return installed
  }
  for (const [name, expected] of Object.entries(PINNED_SHA256)) {
    let actual = ''
    try { actual = createHash('sha256').update(readFileSync(require.resolve(name))).digest('hex') }
    catch (error) {
      return finish({ status: 'failed', hostVersion, reason: '无法校验宿主文件 ' + name + '：' + (error.message || error) })
    }
    if (actual !== expected) return finish({ status: 'failed', hostVersion, reason: '宿主文件与 0.2.0-rc.2 补丁清单不一致：' + name })
  }
  if (!persistence?.tracker?.openHandles || !persistence?.tracker?.writers) {
    return finish({ status: 'failed', hostVersion, reason: '宿主没有 JSONL 会话存储，不能安装补丁' })
  }
  if (persistence.tracker.openHandles.size || persistence.tracker.writers.size) {
    return finish({ status: 'failed', hostVersion, reason: '会话已经打开，不能热替换。请重启后再使用正文编辑、回退和重新生成。' })
  }
  if (!query?._observations?.cache || !query?._corpus) {
    return finish({ status: 'failed', hostVersion, reason: '宿主会话查询尚未就绪，不能安装补丁' })
  }
  if (query._observations.cache.size) {
    return finish({ status: 'failed', hostVersion, reason: '会话查询缓存已经建立，不能安装补丁。请重启后再试。' })
  }
  let patch
  try {
    patch = await prepareExpandedPatch(runtimeRoot(require.resolve('@deepseek-ai/dsh-session')), { version: SESSION_PATCH_VERSION })
    patch.patchPersistence(persistence)
    patch.patchQuery(query)
  } catch (error) {
    try { patch?.dispose() } catch { /* The installer already restored what it changed. */ }
    return finish({ status: 'failed', hostVersion, reason: '会话补丁安装失败：' + (error.message || error) })
  }
  const handle = finish({ status: 'ready', hostVersion, clientSource: patch.clientSource })
  handle.dispose = () => patch.dispose()
  Object.defineProperty(persistence, INSTALLED, { value: handle })
  return handle
}

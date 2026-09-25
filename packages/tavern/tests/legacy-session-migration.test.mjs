import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { accessSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { repairMigratedCurrentHeader, decodeSessionLog, encodeCurrentGeneration, encodeMigratedSessionLog, migrateInstalledLegacySessions, migrateLegacySessionDirectory, prepareLegacySessionLog, reframeConcatenatedSessionLog } from '../tavern-plugin/lib/domain/legacy-session-migration.js'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'

test('迁移日志的第一帧只有文件头一行', () => {
  const header = '{"version":0,"id":"a"}'
  const events = [{ type: 'step/start', seq: 0 }]
  const bytes = encodeMigratedSessionLog(header, events)
  const text = header + '\n' + JSON.stringify(events[0]) + '\n'
  assert.equal(headerFrameText(bytes), header + '\n')
  assert.equal(decodeSessionLog(bytes), text)
  const collapsed = zstdCompressSync(Buffer.from(text), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const fixed = reframeConcatenatedSessionLog(collapsed)
  assert.equal(headerFrameText(fixed), header + '\n')
  assert.equal(decodeSessionLog(fixed), text)
  assert.equal(reframeConcatenatedSessionLog(bytes), null)
})

test('启动迁移走宿主目录，会话在 data 的上一级', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'tavern-startup-migration-'))
  const dataRoot = path.join(root, 'profile-data', 'tavern', 'data')
  await mkdir(path.join(root, 'profile-data', 'tavern', 'sessions'), { recursive: true })
  let calls = 0
  const summary = await migrateInstalledLegacySessions(dataRoot, async () => {
    calls += 1
    return { createRestore() { throw new Error('空目录不应打开会话') } }
  })
  assert.equal(calls, 1)
  assert.deepEqual(summary, { seen: 0, migrated: 0, unchanged: 0, refused: 0 })
})

const hostRoot = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai'
const archiveRoot = path.join(process.env.HOME, '.dsh-tavern/profile-data/tavern/sessions')
const hostReady = readable(path.join(hostRoot, 'dsh-session/package.json'))
const archiveReady = readable(archiveRoot)

test('存档副本迁移后能用 0.1.5-rc.2 打开，原档不变', { skip: !hostReady || !archiveReady, timeout: 180000 }, async t => {
  const require = createRequire(path.join(hostRoot, 'dsh-session/package.json'))
  const version = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8')).version
  assert.equal(version, '0.1.5-rc.2')
  const { sessionFormatCatalog } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
  const allSources = await walk(archiveRoot)
  const sources = allSources.filter(file => path.basename(file) === 'session.jsonl.zstd')
  const generations = allSources.filter(file => ['session.jsonl.zstd','session.v3.jsonl.zstd'].includes(path.basename(file)))
  assert.ok(sources.length > 0)
  const sourceHashes = new Map(await Promise.all(sources.map(async file => [file, hash(await readFile(file))])))
  const copyRoot = await mkdtemp(path.join(tmpdir(), 'tavern-legacy-sessions-'))
  t.after(() => rm(copyRoot, { recursive: true, force: true }))
  await cp(archiveRoot, copyRoot, { recursive: true })
  // Re-exercise migration even when the live profile has already migrated.
  for (const source of sources) {
    const copied = path.join(copyRoot, path.relative(archiveRoot, source))
    if (readable(copied + '.bak-tavern-premigrate')) await cp(copied + '.bak-tavern-premigrate', copied)
    await rm(path.join(path.dirname(copied), 'session.v3.jsonl.zstd'), { force: true })
  }
  const summary = await migrateLegacySessionDirectory(copyRoot, sessionFormatCatalog)
  assert.ok(summary.migrated > 0, '没有任何副本完成迁移')
  const copies = (await walk(copyRoot)).filter(file => path.basename(file) === 'session.jsonl.zstd')
  let reopened = 0
  for (const file of copies) {
    const bytes = await readFile(file)
    const prepared = prepareLegacySessionLog(decodeSessionLog(bytes), sessionFormatCatalog)
    if (!prepared.ok) {
      const backup = file + '.bak-tavern-premigrate'
      assert.equal(readable(backup), false)
      continue
    }
    assert.equal(prepared.changed, false)
    assert.equal(prepared.artifact.header.version, 3)
    reopened += 1
    if (readable(file + '.bak-tavern-premigrate')) {
      const backupText = decodeSessionLog(await readFile(file + '.bak-tavern-premigrate'))
      const original = prepareLegacySessionLog(backupText, sessionFormatCatalog)
      assert.equal(original.ok, true)
      assert.equal(original.artifact.header.version, 3)
    }
  }
  assert.ok(reopened > 0)
  // v3-only archives also participate in header repair; do not count them as v0 reopens.
  assert.equal(summary.seen, summary.migrated + summary.unchanged + summary.refused)
  for (const [file, digest] of sourceHashes) assert.equal(hash(await readFile(file)), digest)
  assert.equal(summary.seen, new Set(generations.map(file=>path.dirname(file))).size)
})

function headerFrameText(bytes) {
  const frames = []
  let offset = 0
  const start = offset
  offset += 4
  const descriptor = bytes.readUInt8(offset)
  offset += 1
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? singleSegment ? 1 : 0 : 1 << contentSizeFlag
  offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  for (;;) {
    const blockHeader = bytes.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    offset += blockType === 1 ? 1 : blockSize
    if (lastBlock) break
  }
  if (checksum) offset += 4
  frames.push({ start, end: offset })
  return zstdDecompressSync(bytes.subarray(frames[0].start, frames[0].end)).toString('utf8')
}

function readable(file) {
  try { accessSync(file); return true } catch { return false }
}

function hash(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) await walk(target, files)
    else files.push(target)
  }
  return files
}


test('发布的 v3 文件头必须能被宿主列表读取', {skip:!hostReady}, async()=>{
 const require=createRequire(path.join(hostRoot,'dsh-session/package.json'))
 const {sessionFormatCatalog:catalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
 const header={version:3,id:'test-migrated',createdAt:1,cwd:'/tmp/test',isSeeded:false,delegationDepth:0,agentPreset:'tavern'}
 const bytes=encodeCurrentGeneration({header,events:[],inheritedEventCount:0},catalog)
 const stored=JSON.parse(decodeSessionLog(bytes).trim())
 assert.equal(catalog.readHeader(stored).status,'current')
 assert.equal(stored.type,'session')
})


test('修复已存在的错误 v3 头，保留备份并可重复执行', {skip:!hostReady}, async t=>{
 const require=createRequire(path.join(hostRoot,'dsh-session/package.json'))
 const {sessionFormatCatalog:catalog}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-format-catalog')).href)
 const root=await mkdtemp(path.join(tmpdir(),'tavern-header-repair-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const file=path.join(root,'session.v3.jsonl.zstd')
 const header={version:3,id:'test-migrated',createdAt:1,cwd:'/tmp/test',isSeeded:false,delegationDepth:0,agentPreset:'tavern'}
 const original=encodeMigratedSessionLog(JSON.stringify(header),[])
 await writeFile(file,original)
 const result=await migrateLegacySessionDirectory(root,catalog)
 assert.equal(result.migrated,1)
 assert.equal(catalog.readHeader(JSON.parse(decodeSessionLog(await readFile(file)).trim())).status,'current')
 assert.deepEqual(await readFile(file+'.bak-tavern-header'),original)
 assert.equal(await repairMigratedCurrentHeader(file,catalog),false)
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

test('宿主 MVU 不提示或执行旧变量清理，即使旧设置已开启；保留变量恢复', async () => {
  const root = new URL('../tavern-plugin/lib/vendor/magvarupdate/', import.meta.url)
  const dir = await mkdtemp(join(tmpdir(), 'mvu-cleanup-test-'))
  try {
    await cp(new URL('upstream/', root), dir, { recursive: true })
    execFileSync(process.execPath, [new URL('host-build/prepare-host-build.mjs', root).pathname, join(dir, 'webpack.config.ts')])
    const chat = Array.from({ length: 40 }, () => ({ swipes: ['正文'], variables: [{ stat_data: { hp: 10 }, schema: {}, initialized_lorebooks: [] }] }))
    const before = JSON.stringify(chat)
    const unexpected = () => assert.fail('清理不应弹窗、写入或提示成功')
    const context = vm.createContext({
      SillyTavern: { chat, callGenericPopup: unexpected, POPUP_TYPE: { CONFIRM: 'confirm' } }, saveChatDebounced: unexpected,
      useDataStore: () => ({ settings: { 自动清理变量: { 启用: true, 要保留变量的最近楼层数: 10, 快照保留间隔: 50 } } }),
      tr: value => value, toastr: { info: unexpected },
    })
    vm.runInContext(await readFile(new URL('../runtime-assets/lodash/lodash.min.js', root), 'utf8'), context)
    for (const file of ['cleanup_variables.ts', 'legacy_chat.ts']) {
      const source = await readFile(join(dir, 'src/function/cleanup', file), 'utf8')
      vm.runInContext(stripTypeScriptTypes(source.replace(/^import .*;\n/gm, '').replaceAll('export ', '')), context)
    }
    await vm.runInContext('checkAndCleanupLegacyChat()', context)
    vm.runInContext('cleanupMessageVariables(1, 29, 50)', context)
    assert.equal(JSON.stringify(chat), before)
    const cleanup = await readFile(join(dir, 'src/function/cleanup/index.ts'), 'utf8')
    assert.match(cleanup, /debounce\(restoreVariables, 2000\)/)
    const panel = await readFile(join(dir, 'src/panel/Cleanup.vue'), 'utf8')
    assert.match(panel, /暂不支持旧变量清理/)
    assert.doesNotMatch(panel, /v-model/)
    const buttons = await readFile(join(dir, 'src/button.ts'), 'utf8')
    assert.doesNotMatch(buttons, /name: '清除旧楼层变量'/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

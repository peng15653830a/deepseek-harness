import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { adaptedDshVersion, assertCompatibleDshVersion, dshCompatibilityNotice } from '../bin/dsh-compatibility.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const unix = await readFile(new URL('../install.sh', import.meta.url), 'utf8')
const windows = await readFile(new URL('../install.ps1', import.meta.url), 'utf8')

test('README、安装提示和独立版本查询使用同一适配版本', async () => {
  const config = JSON.parse(await readFile(new URL('../config/dsh-compatibility.json', import.meta.url), 'utf8'))
  assert.equal(adaptedDshVersion, config.adaptedDshVersion)
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(readme.includes('`' + adaptedDshVersion + '`'))
  assert.ok(readme.includes('https://github.com/anywhere-labs/dsh-desktop/releases'))
  const result = spawnSync(process.execPath, ['bin/dsh-compatibility.mjs', '--version'], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), adaptedDshVersion)
})

test('所有平台仅允许完全匹配的 DSH 版本', () => {
  for (const host of ['cli', 'desktop', 'android']) {
    assert.doesNotThrow(() => assertCompatibleDshVersion(adaptedDshVersion, host))
    for (const version of ['', '0.1.1-rc.2', '0.1.5-rc.1', '99.0.0']) {
      assert.throws(() => assertCompatibleDshVersion(version, host), error => {
        assert.match(error.message, /必须使用/)
        assert.ok(error.message.includes(adaptedDshVersion))
        if (host !== 'cli') { assert.match(error.message, /已停止安装/); assert.match(error.message, /https:\/\/github.com\//) }
        return true
      })
    }
  }
})

test('两平台都在下载源码后读取适配版本，DSH 下载交给共享安装模块', () => {
  assert.ok(unix.indexOf('ADAPTED_DSH_VERSION=$(node') > unix.indexOf('[ -f "${SOURCE_DIR}/package.json" ]'))
  assert.ok(windows.indexOf('$AdaptedDshVersion = (& node') > windows.indexOf("Join-Path $SourceDir.FullName 'package.json'"))
  assert.doesNotMatch(unix + windows, /@deepseek-ai\/dsh["']/)
})

test('Unix 工具准备只处理 pnpm，不提前复用或更换 DSH', { skip: process.platform === 'win32' }, () => {
  const start = unix.indexOf('# Read the downloaded release')
  const end = unix.indexOf('if [ "${INSTALL_HOST}" = "cli" ] && [ -f', start)
  assert.ok(start >= 0 && end > start)
  const block = unix.slice(start, end)
  // Run the real shell branch while replacing all installation/filesystem effects.
  const mocks = `
command() {
  case "$2" in
    dsh) test "$HAS_DSH" = 1 ;;
    pnpm) test "$HAS_PNPM" = 1 ;;
    *) return 1 ;;
  esac
}
pnpm() {
  if [ "$HAS_PNPM" = 1 ]; then printf '%s\n' "$MOCK_PNPM_VERSION"; else return 127; fi
}
mkdir() { :; }
npm() { printf 'INSTALL:%s\\n' "$*"; HAS_DSH=1; HAS_PNPM=1; }
fail() { printf 'FAIL:%s\\n' "$1"; exit 1; }
`
  for (const row of [
    { host: 'cli', dsh: '0', pnpm: '0', packages: ['pnpm@11.25.0'] },
    { host: 'cli', dsh: '0', pnpm: '1', packages: [] },
    { host: 'cli', dsh: '1', pnpm: '0', packages: ['pnpm@11.25.0'] },
    { host: 'cli', dsh: '1', pnpm: '1', pnpmVersion: '12.3.4', packages: ['pnpm@11.25.0'] },
    { host: 'cli', dsh: '1', pnpm: '1', packages: [] },
    { host: 'desktop', dsh: '1', pnpm: '1', packages: [] }
  ]) {
    const result = spawnSync('sh', ['-ec', mocks + block], { encoding: 'utf8', env: {
      ...process.env, SOURCE_DIR: root, RUNTIME_ROOT: '/unused-mocked-runtime',
      INSTALL_HOST: row.host, HAS_DSH: row.dsh, HAS_PNPM: row.pnpm,
      PNPM_VERSION: '11.25.0', MOCK_PNPM_VERSION: row.pnpmVersion || '11.25.0'
    } })
    assert.equal(result.status, 0, result.stderr + result.stdout)
    const installed = result.stdout.split('\n').filter(line => line.startsWith('INSTALL:'))
    assert.deepEqual(installed, row.packages.length ? ['INSTALL:install --global --prefix /unused-mocked-runtime ' + row.packages.join(' ')] : [])
  }
})


test('Desktop 和 DSHA 各有一个明确适配版本，提示与安装文档包含下载入口', async () => {
  const config = JSON.parse(await readFile(new URL('../config/dsh-compatibility.json', import.meta.url), 'utf8'))
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const manual = await readFile(new URL('../docs/index.html', import.meta.url), 'utf8')
  for (const [host, version, url] of [
    ['desktop', config.recommendedDesktopVersion, config.desktopReleasesUrl],
    ['android', config.recommendedDshaVersion, config.dshaReleasesUrl],
  ]) {
    assert.equal(typeof version, 'string')
    for (const text of [dshCompatibilityNotice('99.0.0', host), readme, manual]) {
      assert.ok(text.includes(version))
      assert.ok(text.includes(url))
    }
  }
  const android = await readFile(new URL('../docs/android-install.md', import.meta.url), 'utf8')
  assert.ok(android.includes(config.recommendedDshaVersion))
  assert.ok(android.includes(config.dshaReleasesUrl))
})

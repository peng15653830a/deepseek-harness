import { defineConfig } from 'tsdown'
import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'

function isBuildFaceClient(value: unknown): boolean {
  if (value === undefined || value === 'host') return false
  if (value === 'client') return true
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/**
 * The ordinary workspace build consumes JavaScript emitted by the Host
 * TypeScript project and runs Typert. The Client pass selects packages that
 * declare a browser bundle and lets their package-local configs emit both
 * their Node loader entry and browser artifact.
 *
 * `packages/tavern/tavern-plugin` is excluded: its host and client halves are
 * hand-owned prebuilt ESM (`lib/*.js`), not TypeScript emit, so the bundler
 * has no entry to build for it. `packages/tavern/image-gen` is excluded for
 * the same reason as a mixed-face package: it builds through its own package
 * scripts once the client face has produced the sibling type declarations.
 * `packages/tavern/presets` and `packages/tavern/tests` are the ported
 * subtree's presets and test fixtures: they ship no package.json, so the
 * `packages/<group>/<package>` glob would otherwise adopt them as members and
 * apply the default entry, which resolves no file inside a directory holding
 * no sources. The same holds for `packages/tavern/bin`, the subtree's
 * launcher scripts restored from the Tavern upstream.
 */
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: client
      ? ['vendor/*', 'packages/*/*', '!packages/tavern/tavern-plugin', '!packages/tavern/image-gen', '!packages/tavern/presets', '!packages/tavern/tests', '!packages/tavern/bin', '!packages/tavern/config', '!packages/tavern/references', 'apps/cli']
      : ['vendor/*', 'packages/*/*', '!packages/tavern/tavern-plugin', '!packages/tavern/image-gen', '!packages/tavern/presets', '!packages/tavern/tests', '!packages/tavern/bin', '!packages/tavern/config', '!packages/tavern/references', 'apps/cli', 'apps/desktop', 'apps/desktop-host'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})

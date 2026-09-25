// Native integration tests exercise the same fixed-version Session patch as Tavern.
// The dedicated installer test verifies unpatched rejection and installation itself.
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { prepareExpandedPatch } from '../../tavern-plugin/lib/domain/host-session-patch.js'
if (process.env.DSH_BOOT_MODULE && !process.argv.some(arg => arg.endsWith('/host-session-patch.test.mjs'))) {
  const anchor = new URL('../../dsh-session/package.json', pathToFileURL(process.env.DSH_BOOT_MODULE))
  const require = createRequire(anchor)
  const version = require('@deepseek-ai/dsh-session/package.json').version
  if (version === '0.1.5-rc.2') await prepareExpandedPatch(new URL('../../../', anchor).pathname, { version })
}

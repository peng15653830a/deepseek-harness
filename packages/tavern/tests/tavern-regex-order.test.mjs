import test from 'node:test'
import assert from 'node:assert/strict'
import { composeTavernRegexScripts } from '../tavern-plugin/lib/domain/card-extension-reading.js'
import { projectReplyLayers } from '../tavern-plugin/lib/domain/reply-presentation.js'

const rule = (name, findRegex, replaceString) => ({ name, findRegex, replaceString, enabled: true, placement: [2], markdownOnly: true })
test('global and preset transformations precede character HTML expansion, including pinned scripts', () => {
  const global = rule('global', 'seed', 'story')
  const preset = rule('preset', 'story', 'ready')
  const card = rule('card', 'ready', '<div>' + 'x'.repeat(380000) + '</div>')
  const extensions = { globalRegexScripts: [{ ...global, replaceString: 'unresolved' }], regexScripts: [global, card] }
  const scripts = composeTavernRegexScripts(extensions, [preset])
  assert.deepEqual(scripts, [global, preset, card])
  assert.equal(projectReplyLayers('seed', { regexScripts: scripts, placement: 2 }).displayText, card.replaceString)
  assert.deepEqual(extensions.regexScripts, [global, card])
})
test('legacy card-only extensions preserve internal order and allow absent groups', () => {
  const a = rule('a', 'a', 'b'), b = rule('b', 'b', 'c'), p = rule('p', 'p', 'a')
  assert.deepEqual(composeTavernRegexScripts({ regexScripts: [a,b] }, [p]), [p,a,b])
  assert.deepEqual(composeTavernRegexScripts(null, [p]), [p])
})

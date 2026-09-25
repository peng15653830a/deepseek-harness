import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../tavern-plugin/src/client/interaction-diagnostics.js', import.meta.url), 'utf8')
function fixture() {
  let now = 1000000, hit, active;
  function events() {
    const handlers = new Map()
    return { handlers, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name), emit(name, event = {}) { handlers.get(name)?.(event) } }
  }
  const editor = { tagName: 'DIV', isContentEditable: true, closest: selector => selector.includes('data-composer') ? editor : null, contains: item => item === editor, getBoundingClientRect: () => ({ left: 10, top: 10, right: 100, bottom: 100 }) }
  hit = editor; active = editor
  const doc = { ...events(), visibilityState: 'visible', hasFocus: () => true, get activeElement() { return active }, querySelector: selector => selector.includes('data-composer') ? editor : null, elementFromPoint: () => hit }
  const timers = new Map(); let id = 0
  const win = { ...events(), document: doc, getComputedStyle: () => ({ pointerEvents: 'auto' }), setTimeout(fn) { timers.set(++id, fn); return id }, clearTimeout: id => timers.delete(id) }
  const create = vm.runInNewContext(source + ';createInteractionDiagnostics', { Date: { now: () => now } })
  const recorder = create(win)
  return { win, doc, recorder, timers, advance: ms => { now += ms }, block() { hit = { tagName: 'DIV', textContent: 'PRIVATE', id: 'SECRET', closest: () => null }; active = hit } }
}
test('records obstruction and delayed focus without content, then disposes listeners', () => {
  const f = fixture(); const dispose = f.recorder.start(); f.block()
  f.doc.emit('pointerdown', { clientX: 20, clientY: 20, key: 'PRIVATE' })
  for (const [id, fn] of f.timers) { f.timers.delete(id); fn() }
  const rows = f.recorder.snapshot().events
  assert.equal(rows[1].blocked, true)
  assert.equal(rows[1].target, 'other')
  assert.equal(rows[2].composerFocused, false)
  f.win.emit('error', { message: 'SECRET', filename: 'https://private/?token=SECRET' })
  assert.doesNotMatch(JSON.stringify(f.recorder.snapshot()), /SECRET|PRIVATE|token/)
  dispose(); assert.equal(f.doc.handlers.size + f.win.handlers.size + f.timers.size, 0)
})
test('caps records at 120 and drops entries older than ten minutes', () => {
  const f = fixture(); f.recorder.start()
  for (let i = 0; i < 200; i++) { f.advance(1); f.win.emit('focus', { target: f.win }) }
  assert.equal(f.recorder.snapshot().events.length, 120)
  f.advance(600001); assert.equal(f.recorder.snapshot().events.length, 0)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { Session } from './fixtures/dsh-session-host.mjs'
import { createBodyEditor, synchronizeBodyEdits } from '../tavern-plugin/lib/domain/body-editor.js'
import { editableReplyParts, projectReplyLayers, projectReplyHistory } from '../tavern-plugin/lib/domain/reply-presentation.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { sessionEvents, appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'

function fixture(text = '原正文', seeded = false) {
  let session = Session.create('body-edit-test')
  appendSessionEvent(session, 'user/message', { id: 'user', role: 'user', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', { turn: 2, step: 1, message: { id: 'reply', role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'fixture', model: 'fixture' } } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  if (seeded) session = Session.create(session.id, sessionEvents(session), { ...session.header, isSeeded: true }, session.seq)
  let chat = { id: 'chat', sessionId: session.id, mode: 'story', _storageRevision: 1, messages: [{ role: 'user', text: '继续' }, { role: 'assistant', turn: 2, text, sourceText: text, swipes: [text], swipeId: 0, variables: [{ hp: 9 }] }], settleStatus: 'done', posture: '原状态', scriptState: { cursor: 5 }, variables: { hp: 9 } }
  const agent = { get session() { return session }, phase: { kind: 'idle', lastTurn: 2 } }
  let busy = false, failWrite = false, failFlush = false
  const options = {
    chats: { forSession: async () => structuredClone(chat), update: async (_id, fn) => { if (failWrite) throw Error('write failed'); chat = fn(structuredClone(chat)); chat._storageRevision++; return structuredClone(chat) } },
    sessions: { get: () => agent, flush: async () => { if (failFlush) throw Error('flush failed') } },
    timeline: createStoryTimeline(), activity: () => ({ busy }), project: async text => projectReplyLayers(text), present: async chat => chat
  }
  return { editor: createBodyEditor(options), get chat() { return chat }, get session() { return session }, agent, options,
    busy(value) { busy = value }, failWrite(value) { failWrite = value }, failFlush(value) { failFlush = value },
    restore(events = sessionEvents(session)) { session = Session.create(session.id, events, session.header) },
    change(fn) { fn(chat) } }
}

test('lossless text ranges retain raw and fenced HTML, CRLF and code examples', () => {
  for (const text of ['前文\n<div><script>let a=1</script>内容</div>\n后文', '前文\r\n```html\r\n<div>x</div>\r\n```\r\n后文', '前文\n~~~html\n<b>x</b>\n~~~\n后文', '文字 `<b>`\n```js\nconst x="<b>"\n```']) {
    assert.equal(editableReplyParts(text).map(part => part.text).join(''), text)
  }
})

test('edit replaces native Surface and display, preserving events, variables, state and HTML', async () => {
  const html = '\n```html\n<div>保留 HTML</div>\n```\n'
  const h = fixture('旧文本' + html + '结尾')
  const events = structuredClone(sessionEvents(h.session))
  const edit = await h.editor.read(h.session.id)
  assert.deepEqual(edit.parts.map(part => part.kind), ['text', 'html', 'text'])
  assert.deepEqual(edit.parts[1], { kind: 'html' })
  const view = await h.editor.save(h.session.id, { token: edit.token, texts: ['新文本\n', '新结尾'] })
  assert.equal(view.messages.at(-1).text, '新文本\n' + html.trimStart() + '新结尾')
  assert.deepEqual(view.messages.at(-1).variables, [{ hp: 9 }])
  assert.equal(view.posture, ''); assert.deepEqual(view.scriptState, { cursor: 5 }); assert.deepEqual(view.variables, { hp: 9 }); assert.equal(view.settleStatus, 'idle')
  assert.deepEqual(sessionEvents(h.session).slice(0, events.length), events)
  assert.equal(h.session.deriveMessages().at(-1).content[0].text, view.messages.at(-1).text)
  assert.equal(h.session.deriveMessages().filter(m => m.role === 'assistant').length, 1)
  const count = sessionEvents(h.session).length
  h.restore()
  await synchronizeBodyEdits(h.session, h.chat, h.options.sessions.flush)
  assert.equal(sessionEvents(h.session).filter(e => e.type !== 'session/end-seed').length, count)
  assert.match(projectReplyHistory(h.chat.messages).projections.at(-1).text, /新文本/)
  const again = await h.editor.read(h.session.id)
  await h.editor.save(h.session.id, { token: again.token, texts: ['再次编辑\n', '结尾'] })
  assert.match(h.session.deriveMessages().at(-1).content[0].text, /再次编辑/)
})

test('plain text edits force a persisted UI projection even when source and session match', async () => {
  const h = fixture(), edit = await h.editor.read(h.session.id)
  await h.editor.save(h.session.id, { token: edit.token, texts: ['新正文'] })
  assert.equal(projectReplyHistory(h.chat.messages).projections[0].text, '新正文')
})

test('stale tabs, blank text, new HTML, running turns and HTML-only replies reject without writes', async () => {
  const h = fixture(), edit = await h.editor.read(h.session.id), original = structuredClone(h.chat)
  for (const input of [{ token: 'stale', texts: ['新'] }, { token: edit.token, texts: [''] }, { token: edit.token, texts: ['<div>注入</div>'] }, { token: edit.token, texts: [] }]) await assert.rejects(h.editor.save(h.session.id, input))
  h.busy(true); await assert.rejects(h.editor.save(h.session.id, { token: edit.token, texts: ['新'] }), /等待/); h.busy(false)
  h.agent.phase.kind = 'running'; await assert.rejects(h.editor.read(h.session.id), /等待/)
  assert.deepEqual(h.chat, original)
  const html = fixture('<div>纯 HTML</div>'); await assert.rejects(html.editor.read(html.session.id), /没有可编辑文本/)
})

test('failed Chat write leaves Surface intact; durable edit recovers after native flush loss', async () => {
  const h = fixture(), edit = await h.editor.read(h.session.id), original = structuredClone(sessionEvents(h.session))
  h.failWrite(true)
  await assert.rejects(h.editor.save(h.session.id, { token: edit.token, texts: ['新正文'] }), /write failed/)
  assert.deepEqual(sessionEvents(h.session), original)
  h.failWrite(false); h.failFlush(true)
  await assert.rejects(h.editor.save(h.session.id, { token: edit.token, texts: ['新正文'] }), /flush failed/)
  h.restore(original); h.failFlush(false)
  await synchronizeBodyEdits(h.session, h.chat, h.options.sessions.flush)
  assert.equal(h.session.deriveMessages().at(-1).content[0].text, '新正文')
})

test('display captures do not invalidate an open edit, but advancing the conversation does', async () => {
  const h = fixture(), edit = await h.editor.read(h.session.id)
  h.change(chat => { chat._storageRevision++; chat.messages.at(-1).displayRuntime = { frames: [] } })
  await h.editor.save(h.session.id, { token: edit.token, texts: ['新正文'] })
  assert.equal(h.chat.messages.at(-1).displayRuntime, undefined)
  const next = await h.editor.read(h.session.id)
  h.change(chat => { chat.messages.push({ role: 'user', text: '下一轮' }) })
  await assert.rejects(h.editor.save(h.session.id, { token: next.token, texts: ['过时正文'] }), /最后一轮/)
})


test('narrative protocol wrappers retain their bytes while their prose remains editable', async () => {
  for (const tag of ['dream_plot', 'content', 'gametxt']) {
    const text = '<' + tag + '>\n<dream_body>\n神龛塌了半边，王晨走进晨雾。\n</dream_body>\n```html\n<div>体力 9</div>\n```\n</' + tag + '>'
    const h = fixture(text)
    const parts = editableReplyParts(text)
    assert.equal(parts.map(part => part.text).join(''), text, 'wrappers and whitespace must be lossless')
    const edit = await h.editor.read(h.session.id)
    const texts = edit.parts.filter(part => part.kind === 'text').map(part => part.text.replace('走进晨雾', '留在神龛'))
    assert.ok(texts.some(text => text.includes('留在神龛')))
    const result = await h.editor.save(h.session.id, { token: edit.token, texts })
    assert.equal(result.messages.at(-1).sourceText, text.replace('走进晨雾', '留在神龛'))
    assert.deepEqual(result.variables, { hp: 9 })
  }
})

test('editing distinguishes narrative tags from HTML, custom UI and code samples', () => {
  for (const text of ['<div><dream_body>界面内容</dream_body></div>', '<story-panel>界面内容</story-panel>', '<panel style="color:red">界面内容</panel>', '<svg><text>图形文字</text></svg>']) {
    const parts = editableReplyParts(text)
    assert.deepEqual(parts, [{ kind: 'html', text }])
  }
  for (const text of ['<dream_body>未闭合正文', '<gametxt>\r\n正文\r\n</gametxt>', '代码 `<dream_body>` 和 `<div>`', '```js\nconst x = "<dream_body>"\n```']) {
    const parts = editableReplyParts(text)
    assert.equal(parts.map(part => part.text).join(''), text)
    assert.ok(parts.some(part => part.kind === 'text' && part.text.trim()))
  }
})


test('host rejection is checked before publishing an edit to the Chat journal', async () => {
  const h = fixture()
  const edit = await h.editor.read(h.session.id)
  const before = structuredClone(h.chat), events = structuredClone(sessionEvents(h.session))
  const originalConstructor = h.session.constructor
  Object.defineProperty(h.session, 'constructor', { value: { fromRestore(...args) {
    const preview = originalConstructor.fromRestore(...args)
    preview.append = () => { throw Error('host rejects replacement') }
    return preview
  } }, configurable: true })
  await assert.rejects(h.editor.save(h.session.id, { token: edit.token, texts: ['不能保存'] }), /host rejects replacement/)
  assert.deepEqual(h.chat, before)
  assert.deepEqual(sessionEvents(h.session), events)
  Object.defineProperty(h.session, 'constructor', { value: originalConstructor, configurable: true })
  await h.editor.read(h.session.id)
})

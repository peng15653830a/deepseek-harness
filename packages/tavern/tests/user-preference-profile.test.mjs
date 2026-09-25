import assert from 'node:assert/strict'
import test from 'node:test'
import { createUserPreferenceProfile } from '../tavern-plugin/lib/domain/user-preference-profile.js'

function memoryStore(initial) {
  let value = initial
  return {
    async readJson() { return structuredClone(value) },
    async updateJson(_path, updater) {
      value = await updater(structuredClone(value))
      return structuredClone(value)
    }
  }
}

test('draft remains separate until the user confirms its exact revision', async function () {
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => 100 })
  const draft = await profile.saveDraft({
    rawAnswers: [{ question: '喜欢什么节奏？', answer: '慢热，但不要停滞。' }],
    dimensions: [{ id: 'pacing', label: '节奏', conclusion: '慢热且持续推进', confidence: 'likely', evidence: '用户原话' }],
    summary: '偏好慢热且持续推进。',
    injectionText: '节奏可以慢热，但每轮都应有可感知的推进。'
  })
  assert.equal(draft.hasDraft, true)
  assert.equal(draft.hasConfirmed, false)
  assert.equal(await profile.stableContext(), null)
  await assert.rejects(profile.confirm({ draftRevision: draft.draft.revision, confirmation: '' }), /明确确认/)

  const confirmed = await profile.confirm({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  assert.equal(confirmed.hasConfirmed, true)
  assert.equal(confirmed.hasDraft, false)
  assert.match((await profile.stableContext()).text, /每轮都应有可感知的推进/)
})

test('a newer draft does not silently replace the confirmed profile', async function () {
  let tick = 0
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => ++tick })
  const first = await profile.saveDraft({ summary: '第一版', injectionText: '采用第一版偏好。' })
  await profile.confirm({ draftRevision: first.draft.revision, confirmation: '确认保存用户画像' })
  const second = await profile.saveDraft({ summary: '第二版', injectionText: '采用第二版偏好。' })
  assert.match((await profile.stableContext()).text, /第一版/)
  await assert.rejects(profile.confirm({ draftRevision: first.draft.revision, confirmation: '确认保存用户画像' }), /已变化/)
  await profile.confirm({ draftRevision: second.draft.revision, confirmation: '确认保存用户画像' })
  assert.match((await profile.stableContext()).text, /第二版/)
})

test('manual edits create a new confirmed version without changing an existing game snapshot', async function () {
  let tick = 0
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => ++tick })
  const draft = await profile.saveDraft({ summary: '旧画像', injectionText: '旧注入摘要' })
  const first = await profile.confirm({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  const frozen = await profile.stableContext()
  await assert.rejects(profile.updateConfirmed({ expectedRevision: 999, summary: '新画像', injectionText: '新注入摘要' }), /已被其他操作修改/)
  const changed = await profile.updateConfirmed({ expectedRevision: first.confirmed.profileRevision, summary: '新画像', injectionText: '新注入摘要' })
  assert.equal(changed.confirmed.profileRevision > first.confirmed.profileRevision, true)
  assert.equal(changed.hasDraft, false)
  assert.match((await profile.stableContext()).text, /新注入摘要/)
  assert.match(frozen.text, /旧注入摘要/)
})

test('default enablement is profile-wide but remains off until explicitly changed', async function () {
  const profile = createUserPreferenceProfile({ store: memoryStore(), now: () => 100 })
  assert.equal((await profile.read()).defaultEnabled, false)
  await assert.rejects(profile.setDefaultEnabled(true), /尚无已确认/)
  const draft = await profile.saveDraft({ summary: '画像', injectionText: '注入摘要' })
  await profile.confirm({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  assert.equal((await profile.setDefaultEnabled(true)).defaultEnabled, true)
  assert.equal((await profile.setDefaultEnabled(false)).defaultEnabled, false)
})

test('legacy literal newline escapes render and inject as real line breaks', async function () {
  const profile = createUserPreferenceProfile({ store: memoryStore({
    spec: 'dsh-tavern.user-preference-profile',
    version: 2,
    revision: 4,
    confirmed: { revision: 4, profileRevision: 4, summary: '第一行\\n第二行', injectionText: '偏好一\\n偏好二' }
  }) })
  const value = await profile.read()
  assert.equal(value.confirmed.summary, '第一行\n第二行')
  assert.match((await profile.stableContext()).text, /偏好一\n偏好二/)
})

test('legacy profile migrates without losing confirmation; named profiles keep independent drafts and defaults', async () => {
  const store = memoryStore({ version: 2, revision: 8, defaultEnabled: true, confirmed: { profileRevision: 8, summary: '旧画像', injectionText: '慢节奏' } })
  const profiles = createUserPreferenceProfile({ store })
  assert.equal((await profiles.read()).profileId, 'default')
  const oldContext = await profiles.stableContext()
  const created = await profiles.manage({ action: 'create', name: '冒险玩家' })
  assert.equal(created.hasConfirmed, false)
  assert.equal(created.defaultEnabled, false)
  const id = created.profileId
  const draft = await profiles.saveDraft({ profileId: id, summary: '快节奏', injectionText: '快节奏' })
  await profiles.manage({ action: 'select', profileId: 'default' })
  await profiles.confirm({ profileId: id, draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  assert.deepEqual(await profiles.stableContext(), oldContext)
  assert.match((await profiles.stableContext(id)).text, /快节奏/)
  assert.equal((await profiles.read('default')).defaultEnabled, true)
  assert.equal((await profiles.read(id)).defaultEnabled, false)
  await profiles.manage({ action: 'rename', profileId: id, name: '冒险' })
  assert.equal((await profiles.read(id)).name, '冒险')
  assert.equal((await createUserPreferenceProfile({ store }).read(id)).name, '冒险')
  await assert.rejects(profiles.manage({ action: 'select', profileId: 'missing' }), /不存在/)
  assert.equal((await profiles.read()).profileId, 'default')
})

test('a confirmation cannot cross profile boundaries after a selection change', async () => {
  const profiles = createUserPreferenceProfile({ store: memoryStore() })
  const first = await profiles.saveDraft({ summary: 'A' })
  await profiles.manage({ action: 'create', name: 'B' })
  const second = await profiles.saveDraft({ summary: 'B' })
  assert.notEqual(first.draft.revision, second.draft.revision)
  await assert.rejects(profiles.confirm({ draftRevision: first.draft.revision, confirmation: '确认保存用户画像' }), /已变化/)
  assert.equal((await profiles.read('default')).draft.summary, 'A')
})

test('browsing and creating profiles never change the separate new-game default', async () => {
  const profiles = createUserPreferenceProfile({ store: memoryStore() })
  const draft = await profiles.saveDraft({ summary: '日常', injectionText: '日常' })
  await profiles.confirm({ draftRevision: draft.draft.revision, confirmation: '确认保存用户画像' })
  await profiles.manage({ action: 'default', profileId: 'default' })
  const other = await profiles.manage({ action: 'create', name: '冒险' })
  assert.equal(other.defaultProfileId, 'default')
  await assert.rejects(profiles.manage({ action: 'default', profileId: other.profileId }), /确认画像/)
  await profiles.manage({ action: 'select', profileId: 'default' })
  assert.equal((await profiles.read()).defaultProfileId, 'default')
  await profiles.manage({ action: 'default', profileId: '' })
  assert.equal((await profiles.read()).defaultProfileId, '')
  assert.equal((await profiles.read()).hasConfirmed, true)
})

test('direct save updates the same profile atomically without confirmation or enabling it', async () => {
  const profile = createUserPreferenceProfile({ store: memoryStore() })
  const first = await profile.save({ summary: '慢热', injectionText: '慢热' })
  assert.equal(first.hasConfirmed, true)
  assert.equal(first.hasDraft, false)
  const second = await profile.save({ summary: '快节奏', injectionText: '快节奏' })
  assert.equal(second.profileId, first.profileId)
  assert.equal(second.profiles.length, 1)
  assert.equal(second.confirmed.summary, '快节奏')
  assert.equal(second.hasDraft, false)
  assert.equal(second.defaultEnabled, false)
})

test('single profile content is saved identically for display and injection', async () => {
  const profile = createUserPreferenceProfile({ store: memoryStore() })
  const content = '# 用户画像\n\n偏好慢热，保留玩家的行动选择。'
  const saved = await profile.save({ content })
  assert.equal(saved.confirmed.summary, content)
  assert.equal(saved.confirmed.injectionText, content)
  assert.deepEqual(saved.confirmed.rawAnswers, [])
  assert.deepEqual(saved.confirmed.dimensions, [])
  await assert.rejects(profile.save({ content: 'x'.repeat(3001) }), /3000/)
  assert.equal((await profile.read()).confirmed.summary, content)
})

import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { createPromptCatalog, prompt } from '../tavern-plugin/lib/prompt-catalog.js'

const names = [
  'story',
  'script-story',
  'candidate-story',
  'candidate-script',
  'posture-settlement',
  'story-compaction',
  'card-mode-greeting',
  'card-task-edit',
  'card-task-extract',
  'card-task-script',
  'card-task-worldbook',
  'card-task-preset',
  'card-task-debug-play'
]

test('固定提示词从独立 Markdown 文件完整加载', () => {
  for (const name of names) assert.ok(prompt(name).length > 20, name + ' 提示词为空')
  assert.equal(typeof prompt('card-system'), 'string')
  assert.match(prompt('story'), /小说续写引擎/)
  assert.match(prompt('story'), /本轮演出指引/)
  assert.match(prompt('story'), /不是已经发生的剧情/)
  assert.match(prompt('story'), /不得直接沿用.*句式|不得.*直接拼接/)
  assert.doesNotMatch(prompt('story'), /指令原文可以改写、拆散、融入叙述/)
  assert.match(prompt('script-story'), /Guide ＞ 剧本 ＞ 世界一致性 ＞ 本轮演出指引/)
  assert.match(prompt('candidate-script'), /tavern_read_script/)
  assert.match(prompt('candidate-script'), /tavern_point_script/)
  assert.throws(() => prompt('play-mode'), /未知提示词/)
  assert.match(prompt('story-compaction'), /压缩以上剧情/)
  assert.match(prompt('story-compaction'), /不续写/)
  assert.match(prompt('story-compaction'), /形象、性格、关系/)
  assert.doesNotMatch(prompt('story-compaction'), /Files and Code|AI coding assistant/)
  assert.doesNotMatch(prompt('candidate-story'), /后续剧本/)
  assert.match(prompt('candidate-story'), /结合当前正文分析剧情走向/)
  assert.match(prompt('card-mode-greeting'), /卡片工作台已就绪/)
  assert.match(prompt('card-mode-greeting'), /人物卡、预设、世界书和剧本分别由右侧对应资源库管理/)
  assert.doesNotMatch(prompt('card-mode-greeting'), /自定义 Files/)
  assert.match(prompt('card-task-edit'), /目标已经明确时直接开始/)
  assert.match(prompt('card-task-extract'), /新卡使用独立路径和资源 ID/)
  assert.match(prompt('card-task-script'), /修改剧本/)
  assert.match(prompt('card-task-script'), /不改动导入时保留的原始备份/)
  assert.match(prompt('card-task-worldbook'), /修改世界书/)
  assert.match(prompt('card-task-worldbook'), /目标已经明确时直接保存/)
  assert.match(prompt('card-task-preset'), /修改预设/)
  assert.match(prompt('card-task-preset'), /不会应用|无法使用/)
  assert.match(prompt('card-task-debug-play'), /tavern_read_play_chat/)
  assert.match(prompt('card-task-debug-play'), /不要一开始加载正文、日志或其他层/)
  assert.match(prompt('card-task-debug-play'), /最新一轮只是默认入口，不是读取边界/)
  assert.match(prompt('card-task-debug-play'), /其他轮次或整场 conversation/)
  assert.match(prompt('card-task-debug-play'), /iframe 的实际 DOM/)
  assert.match(prompt('card-task-debug-play'), /不得自动修正人物卡/)
  assert.throws(() => prompt('card-task-bind-script'), /未知提示词/)
  assert.throws(() => prompt('worldbook-selector'), /未知提示词/)
  assert.throws(() => prompt('missing'), /未知提示词/)
})

test('修改提示词文件后无需重启即可在下一次读取时生效', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'dsh-tavern-prompts-'))
  t.after(async function () { await rm(directory, { recursive: true, force: true }) })
  const file = path.join(directory, 'card-mode-greeting.md')
  await writeFile(file, '第一版欢迎语', 'utf8')
  const readPrompt = createPromptCatalog(pathToFileURL(directory + path.sep))

  assert.equal(readPrompt('card-mode-greeting'), '第一版欢迎语')
  await writeFile(file, '第二版欢迎语', 'utf8')
  assert.equal(readPrompt('card-mode-greeting'), '第二版欢迎语')
})

test('业务模块不再内嵌固定角色提示词', async () => {
  const sources = await Promise.all([
    '../tavern-plugin/lib/domain/context-planner.js',
    '../tavern-plugin/lib/domain/candidate-generation.js',
    '../tavern-plugin/lib/index.js'
  ].map(function (path) { return readFile(new URL(path, import.meta.url), 'utf8') }))
  const source = sources.join('\n')
  assert.doesNotMatch(source, /你是小说续写引擎|你是剧情候选项生成器|你是剧本候选项生成器|你是世界书条目检索器|你是剧情姿势结算器/)
})

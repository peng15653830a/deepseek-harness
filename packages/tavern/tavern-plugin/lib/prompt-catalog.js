import { readFileSync } from 'node:fs'

export const SYSTEM_PROMPT_DEFINITIONS = Object.freeze([
  ['story', '正文 Agent 核心提示词', '控制普通游玩正文的续写规则。'],
  ['script-story', '剧本模式正文补充', '控制绑定剧本时追加给正文 Agent 的规则。'],
  ['candidate-story', '普通剧情候选项', '控制普通剧情候选项的数量、类型和输出格式。'],
  ['candidate-script', '剧本候选项', '控制剧本模式候选项及剧本推进规则。'],
  ['posture-settlement', '姿势状态结算', '控制后台姿势结算的工具提交。'],
  ['story-compaction', '前台上下文压缩', '用于前台手动和自动压缩：保留续玩要点，细节按需通过 recall 检索。修改后下次压缩生效；后台仍使用 DSH 内置压缩提示词。'],
  ['card-system', '卡片 Agent 系统指令', '默认空白；从 card-system.md 读取，非空时仅注入卡片 Agent。'],
  ['card-workspace', '卡片 Agent 工作区说明', '仅注入卡片 Agent 的 system。可编辑完整说明；{{resourceRoot}} 自动替换为当前资源根目录，{{projectionPaths}} 自动替换为当前会话的投影文件路径。保存后下一次请求生效。'],
  ['card-mode-greeting', '卡片工作台欢迎语', '控制新建卡片工作台对话的开场内容。'],
  ['card-task-edit', '人物卡编辑任务', '控制“修改人物卡”任务的起始要求。'],
  ['card-task-extract', '人物卡抽取任务', '控制“从剧本抽取人物卡”任务的起始要求。'],
  ['card-task-script', '剧本编辑任务', '控制“修改剧本”任务的起始要求。'],
  ['card-task-worldbook', '世界书编辑任务', '控制“修改世界书”任务的起始要求。'],
  ['card-task-preset', '预设编辑任务', '控制“修改预设”任务的起始要求。'],
  ['card-task-debug-play', '游玩记录调试任务', '控制卡片 Agent 调试游玩记录时的读取边界。']
].map(function (item) { return Object.freeze({ name: item[0], label: item[1], description: item[2] }) }))

export const SYSTEM_PROMPT_NAMES = Object.freeze(SYSTEM_PROMPT_DEFINITIONS.map(function (item) { return item.name }))

const knownNames = new Set(SYSTEM_PROMPT_NAMES)

export function createPromptCatalog(directory = new URL('../prompts/', import.meta.url)) {
  return function promptFromFile(name) {
    if (!knownNames.has(name)) throw new Error('未知提示词: ' + String(name))
    const text = readFileSync(new URL(name + '.md', directory), 'utf8').trim()
    if (text === '' && name !== 'card-system') throw new Error('提示词文件不能为空: ' + name + '.md')
    return text
  }
}

export const prompt = createPromptCatalog()

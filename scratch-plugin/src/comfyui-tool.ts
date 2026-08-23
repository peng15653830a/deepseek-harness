/**
 * ComfyUI 生图工具插件
 *
 * 注册一个 `generate_image` 工具，让 agent 可以调用本地 ComfyUI 生成图片。
 * 需要先在工作流管理页面导出一个 API 格式的 workflow JSON。
 *
 * 安装：
 *   1. 在 ComfyUI 中设计好文生图工作流
 *   2. 菜单 → 保存（API 格式），导出为 workflow_api.json
 *   3. 在插件配置中指定 workflowPath 指向该文件
 */

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'

// ── 类型定义 ──

interface ComfyWorkflow {
  [nodeId: string]: {
    class_type: string
    inputs: Record<string, unknown>
  }
}

interface ComfyPromptResult {
  prompt_id: string
  number: number
  node_errors?: Record<string, unknown>
}

interface ComfyHistoryItem {
  prompt_id: string
  outputs: Record<string, {
    images?: Array<{ filename: string; subfolder: string; type: string }>
  }>
  status: { status_str: string; completed: boolean }
}

// ── 插件配置 ──

export interface Config {
  /** ComfyUI 服务地址，默认 http://127.0.0.1:8188 */
  baseUrl: string
  /**
   * API 格式 workflow JSON 文件路径（绝对路径）
   * 在 ComfyUI → 菜单 → 保存（API 格式）导出
   */
  workflowPath: string
}

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default('http://127.0.0.1:8188'),
  workflowPath: Schema.string().required(),
})

export const name = 'comfyui-tool'
export const inject = ['tools']

// ── 工具实现 ──

export function apply(ctx: Context, config: Config) {
  const { baseUrl, workflowPath } = config

  ctx.tools.register(defineTool({
    name: 'generate_image',
    description: '使用本地 ComfyUI 生成场景配图。传入画面描述，返回生成的图片 URL。创作长篇正文时，每写完约 500 字就调用一次，为刚完成的段落配图；配图会自动显示在该段正文之后，不要在正文中重复输出图片链接。',

    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: '画面描述（正向提示词），描述你想生成的画面内容',
      },
      negative_prompt: {
        type: 'string',
        description: '负面提示词，描述不想出现在画面中的内容',
      },
      seed: {
        type: 'number',
        description: '随机种子，固定值可复现相同结果。-1 表示随机',
      },
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          images: {
            type: 'array',
            items: { type: 'string' },
          },
          message: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const blocks: Array<{ type: string; text?: string; data?: string }> = []
        if (value.message) {
          blocks.push({ type: 'text', text: value.message })
        }
        if (value.images?.length) {
          for (const img of value.images) {
            blocks.push({ type: 'text', text: `![generated](${img})` })
          }
        }
        return blocks
      },
    },

    async execute(args) {
      const { prompt, negative_prompt, seed } = args as {
        prompt: string
        negative_prompt?: string
        seed?: number
      }

      // ── 1. 加载 workflow 模板 ──
      let workflow: ComfyWorkflow
      try {
        const raw = await readFile(resolve(workflowPath), 'utf-8')
        workflow = JSON.parse(raw) as ComfyWorkflow
      } catch (e) {
        throw new Error(
          `无法加载 workflow 文件: ${workflowPath}。` +
          `请先在 ComfyUI 中导出 API 格式的 workflow。` +
          `（ComfyUI → 菜单 → 保存（API 格式））`
        )
      }

      // ── 2. 查找提示词编码节点和 KSampler 节点 ──
      // 兼容两类编码节点：
      //   - CLIPTextEncode: 输入字段为 `text`（SD/SDXL 工作流）
      //   - TextEncodeQwenImageEditPlus: 输入字段为 `prompt`（Qwen-Image 工作流）
      // 正向节点优先匹配带 %prompt% 占位符的节点，否则取第一个；
      // 负向节点取剩余的编码节点中的第一个。
      const encodeNodes: Array<{ id: string; field: string }> = []
      let samplerNode: string | null = null
      let latentNode: string | null = null

      for (const [id, node] of Object.entries(workflow)) {
        if (node.class_type === 'CLIPTextEncode' && typeof node.inputs.text === 'string') {
          encodeNodes.push({ id, field: 'text' })
        } else if (node.class_type.startsWith('TextEncode') && typeof node.inputs.prompt === 'string') {
          encodeNodes.push({ id, field: 'prompt' })
        } else if (node.class_type === 'KSampler' || node.class_type.startsWith('KSampler')) {
          samplerNode = id
        } else if (node.class_type === 'EmptyLatentImage') {
          latentNode = id
        }
      }

      if (encodeNodes.length === 0) {
        throw new Error('workflow 中未找到提示词编码节点，请确保导出的 workflow 包含文生图节点')
      }

      // ── 3. 替换参数 ──
      // 正向节点：优先找带 %prompt% 占位符的节点（替换占位符），否则取第一个直接赋值
      let positiveNode = encodeNodes.find(n =>
        typeof workflow[n.id].inputs[workflow[n.id].class_type.startsWith('TextEncode') ? 'prompt' : 'text'] === 'string'
        && String(workflow[n.id].inputs[workflow[n.id].class_type.startsWith('TextEncode') ? 'prompt' : 'text']).includes('%prompt%')
      )
      if (!positiveNode) positiveNode = encodeNodes[0]

      const posField = positiveNode.field
      const posRaw = workflow[positiveNode.id].inputs[posField]
      workflow[positiveNode.id].inputs[posField] = typeof posRaw === 'string' && posRaw.includes('%prompt%')
        ? posRaw.replaceAll('%prompt%', prompt)
        : prompt

      // 负向节点：取剩余编码节点中的第一个，提供了 negative_prompt 才覆盖
      const negativeNode = encodeNodes.find(n => n.id !== positiveNode.id)
      if (negativeNode && negative_prompt) {
        workflow[negativeNode.id].inputs[negativeNode.field] = negative_prompt
      }

      // 替换 seed：未提供时随机化，避免每次生成相同图片
      const seedValue = seed !== undefined && seed >= 0
        ? seed
        : Math.floor(Math.random() * 2 ** 53)
      if (samplerNode) {
        workflow[samplerNode].inputs.seed = seedValue
      }

      // ── 4. 提交到 ComfyUI ──
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120_000)

      let promptResult: ComfyPromptResult
      try {
        const resp = await fetch(`${baseUrl}/prompt`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: workflow }),
          signal: controller.signal,
        })
        if (!resp.ok) {
          const errText = await resp.text()
          throw new Error(`ComfyUI 返回错误 (${resp.status}): ${errText}`)
        }
        promptResult = await resp.json() as ComfyPromptResult
      } finally {
        clearTimeout(timeout)
      }

      const promptId = promptResult.prompt_id

      // ── 5. 轮询直到生成完成 ──
      let history: ComfyHistoryItem | null = null
      const pollInterval = 1000
      const maxWait = 120_000
      const startTime = Date.now()

      while (Date.now() - startTime < maxWait) {
        await new Promise(r => setTimeout(r, pollInterval))

        try {
          const resp = await fetch(`${baseUrl}/history/${promptId}`, {
            signal: controller.signal,
          })
          if (resp.ok) {
            const data = await resp.json() as Record<string, ComfyHistoryItem>
            const item = data[promptId]
            if (item && item.status?.completed) {
              history = item
              break
            }
          }
        } catch {
          // 轮询中忽略短暂的网络错误
        }
      }

      if (!history) {
        throw new Error('ComfyUI 生成超时或失败，请检查 ComfyUI 状态')
      }

      // ── 6. 提取图片 ──
      const images: string[] = []
      for (const nodeOutput of Object.values(history.outputs)) {
        if (nodeOutput.images) {
          for (const img of nodeOutput.images) {
            const imgUrl = `${baseUrl}/view?filename=${encodeURIComponent(img.filename)}` +
              `&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`
            images.push(imgUrl)
          }
        }
      }

      if (images.length === 0) {
        throw new Error('ComfyUI 生成完成但未找到输出图片')
      }

      return {
        images,
        message: `生成了 ${images.length} 张图片`,
      }
    },
  }))
}
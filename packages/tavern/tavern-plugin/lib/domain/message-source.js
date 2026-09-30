// 0.2 会话格式废弃了 source.kind 'plugin'，各生产者改用具名 kind；旧档迁移时
// 0.1.5 的 plugin 行会被改写成 `plugin:<名字>` 并剥掉 plugin 字段。酒馆自己写
// 的行（具名 kind + 保留 plugin 字段）、尚未迁移的旧行（kind 'plugin'）和迁移后
// 的旧行三种形态都要能识别。
export function tavernSourceIs(source, plugin) {
  if (!source || typeof source !== 'object') return false
  if (source.plugin === plugin) return true
  if (source.kind === plugin) return true
  if (plugin === '@deepseek-ai/dsh-system-prompt' && source.kind === 'system-prompt') return true
  return source.kind === 'plugin:' + plugin
}

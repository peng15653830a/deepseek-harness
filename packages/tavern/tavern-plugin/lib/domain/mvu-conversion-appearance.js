import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'

const hash = text => createHash('sha256').update(text).digest('hex')
const capturePattern = /\$([1-9]\d?)/g
export function appearanceSources(data) {
  return (data.extensions?.regex_scripts || []).flatMap((rule, index) => {
    const html = String(rule.replaceString || '')
    if (!/<(?:html|style|div|details|table|section|main|script|iframe|p|span|h[1-6]|ul|ol|dl|svg)\b/i.test(html)) return []
    return [{ path: `/extensions/regex_scripts/${index}/replaceString`, name: rule.scriptName || rule.id || String(index), enabled: rule.disabled !== true && rule.enabled !== false,
      digest: hash(html), captures: [...new Set([...html.matchAll(capturePattern)].map(m => Number(m[1])))].sort((a,b)=>a-b) }]
  })
}

// Read source bytes ourselves. Model input is a source pointer plus data bindings,
// never a rewritten template. Unknown executable views must not silently lose skin.
export function freezeMvuAppearance(data, plan) {
  if (!plan || typeof plan !== 'object' || Object.keys(plan).some(k => !['sourcePath','bindings'].includes(k))) throw Error('美化方案只接受 sourcePath 和 bindings，不接受模型重写 HTML')
  const entry = appearanceSources(data).find(x => x.path === plan.sourcePath)
  if (!entry) throw Error('美化来源不存在，请从 inspect.appearanceSources 选择')
  const source = data.extensions.regex_scripts[Number(plan.sourcePath.split('/')[3])].replaceString
  const fenced = source.trim().match(/^```html\s*\n([\s\S]*?)\n```$/i)
  const html = fenced ? fenced[1] : source
  if (/```|<%|&lt;%|\{\{|\$[&`']|\$<|\$\$/.test(html)) throw Error('美化包含动态模板或特殊替换语法，需专门适配；不能降级为默认面板')
  const dom = new JSDOM(html)
  try {
    const doc = dom.window.document
    if (doc.querySelector('script,iframe,object,embed,base,meta[http-equiv]')) throw Error('美化包含自定义脚本或嵌入文档，需专门适配；原视图保留，不自动删除')
    for (const element of doc.querySelectorAll('*')) {
      for (const attr of element.attributes) {
        if (/^on/i.test(attr.name) || /javascript\s*:/i.test(attr.value) || /\$[1-9]\d?/.test(attr.value)) throw Error('美化含事件处理或属性中的动态取值，需专门适配: ' + attr.name)
      }
    }
    if ([...doc.querySelectorAll('style,title,textarea')].some(el => /\$[1-9]\d?/.test(el.textContent))) throw Error('美化的样式或特殊文本区域含动态捕获，需专门适配')
    const captures = [...new Set([...html.matchAll(capturePattern)].map(m=>Number(m[1])))].sort((a,b)=>a-b)
    const walker = doc.createTreeWalker(doc.body, dom.window.NodeFilter.SHOW_TEXT)
    const visible = new Set(); let node
    while ((node=walker.nextNode())) if (!['STYLE','SCRIPT'].includes(node.parentElement?.tagName)) for (const m of node.textContent.matchAll(capturePattern)) visible.add(Number(m[1]))
    if (captures.some(n=>!visible.has(n))) throw Error('美化捕获不在可更新的正文文本节点中')
    if (!captures.length) throw Error('美化没有可映射的 $1、$2 状态字段，需专门适配')
    if (!Array.isArray(plan.bindings) || plan.bindings.length !== captures.length || new Set(plan.bindings.map(b=>b.capture)).size !== captures.length || plan.bindings.some(b=>!captures.includes(b.capture) || typeof b.path !== 'string' || Object.keys(b).some(k=>!['capture','path'].includes(k)))) throw Error('必须为原美化的每个捕获字段提供唯一变量映射')
    return { version:1, sourcePath:entry.path, sourceDigest:entry.digest, html, htmlDigest:hash(html), bindings:structuredClone(plan.bindings) }
  } finally { dom.window.close() }
}

export function renderFrozenAppearance(frozen, pointerKeys, initialState) {
  if (frozen.version !== 1 || hash(frozen.html) !== frozen.htmlDigest) throw Error('固化美化内容指纹不匹配')
  // Revalidate persisted metadata before the validator executes the host binder.
  freezeMvuAppearance({extensions:{regex_scripts:[{replaceString:frozen.html}]}}, {sourcePath:'/extensions/regex_scripts/0/replaceString',bindings:frozen.bindings})
  const bindings = frozen.bindings.map(binding => {
    const keys = pointerKeys(binding.path)
    let value=initialState
    for (const key of keys) {
      if (value == null || !Object.hasOwn(value,key)) throw Error('美化变量路径不存在: '+binding.path)
      value=value[key]
    }
    return {capture:binding.capture,keys}
  })
  const encoded=JSON.stringify(bindings).replace(/</g,'\\u003c')
  const script=`<script data-dsh-frozen-mvu>
(function(){
const bindings=${encoded};
const nodes=[];const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node;
while((node=walker.nextNode())){if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName))continue;if(/[\\x24]([1-9]\\d?)/.test(node.nodeValue))nodes.push({node,source:node.nodeValue});}
function render(){const state=Mvu.getMvuData({type:'message',message_id:'latest'}).stat_data;const values={};for(const binding of bindings){let value=state;for(const key of binding.keys)value=value!=null&&Object.prototype.hasOwnProperty.call(value,key)?value[key]:undefined;values[binding.capture]=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);}for(const item of nodes)item.node.nodeValue=item.source.replace(/[\\x24]([1-9]\\d?)/g,(_,id)=>values[id]??'');}
async function start(){await waitGlobalInitialized('Mvu');for(const event of new Set([Mvu.events.VARIABLE_INITIALIZED,Mvu.events.VARIABLE_UPDATE_ENDED,...Object.values(tavern_events)]))eventOn(event,render);render();}
start().catch(error=>{console.error('MVU 原样式状态更新失败',error);});
})();
</script>`
  // Original layout/CSS bytes are preserved. Only append host-owned data binding.
  const html=/<\/body\s*>/i.test(frozen.html) ? frozen.html.replace(/<\/body\s*>/i,match=>script+'\n'+match) : frozen.html+'\n'+script
  // Avoid regex replacement captures and identity macros in the outer display rule.
  return html.replace(/<script data-dsh-frozen-mvu>([\s\S]*?)<\/script>/,(_,body)=>'<script data-dsh-frozen-mvu>'+body.replace(/\$/g,'\\u0024')+'</script>').replace(capturePattern,(_,id)=>'&#36;'+id)
}

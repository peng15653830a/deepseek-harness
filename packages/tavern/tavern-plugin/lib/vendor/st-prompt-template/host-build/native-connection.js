const clone = value => value === undefined ? undefined : structuredClone(value)
const own = (value,key) => Object.prototype.hasOwnProperty.call(value,key)
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)
const record = value => value !== null && typeof value === 'object'

/** Reconcile receipts without discarding edits made while a save was in flight. */
export function reconcileTemplateReceipt(current, submitted, saved) {
  const unchangedArray = Array.isArray(current) && same(current,submitted)
  for(const key of new Set([...Object.keys(current),...Object.keys(submitted),...Object.keys(saved)])) {
    const unchanged=own(current,key)===own(submitted,key) && same(current[key],submitted[key])
    if(unchanged) {
      if(!own(saved,key)) delete current[key]
      else if(record(current[key]) && record(submitted[key]) && record(saved[key]) && Array.isArray(current[key])===Array.isArray(saved[key])) reconcileTemplateReceipt(current[key],submitted[key],saved[key])
      else Object.defineProperty(current,key,{value:clone(saved[key]),enumerable:true,writable:true,configurable:true})
    } else if(record(current[key]) && record(submitted[key]) && record(saved[key]) && Array.isArray(current[key])===Array.isArray(saved[key])) {
      reconcileTemplateReceipt(current[key],submitted[key],saved[key])
    }
  }
  if(unchangedArray) current.length=saved.length
}

export async function createNativeTemplateConnection({ sessionId, rpc, services = {}, settingsHtml }) {
  const initial=await rpc('getFullPromptTemplateState',{sessionId})
  let baseline=clone(initial.state), settingsBaseline=clone(initial.environment.extension_settings.EjsTemplate)
  let globalBaseline=clone(initial.environment.extension_settings.variables?.global)
  const snapshot={...initial.state,...initial.environment}
  let saves=Promise.resolve(), latest=saves
  function enqueue(operation) { const next=saves.then(operation); latest=next; saves=next.catch(error=>{ if(services.onPersistenceError) services.onPersistenceError(error); else console.error('Template persistence failed',error) }); return next }
  async function saveGlobals(settings) {
    const submitted=clone(settings.variables?.global || {})
    if(same(submitted,globalBaseline)) return
    const result=await rpc('saveFullPromptTemplateGlobals',{sessionId,variables:submitted,expectedVariables:globalBaseline})
    if(result.updated!==true || !result.variables) throw new Error('Template global save was not acknowledged')
    reconcileTemplateReceipt(settings.variables.global,submitted,result.variables)
    globalBaseline=clone(result.variables)
  }
  const callbacks={...services,
    renderExtensionTemplateAsync:async(name,template)=>{
      if(name!=='third-party/ST-Prompt-Template' || template!=='settings') throw new Error('Unknown template UI resource')
      return settingsHtml
    },
    loadWorldInfo:async name=>clone(initial.environment.worldbooks[name] || null),
    saveChatConditional: data=>enqueue(async()=>{
      await saveGlobals(data.extension_settings)
      const submitted={...clone(baseline),chat:clone(data.chat),chat_metadata:clone(data.chat_metadata)}
      const result=await rpc('saveFullPromptTemplateState',{sessionId,state:submitted})
      if(result.updated!==true || !result.state) throw new Error('Template state save was not acknowledged')
      reconcileTemplateReceipt(data.chat,submitted.chat,result.state.chat)
      reconcileTemplateReceipt(data.chat_metadata,submitted.chat_metadata,result.state.chat_metadata)
      baseline=clone(result.state)
      return result
    }),
    saveSettingsDebounced:settings=>enqueue(async()=>{
      await saveGlobals(settings)
      const submitted=clone(settings.EjsTemplate)
      const result=await rpc('saveFullPromptTemplateSettings',{sessionId,settings:submitted,expectedSettings:settingsBaseline})
      if(result.updated!==true) throw new Error('Template settings save was not acknowledged')
      reconcileTemplateReceipt(settings.EjsTemplate,submitted,result.settings)
      settingsBaseline=clone(result.settings)
      return result
    })
  }
  return {snapshot,callbacks,flush:()=>latest}
}

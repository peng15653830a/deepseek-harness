import test from 'node:test'
import assert from 'node:assert/strict'
import { measureForegroundPressure } from '../tavern-plugin/lib/domain/foreground-context-pressure.js'
function fixture({header,pending,lastUsed,capacity=1000000}={}) {
 const routes=[];let envelope;
 const deps={agent:{session:{requestHeader:()=>header}}, projections:{stateOf:()=>({pending,lastUsed})},
 defaultModel:{currentSelection:()=>({provider:'deepseek-official',model:'configured-model'})},
 llm:{resolveModelInfo:async(provider,model)=>{routes.push([provider,model]);return {context:{contextWindow:capacity}}}},
 meter:{measure:(_session,value)=>{envelope=value;return {totalTokens:180000}},estimateMessage:()=>1000},pendingMessages:[{}]};
 return {deps,routes,get envelope(){return envelope}};
}
test('first turn without header or selection uses configured default model capacity',async()=>{
 const h=fixture();assert.equal((await measureForegroundPressure(h.deps)).percent,18.1);
 assert.deepEqual(h.routes,[['deepseek-official','configured-model']]);
});
test('pending selection overrides old header and retains the request envelope',async()=>{
 const header={config:{provider:'old',model:'old'},messages:['history']},h=fixture({header,pending:{provider:'new',model:'new'}});
 await measureForegroundPressure(h.deps);assert.deepEqual(h.routes,[['new','new']]);assert.equal(h.envelope.messages,header.messages);assert.equal(h.envelope.config.provider,'new');assert.equal(header.config.provider,'old');
});
test('recorded route beats defaults and unavailable projection falls back to header',async()=>{
 const h=fixture({header:{config:{provider:'recorded',model:'recorded'}}});h.deps.projections.stateOf=()=>{throw Error('unavailable')};
 await measureForegroundPressure(h.deps);assert.deepEqual(h.routes,[['recorded','recorded']]);
});
test('unknown capacity on selected model is not replaced by another model capacity',async()=>{
 const h=fixture({pending:{provider:'unknown',model:'unknown'},capacity:undefined});
 h.deps.llm.resolveModelInfo=async()=>({context:{}});h.deps.defaultModel.currentSelection=()=>{throw Error('must not use default')};
 assert.equal(await measureForegroundPressure(h.deps),null);
});

test('foreground budget includes pending input and reserves the current output limit', async () => {
  const h = fixture({ capacity: 200000, pending: { provider: 'current', model: 'current', maxTokens: 30000 } })
  assert.equal((await measureForegroundPressure(h.deps)).budgetPercent, 105.5)
  assert.equal((await measureForegroundPressure(h.deps)).percent, 90.5)
})

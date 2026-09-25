import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { helperClient } from './fixtures/helper-host-harness.mjs'
function harness() {
 const html=helperClient.buildTavernFrameDocument({content:'',token:'touch'});
 const script=html.match(/<script data-dsh-tavern-touch>([\s\S]*?)<\/script>/)?.[1];
 assert.ok(script, 'message iframe must install touch relay');
 const handlers={},sent=[],frames=new Map();let time=0,id=0;
 const parent={postMessage:m=>sent.push(m)};
 const ctx={document:{scrollingElement:null,hidden:false},parent,performance:{now:()=>time},getComputedStyle:e=>e.css,requestAnimationFrame:f=>{frames.set(++id,f);return id},cancelAnimationFrame:i=>frames.delete(i),addEventListener:(n,f)=>handlers[n]=f};
 ctx.window={getSelection:()=>''};vm.runInNewContext(script,ctx);
 const target={nodeType:1,parentElement:null,isConnected:true,closest:()=>null,css:{touchAction:'none',overflowY:'auto',overscrollBehaviorY:'auto'},scrollHeight:200,clientHeight:100,scrollTop:90,scrollTo({top}){this.scrollTop=Math.max(0,Math.min(100,top))}};
 const event=(y,x=0,count=1)=>({target,touches:Array.from({length:count},(_,identifier)=>({screenY:y,screenX:x,identifier})),defaultPrevented:false});
 return {ctx,target,sent,frames,start(y=200){handlers.touchstart(event(y))},move(y,x=0){time+=16;handlers.touchmove(event(y,x))},end(){handlers.touchend({touches:[]})},cancel(){handlers.touchcancel({})},multi(){handlers.touchstart(event(180,0,2))},tick(ms=16){time+=ms;const tasks=[...frames.values()];frames.clear();tasks.forEach(f=>f(time))},wait(ms){time+=ms},deltas(){return sent.filter(m=>m.type==='dsh-tavern-frame-scroll').reduce((n,m)=>n+m.dy,0)}};
}
test('blocked native pan consumes inner 10px and relays only remaining 90px',()=>{const h=harness();h.start();h.move(100);assert.equal(h.target.scrollTop,100);assert.equal(h.deltas(),90)});
test('native vertical scrolling never receives synthetic movement or inertia',()=>{const h=harness();h.target.css.touchAction='pan-y';h.start();h.move(160);h.move(120);h.end();h.tick();assert.equal(h.deltas(),0);assert.equal(h.frames.size,0);assert.equal(h.target.scrollTop,90)});
test('pan-x still needs vertical relay',()=>{const h=harness();h.target.css.touchAction='pan-x';h.start();h.move(100);assert.equal(h.deltas(),90)});
test('horizontal drag, long press and multiple fingers do not relay',()=>{for(const kind of ['horizontal','long','multi']){const h=harness();h.start();if(kind==='long')h.wait(400);if(kind==='multi')h.multi();h.move(180,kind==='horizontal'?80:0);h.move(140,kind==='horizontal'?120:0);h.end();h.tick();assert.equal(h.deltas(),0,kind)}});
test('manual inertia stops on a fresh touch even without movement',()=>{const h=harness();h.start();h.move(170);h.move(130);h.end();assert.ok(h.frames.size);h.tick();const before=h.deltas();h.start();h.tick();assert.equal(h.deltas(),before);assert.equal(h.frames.size,0)});
test('cancel clears gesture and velocity; delayed release has no inertia',()=>{const h=harness();h.start();h.move(150);h.cancel();h.end();assert.equal(h.frames.size,0);h.start();h.move(150);h.wait(200);h.end();assert.equal(h.frames.size,0)});
test('overscroll containment prevents escaping the card panel',()=>{const h=harness();h.target.css.overscrollBehaviorY='contain';h.start();h.move(100);assert.equal(h.target.scrollTop,100);assert.equal(h.deltas(),0)});

test('reverse movement consumes ancestors in order and conserves distance',()=>{
 const h=harness();
 const outer={...h.target,scrollTop:20,css:{...h.target.css},parentElement:null};
 h.target.parentElement=outer;h.target.scrollTop=10;
 h.start(100);h.move(200);
 assert.equal(h.target.scrollTop,0);assert.equal(outer.scrollTop,0);assert.equal(h.deltas(),-70);
});
test('selection and form controls retain their gestures',()=>{
 for(const kind of ['selection','control']){
  const h=harness();if(kind==='selection')h.ctx.window.getSelection=()=> 'selected text';else h.target.closest=()=>({});
  h.start();h.move(100);h.end();assert.equal(h.deltas(),0);assert.equal(h.frames.size,0);
 }
});

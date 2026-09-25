import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
test('0.1.5 native file tools and explicit legacy editor read and edit the same card', { skip: !process.env.DSH_BOOT_MODULE }, async () => {
const base=new URL('../../', pathToFileURL(process.env.DSH_BOOT_MODULE)).href;
const {boot}=await import(base+'dsh-app-boot/lib/index.js');
const root=await mkdtemp(join(tmpdir(),'tavern-tools-smoke-'));
const names=['dsh-system-prompt','dsh-tools','dsh-fs-local','dsh-tool-fs','dsh-tool-str-replace-editor'];
await writeFile(join(root,'host.yml'),names.map(name=>`- name: ${base}${name}/lib/index.js\n${name==='dsh-fs-local'?`  config:\n    cwd: ${root}\n`:''}`).join(''));
const ctx=await boot('tavern-tool-smoke',join(root,'host.yml'));
try {
 const exec={signal:new AbortController().signal};
 const call=async(name,args)=>{const tool=ctx.tools.get(name);assert.ok(tool, name+' registered');return await tool.execute(args,exec)};
 const path=join(root,'card.json');
 await call('write',{file_path:path,content:'{"name":"Before"}'});
 await call('read',{file_path:path});
 await call('edit',{file_path:path,old_string:'Before',new_string:'After'});
 assert.equal(await readFile(path,'utf8'),'{"name":"After"}');
 await call('str_replace_editor',{command:'str_replace',path,old_str:'After',new_str:'Verified'});
 assert.equal(await readFile(path,'utf8'),'{"name":"Verified"}');

} finally {await ctx.fiber.dispose();await rm(root,{recursive:true,force:true})}

});

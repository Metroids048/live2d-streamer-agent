import test from 'node:test';import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {prepareRigRuntime} from '../src/pipeline/rig-runtime.mjs';import {RIG_REPAIR_PROFILE} from '../src/rigging/recipe.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t) {
 const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-runtime-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.mkdir(root+'/config');await fs.mkdir(root+'/out/rigging',{recursive:true});
 await fs.writeFile(root+'/component.jar','component');const manifest={runtimeComponents:[{path:root+'/component.jar',sha256:hash('component')}]};
 await fs.writeFile(root+'/manifest.json',JSON.stringify(manifest));await fs.writeFile(root+'/template.args','-classpath\ncomponent.jar');
 const config={manifest:'manifest.json',manifestSha256:hash(JSON.stringify(manifest)),argsTemplate:'template.args',argsSha256:hash('-classpath\ncomponent.jar')};await fs.writeFile(root+'/config/psd2live-runtime.json',JSON.stringify(config));
 return {root,job:{kind:'single_image',output:root+'/out'},location:{dir:root+'/engine',args:['task','candidate','2']},manifest,config};
}
test('current production recipe pins verified runtime and preserves the candidate args on resume',async t=>{
 const f=await fixture(t),r=await prepareRigRuntime(f.root,f.job,f.location);assert.deepEqual(r.engineRuntimePatch,f.manifest);assert.equal(hash(await fs.readFile(r.argsFile)),f.config.argsSha256);
 await fs.writeFile(f.job.output+'/rigging/recipe.json',JSON.stringify({repairProfile:RIG_REPAIR_PROFILE,engineRuntimePatch:f.manifest}));assert.deepEqual(await prepareRigRuntime(f.root,f.job,f.location),r);
});
for(const defect of ['component','manifest','template','candidate','recipe'])test('runtime rejects '+defect+' drift',async t=>{
 const f=await fixture(t);await prepareRigRuntime(f.root,f.job,f.location);
 const file={component:f.root+'/component.jar',manifest:f.root+'/manifest.json',template:f.root+'/template.args',candidate:f.location.dir+'/runtime-pinned.args',recipe:f.job.output+'/rigging/recipe.json'}[defect];
 await fs.writeFile(file,defect==='recipe'?JSON.stringify({repairProfile:RIG_REPAIR_PROFILE,engineRuntimePatch:{}}):'changed');
 await assert.rejects(prepareRigRuntime(f.root,f.job,f.location),e=>e.code==='ENGINE_BUILD_MISMATCH');
});
test('a historical in-flight recipe retains its original runtime without copying current args',async t=>{
 const f=await fixture(t);await fs.writeFile(f.job.output+'/rigging/recipe.json',JSON.stringify({repairProfile:'hachi-g1-shared-parent-v5'}));assert.equal(await prepareRigRuntime(f.root,f.job,f.location),null);await assert.rejects(fs.access(f.location.dir));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {encodePng} from '../src/artwork/png.mjs';
import {buildRig} from '../src/rigging/index.mjs';
import {createStageEngine} from '../src/pipeline/production-engine.mjs';

const hash=b=>createHash('sha256').update(b).digest('hex');
async function fixture(t,profile) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'old-rig-recovery-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'artwork'));await fs.mkdir(path.join(root,'rigging'));
  const identity={taskId:randomUUID(),candidateId:randomUUID(),revision:1,parentRevision:null,inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
  const layer={id:'face',tags:['face'],rect:{left:0,top:0,width:2,height:2},image:{path:'face.png',width:2,height:2}};
  const files={'artwork/face.png':encodePng({width:2,height:2,data:Buffer.from(Array(4).fill([180,120,80,255]).flat())}),
    'artwork/layout.json':JSON.stringify({format:'psd2live-layout',version:1,canvas:{width:8,height:8},layers:[layer]}),'artwork/manifest.json':'{}'};
  const artifacts=[];
  for(const [relative,bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(root,relative),bytes);
    artifacts.push({role:'synthetic_fixture',path:relative,bytes:Buffer.byteLength(bytes),sha256:hash(bytes)});
  }
  const artwork={...identity,schemaVersion:1,stage:'artwork',status:'completed',checks:[],warnings:[],unresolved:[],artifacts,
    layoutPath:'artwork/layout.json',artworkManifestPath:'artwork/manifest.json',
    brief:{intent:{headMotion:{yawDegrees:0,pitchDegrees:0,rollDegrees:0},eyes:{},mouth:{},expressions:[],actions:[]}}};
  const pending={key:'old-save',operation:'project_save',request_id:'original-request',request:{project_id:'p',state:'before'},
    bodyHash:'c'.repeat(64),projectId:'p',lifecycle:false,jobId:'job-original',status:'running'};
  const journal={schemaVersion:1,recipeVersion:2,repairProfile:profile,identity,sourceHash:hash(JSON.stringify(artifacts)),projectId:'p',state:'before',pending,done:{}};
  const stage={...artwork,stage:'rigging',status:'awaiting_external_result',pending,engineProjectId:'p',engineRevision:'before',
    refinementVersion:'historical-refinement',engineRuntimePatch:{version:'historical-runtime'}};
  const write=(file,value)=>fs.writeFile(path.join(root,'rigging',file),JSON.stringify(value));
  await write('state.json',journal);await write('stage.json',stage);await write('recipe.json',{repairProfile:journal.repairProfile});
  return {root,artwork,journal,write,ctx:{root,taskRoot:root,...identity}};
}

for(const profile of ['semantic-surface-v9','semantic-surface-v10'])
for(const outcome of ['completed','wait-completed','failed','missing-job','no-pending','foreign-context'])
test(profile+' recovery '+outcome+' only observes its original pending receipt',async t=>{
  const f=await fixture(t,profile),calls=[],ensures=[];
  if(outcome==='missing-job')delete f.journal.pending.jobId;
  if(outcome==='no-pending')f.journal.pending=null;
  await f.write('state.json',f.journal);
  const originalRecipe=await fs.readFile(path.join(f.root,'rigging/recipe.json'));
  const client={async call(op,request) {
    calls.push({op,request});
    if(op==='workspace_inspect')return {data:{project_id:'p',state:'before',loaded:true,busy:false}};
    assert(['job_get','job_wait'].includes(op),'old recipes must never invoke current recipe operations');
    assert.equal(request.id,'job-original');
    if(outcome==='wait-completed'&&op==='job_get')return {data:{id:request.id,project_id:'p',status:'running',terminal:false}};
    return {data:{id:request.id,project_id:'p',terminal:true,status:outcome==='failed'?'failed':'completed',
      ...(outcome==='failed'?{error:{message:'original failure'}}:{result:{project_id:'p',state:'after'}})}};
  }};
  const withEngine=createStageEngine({root:f.root,client,ensureEngine:async options=>ensures.push(options)});
  let result;
  if(outcome==='foreign-context')result=await buildRig(f.artwork,{...f.ctx,candidateId:randomUUID(),engine:client});
  else result=await withEngine('rigging',f.artwork,f.ctx,ctx=>buildRig(f.artwork,ctx));
  const after=JSON.parse(await fs.readFile(path.join(f.root,'rigging/state.json')));
  assert.equal(after.repairProfile,profile);
  assert.deepEqual(await fs.readFile(path.join(f.root,'rigging/recipe.json')),originalRecipe);
  await assert.rejects(fs.access(path.join(f.root,'rigging/import-layout')),{code:'ENOENT'});
  if(outcome==='foreign-context') {
    assert.equal(calls.length,0);assert(result.unresolved.some(i=>i.code==='BUNDLE_CONTEXT_MISMATCH'));assert.deepEqual(after,f.journal);return;
  }
  assert.equal(result.refinementVersion,'historical-refinement');
  assert.deepEqual(result.engineRuntimePatch,{version:'historical-runtime'});
  if(outcome==='missing-job') {
    assert.equal(result.status,'awaiting_external_result');assert.equal(calls.length,0);
    assert(result.unresolved.some(i=>i.code==='ENGINE_SUBMISSION_UNKNOWN'));assert.deepEqual(after.pending,f.journal.pending);return;
  }
  assert.equal(result.status,'blocked');assert.equal(after.pending,null);assert(!result.pending);
  if(outcome==='failed') {
    assert(result.unresolved.some(i=>i.code==='ENGINE_JOB_FAILED'));assert.equal(after.failed.jobId,'job-original');assert(!after.done['old-save']);
  } else {
    assert(result.unresolved.some(i=>i.code==='RIG_RECIPE_UPGRADE_REQUIRED'));
    if(outcome!=='no-pending') {
      assert.equal(after.done['old-save'].jobId,'job-original');assert.equal(after.done['old-save'].request_id,'original-request');
      assert.equal(after.state,'after');assert.equal(result.engineRevision,'after');
    }
  }
  assert.deepEqual(calls.map(c=>c.op),outcome==='no-pending'?['workspace_inspect']:outcome==='wait-completed'?['job_get','job_wait']:['job_get']);
  assert.equal(ensures[0].recoverOnly,outcome!=='no-pending');
});

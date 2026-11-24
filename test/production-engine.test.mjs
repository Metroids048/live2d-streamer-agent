import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createStageEngine} from '../src/pipeline/production-engine.mjs';
import {toolResult} from '../openclaw-plugin/results.mjs';

const identity={taskId:'one',candidateId:'one-c',revision:1,parentRevision:null,inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
async function setup(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'engine-guard-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const ctx={taskRoot:root,...identity};
  return {root,ctx};
}
const empty={loaded:false,busy:false,project_id:null,state:'s1'};
const request={request_id:'req',project_id:null,state:'s1',discard_unsaved:false};
test('a loaded foreign project is never entered or replaced; a free lease is released',async t=>{
  const {root,ctx}=await setup(t),ops=[];
  const withEngine=createStageEngine({root,client:{async call(op){ops.push(op);return {data:{...empty,loaded:true,project_id:'r02'}};}},ensureEngine:async()=>{}});
  await assert.rejects(withEngine('rigging',identity,ctx,()=>assert.fail('must not enter build')),{code:'ENGINE_PROJECT_OCCUPIED'});
  assert.deepEqual(ops,['workspace_inspect']);
  await assert.rejects(fs.stat(path.join(root,'.local/engine-lease.json')),{code:'ENOENT'});
});
test('fresh Dynamics on a dedicated empty editor can only open the current clone',async t=>{
  const {root,ctx}=await setup(t),writes=[];
  const source={...identity,stage:'rigging',status:'completed',engineProjectId:'rig'};
  const location={dir:root,args:['one','one-c','1']};
  const client={async call(op,req){
    if(op==='workspace_inspect')return {data:empty};
    writes.push([op,req.path]);return {data:{project_id:'rig',state:'s2'}};
  }};
  const withEngine=createStageEngine({root,client,location,ensureEngine:async()=>{}});
  await withEngine('dynamics',source,ctx,async c=>{
    assert.equal(c.emptyDynamicsState,empty.state);
    await assert.rejects(c.engine.call('project_open',{...request,path:path.join(root,'foreign.psd2live')}),{code:'MAKER_REJECTED'});
    const clone=path.join(root,'dynamics/character.psd2live');
    await c.engine.call('project_open',{...request,path:clone});
    assert.deepEqual(writes,[['project_open',clone]]);
  });
  await fs.mkdir(path.join(root,'dynamics'));
  await fs.writeFile(path.join(root,'dynamics/engine-journal.json'),JSON.stringify({...identity,schemaVersion:2,steps:[],pending:null}));
  await assert.rejects(withEngine('dynamics',source,ctx,()=>assert.fail('existing journal needs recovery')),{code:'ENGINE_PROJECT_OCCUPIED'});
});
test('a lost reply preserves ownership; only the exact candidate can reconcile the original job, without resubmitting',async t=>{
  const {root,ctx}=await setup(t),ops=[];let nested;
  const client={async call(op,req,opt){
    ops.push(op);if(op==='workspace_inspect')return {data:empty};
    if(op==='project_import_layout'){await opt.onJob({id:'job-owned'});throw Object.assign(new Error('lost reply'),{code:'MAKER_CONNECTION_UNKNOWN'});}
    if(op==='job_get')return {data:{id:req.id,status:'completed',terminal:true,result:{project_id:'owned',state:'s2'}}};
    assert.fail(op);
  }};
  const withEngine=createStageEngine({root,client,ensureEngine:async()=>{}});
  await assert.rejects(withEngine('rigging',identity,ctx,async c=>{
    nested=await withEngine('rigging',identity,ctx,()=>assert.fail()).catch(e=>e.code);
    return c.engine.call('project_import_layout',request);
  }),{code:'MAKER_CONNECTION_UNKNOWN'});
  assert.equal(nested,'ENGINE_BUSY');
  const lease=JSON.parse(await fs.readFile(path.join(root,'.local/engine-lease.json')));
  assert.equal(lease.pending.jobId,'job-owned');assert.equal(lease.pid,null);
  const foreign={...identity,revision:2};
  await assert.rejects(withEngine('rigging',foreign,{...ctx,...foreign},()=>assert.fail()),{code:'ENGINE_BUSY'});
  await withEngine('rigging',identity,ctx,async c=>{
    await assert.rejects(c.engine.call('job_get',{id:'job-other'}),{code:'ENGINE_PENDING_MISMATCH'});
    await assert.rejects(c.engine.call('project_import_layout',request),{code:'ENGINE_SUBMISSION_UNKNOWN'});
    assert.equal((await c.engine.call('job_get',{id:'job-owned'})).data.result.project_id,'owned');
  });
  assert.equal(ops.filter(x=>x==='project_import_layout').length,1);
  assert.equal(ops.filter(x=>x==='job_get').length,1);
});
test('tool text retained without transport flags distinguishes status of the query from the business failure',()=>{
  for(const [result,isError] of [[{ok:true,status:'blocked',error:{code:'NO_ART'}},false],[{ok:false,code:'SESSION_MISMATCH'},true]]) {
    const item=toolResult(result),payload=JSON.parse(item.content[0].text);
    assert.equal(item.isError,isError);assert.equal(payload.isError,isError);
    assert.deepEqual(payload.error,result.error);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RigSession,validateRequest} from '../src/rigging/engine.mjs';

const schema={type:'object',additionalProperties:false,properties:{state:{type:'string'},project_id:{type:'string'},request_id:{type:'string'},value:{type:'number'}},required:['state','request_id','value']};
test('原生输出契约失败可能已经提交，保留pending且禁止自动重交',async t=> {
  let edits=0;
  const engine={async call(op,req) {const q=queries(op,req);if(q)return q;edits++;throw Object.assign(new Error('unexpected result field'),{code:'MAKER_REJECTED',details:{operation:op,detail:{code:'output_contract'}}});}};
  const f=await fixture(t,engine);
  await assert.rejects(f.session.step('copy','edit',{value:3}),/unexpected result field/);
  assert.equal(f.journal.failed,undefined);assert.equal(f.journal.pending.operation,'edit');
  await assert.rejects(f.session.resume(),e=>e.code==='ENGINE_SUBMISSION_UNKNOWN');
  await assert.rejects(f.session.step('copy','edit',{value:3}),e=>e.code==='ENGINE_PENDING_OPERATION');assert.equal(edits,1);
});
test('原生拓扑预检拒绝可显式修复，仍核对原工程状态并保留失败',async t=> {
  const f=await fixture(t,{async call(op,req){return queries(op,req);}});
  f.journal.failed={key:'cut',operation:'canvas_topology',request_id:'cut-id',bodyHash:'b'.repeat(64),projectId:'owned',request:{state:'s1'},error:{code:'MAKER_REJECTED',details:{operation:'canvas_topology',detail:{code:'topology_refused'}}}};
  await f.session.recoverFailed({requestId:'cut-id',bodyHash:'b'.repeat(64),operation:'canvas_topology',repairId:'outer-edges',evidence:'Native topology preflight rejected before commit; current state remains s1.'});
  assert.equal(f.journal.failed,null);assert.equal(f.journal.repairs[0].failed.error.details.detail.code,'topology_refused');assert.equal(f.journal.done.cut,undefined);
});
async function fixture(t,engine) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rigging-engine-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await fs.mkdir(path.join(dir,'schemas'));await fs.mkdir(path.join(dir,'operation-images'));
  const journal={identity:{taskId:'test-task',candidateId:'test-candidate'},projectId:'owned',state:'s1',done:{},pending:null};
  return {dir,journal,session:new RigSession({engine},dir,journal)};
}
function queries(op,req,state='s1') {
  if(op==='workspace_get_operation')return {data:{id:req.id,request_schema:schema}};
  if(op==='workspace_inspect')return {data:{project_id:'owned',state,busy:false}};
}

test('恢复时使用编辑前的规划输入，已提交的步骤不重复编辑',async t=> {
  let edits=0,state='s1',liveValue=3;
  const engine={async call(op,req) {
    const q=queries(op,req,state);if(q)return q;
    edits++;state='s2';liveValue=7;
    return {data:{project_id:'owned',state}};
  }};
  const f=await fixture(t,engine);f.journal.planning={};
  const run=async session=>{
    const value=await session.capturePlan('before-shape',async()=>liveValue);
    return session.step('shape','edit',{value});
  };
  await run(f.session);
  const saved=JSON.parse(await fs.readFile(path.join(f.dir,'state.json'),'utf8'));
  const restored=new RigSession({engine},f.dir,saved);
  await run(restored);
  assert.equal(edits,1);
  await assert.rejects(restored.step('shape','edit',{value:7}),{code:'RECIPE_CHANGED_USE_NEW_CANDIDATE'});
});

test('绑定日志压缩安全坐标明细，保留原生即时回执、警告和操作身份',async t=> {
  let state='s1';
  const diagnostics=[{vertex:8,coordinate:[1,2]}];
  const engine={async call(op,req) {
    const q=queries(op,req,state);if(q)return q;
    state='s'+req.value;
    return {data:{project_id:'owned',state,history_node_id:'history-'+req.value,geometry_diagnostics:{
      safe:true,warnings:req.value===3?['near-limit']:[],violations:[],checkedVertexCount:1,diagnostics,
    }}};
  }};
  const f=await fixture(t,engine),checkpoints=[];
  f.session.ctx.checkpoint=async value=>checkpoints.push(value);
  const clean=await f.session.step('clean','edit',{value:2});
  await f.session.step('warned','edit',{value:3});
  const {done}=JSON.parse(await fs.readFile(path.join(f.dir,'state.json'),'utf8'));
  assert.deepEqual(clean.data.geometry_diagnostics.diagnostics,diagnostics);
  assert.deepEqual(done.clean.data.geometry_diagnostics,{
    safe:true,warnings:[],violations:[],checkedVertexCount:1,coordinateReportCount:1,
  });
  assert.equal(done.clean.data.history_node_id,'history-2');
  assert.deepEqual(done.warned.data.geometry_diagnostics.diagnostics,diagnostics);
  assert.equal(checkpoints.at(-1).completedSteps,2);
  assert.equal(checkpoints.at(-1).done,undefined);
});

test('提交前持久化 request_id；未知回执恢复不重交',async t=> {
  let edits=0,dir;
  const engine={async call(op,req) {
    const q=queries(op,req);if(q)return q;
    edits++;const saved=JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8'));
    assert.equal(saved.pending.request_id,req.request_id);assert.equal(saved.pending.operation,'edit');
    throw Object.assign(new Error('connection lost after accept'),{code:'MAKER_CONNECTION_UNKNOWN'});
  }};
  const f=await fixture(t,engine);dir=f.dir;
  await assert.rejects(f.session.step('shape','edit',{value:3}),/connection lost/);
  const saved=JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8'));
  const restored=new RigSession({engine},dir,saved);
  await assert.rejects(restored.resume(),e=>e.code==='ENGINE_SUBMISSION_UNKNOWN');assert.equal(edits,1);assert(saved.pending.request_id);
});

test('已经接单的 job 断连只查询原 job，恢复完成的步骤不再次执行',async t=> {
  let edits=0,queriesCount=0;
  const engine={async call(op,req,options) {
    const q=queries(op,req);if(q)return q;
    if(op==='job_get') {queriesCount++;assert.equal(req.id,'job-original');return {data:{id:req.id,terminal:true,status:'completed',project_id:'owned',result:{project_id:'owned',state:'s2',applied:true}}};}
    edits++;await options.onJob({id:'job-original',terminal:false,status:'running'});throw new Error('stream interrupted');
  }};
  const f=await fixture(t,engine);await assert.rejects(f.session.step('shape','edit',{value:5}),/interrupted/);
  const restored=new RigSession({engine},f.dir,JSON.parse(await fs.readFile(path.join(f.dir,'state.json'),'utf8')));
  await restored.resume();const result=await restored.step('shape','edit',{value:5});
  assert.equal(result.data.state,'s2');assert.equal(edits,1);assert.equal(queriesCount,1);assert.equal(restored.journal.pending,null);
  await assert.rejects(restored.step('shape','edit',{value:6}),e=>e.code==='RECIPE_CHANGED_USE_NEW_CANDIDATE');
});

test('切工程/外部修改后停止，不能对新活动工程写入',async t=> {
  let edits=0;
  const engine={async call(op,req) {if(op==='workspace_inspect')return {data:{project_id:'other',state:'s1'}};const q=queries(op,req);if(q)return q;edits++;return {data:{}};}};
  const f=await fixture(t,engine);await assert.rejects(f.session.step('shape','edit',{value:2}),e=>e.code==='ENGINE_PROJECT_CHANGED');assert.equal(edits,0);
  engine.call=async(op,req)=>op==='workspace_inspect'?{data:{project_id:'owned',state:'s-new'}}:queries(op,req);
  await assert.rejects(f.session.step('shape','edit',{value:2}),e=>e.code==='ENGINE_STATE_CHANGED');
});

test('终态 job 失败保留失败记录，不能通过重调同候选变成新尝试',async t=> {
  let edits=0;
  const engine={async call(op,req) {const q=queries(op,req);if(q)return q;edits++;return {data:{id:'job-failed',terminal:true,status:'failed',error:{message:'unsafe geometry'}}};}};
  const f=await fixture(t,engine);await assert.rejects(f.session.step('shape','edit',{value:3}),e=>e.code==='ENGINE_JOB_FAILED');
  assert.equal(f.journal.pending,null);assert.equal(f.journal.failed.jobId,'job-failed');
  await assert.rejects(f.session.resume(),e=>e.code==='PREVIOUS_ENGINE_OPERATION_FAILED');assert.equal(edits,1);
  await assert.rejects(f.session.step('shape','edit',{value:3}),e=>e.code==='PREVIOUS_ENGINE_OPERATION_FAILED');assert.equal(edits,1);
});

test('显式定位修复核原失败job与工程，保留失败且使用新request_id',async t=> {
  const ids=[];let recovered=false;
  const engine={async call(op,req) {
    const q=queries(op,req);if(q)return q;
    if(op==='job_get')return {data:{id:'job-failed',terminal:true,status:'failed',project_id:'owned',input_state:'s1',error:{message:'native bug'}}};
    ids.push(req.request_id);
    return recovered?{data:{project_id:'owned',state:'s2'}}:{data:{id:'job-failed',terminal:true,status:'failed',error:{message:'native bug'}}};
  }};
  const f=await fixture(t,engine);
  await assert.rejects(f.session.step('shape','edit',{value:3}),e=>e.code==='ENGINE_JOB_FAILED');
  await assert.rejects(f.session.recoverFailed({requestId:'wrong',jobId:'job-failed',repairId:'patch-sha',evidence:'evidence.json'}),e=>e.code==='ENGINE_REPAIR_MISMATCH');
  await f.session.recoverFailed({requestId:ids[0],jobId:'job-failed',bodyHash:f.journal.failed.bodyHash,repairId:'patch-sha',evidence:'evidence.json'});
  assert.equal(f.journal.repairs[0].failed.request_id,ids[0]);assert.equal(f.journal.done.shape,undefined);
  assert.equal(f.journal.state,'s1');recovered=true;
  await f.session.resume();await f.session.step('shape','edit',{value:3});
  assert.notEqual(ids[1],ids[0]);assert.equal(f.journal.done.shape.request_id,ids[1]);
});

test('修复入口拒绝非终态、成功job和外部改动，保持failed',async t=> {
  let status='running',state='s1';
  const engine={async call(op,req) {
    if(op==='job_get')return {data:{id:req.id,terminal:status!=='running',status,project_id:'owned',input_state:'s1'}};
    return queries(op,req,state);
  }};
  const f=await fixture(t,engine);f.journal.failed={key:'shape',request_id:'old',jobId:'job-old',bodyHash:'a'.repeat(64),projectId:'owned',request:{state:'s1'}};
  const repair={requestId:'old',jobId:'job-old',bodyHash:'a'.repeat(64),repairId:'patch-sha',evidence:'evidence.json'};
  await assert.rejects(f.session.recoverFailed(repair),e=>e.code==='ENGINE_REPAIR_NOT_TERMINAL');
  status='completed';await assert.rejects(f.session.recoverFailed(repair),e=>e.code==='ENGINE_REPAIR_NOT_TERMINAL');
  status='failed';state='other';await assert.rejects(f.session.recoverFailed(repair),e=>e.code==='ENGINE_STATE_CHANGED');
  assert.equal(f.journal.failed.request_id,'old');assert.equal(f.journal.repairs,undefined);
});

test('受控重开只接受同HEAD同内容，按真实回执更新世代且保留原失败请求',async t=> {
  const engine={async call(op,req){return {data:{project_id:'owned',state:'new-load:1:0',loaded:true,busy:false,history_node_id:'head'}};}};
  const f=await fixture(t,engine);f.journal.failed={key:'shape',request_id:'old',jobId:'job-old',bodyHash:'a'.repeat(64),projectId:'owned',request:{state:'s1'}};
  const proof={before:{projectId:'owned',state:'s1',historyNodeId:'head',revision:'revision-sha'},after:{projectId:'owned',state:'new-load:1:0',historyNodeId:'head',revision:'revision-sha'},
    contentHashes:Object.fromEntries(['document','configuration','layers'].map(k=>[k,{before:'b'.repeat(64),after:'b'.repeat(64)}])),
    openReceipt:{project_id:'owned',state:'new-load:1:0',history_node_id:'head'}};
  const repair={requestId:'old',jobId:'job-old',bodyHash:'a'.repeat(64),repairId:'patch-sha',evidence:'native-before-reload.json',archivedReceipt:{id:'job-old',terminal:true,status:'failed',project_id:'owned',input_state:'s1'},controlledReopen:proof};
  const bad=structuredClone(repair);bad.controlledReopen.contentHashes.layers.after='c'.repeat(64);
  await assert.rejects(f.session.recoverFailed(bad),e=>e.code==='ENGINE_REPAIR_REOPEN_MISMATCH');
  const foreign=structuredClone(repair);foreign.controlledReopen.after.projectId='other';
  await assert.rejects(f.session.recoverFailed(foreign),e=>e.code==='ENGINE_REPAIR_REOPEN_MISMATCH');
  await f.session.recoverFailed(repair);
  assert.equal(f.journal.state,'new-load:1:0');assert.equal(f.journal.repairs[0].failed.request.state,'s1');assert.equal(f.journal.done.shape,undefined);
});

test('job 等待保存回执且保留最终图像；不让公共 client 偷等丢图',async t=> {
  const image=Buffer.from('synthetic image bytes, not visual evidence');let waits=0;
  const engine={async call(op,req,options) {
    assert.equal(options.wait,false);assert.equal(options.unwrap,false);
    const q=queries(op,req);if(q)return q;
    if(op==='job_wait') {waits++;assert.equal(req.timeout_ms,30000);return {data:{id:'job-x',terminal:true,status:'completed',result:{project_id:'owned',state:'s2'}},images:[image]};}
    return {data:{id:'job-x',terminal:false,status:'running'}};
  }};
  const f=await fixture(t,engine),r=await f.session.step('shape','edit',{value:1});assert.equal(waits,1);assert.deepEqual(r.images,[image]);
  assert.deepEqual(await fs.readFile(path.join(f.dir,f.journal.done.shape.imageFiles[0])),image);
});

test('运行时 schema 校验拒绝未知字段、缺状态、错误轴与越界，不提交',()=> {
  assert.throws(()=>validateRequest({value:2},schema),e=>e.code==='ENGINE_REQUEST_SCHEMA');
  assert.throws(()=>validateRequest({state:'s',request_id:'id',value:2,guessed_field:true},schema),e=>e.code==='ENGINE_REQUEST_SCHEMA');
  assert.throws(()=>validateRequest([0,2],{type:'array',items:{type:'number',minimum:-1,maximum:1}}),e=>e.code==='ENGINE_REQUEST_SCHEMA');
  assert.throws(()=>validateRequest(Infinity,{type:'number'}),e=>e.code==='ENGINE_REQUEST_SCHEMA');
  assert.doesNotThrow(()=>validateRequest({state:'s',request_id:'id',value:2},schema));
});

test('回执缺少实际 state 时保留 pending，不能把空成功对象记成完成',async t=> {
  let edits=0;
  const engine={async call(op,req){const q=queries(op,req);if(q)return q;edits++;return {data:{applied:true}};}};
  const f=await fixture(t,engine);
  await assert.rejects(f.session.step('shape','edit',{value:1}),e=>e.code==='ENGINE_RESULT_IDENTITY_MISSING');
  assert(f.journal.pending.request_id);assert.equal(f.journal.done.shape,undefined);
  await assert.rejects(f.session.resume(),e=>e.code==='ENGINE_SUBMISSION_UNKNOWN');assert.equal(edits,1);
});

test('明确未接单的invalid_argument拒绝可显式修复，保留原body且不伪造job',async t=>{
 const ids=[];let fixed=false,jobQueries=0;
 const engine={async call(op,req){const q=queries(op,req);if(q)return q;if(op==='job_get'){jobQueries++;throw Error('no accepted job');}
 ids.push(req.request_id);if(!fixed)throw Object.assign(Error('Specify the exact destination key'),{code:'MAKER_REJECTED',details:{operation:'edit',detail:{code:'invalid_argument'}}});
 return {data:{state:'s2',project_id:'owned'}};}};
 const f=await fixture(t,engine);await assert.rejects(f.session.step('shape','edit',{value:1}),e=>e.code==='MAKER_REJECTED');
 const original=structuredClone(f.journal.failed),repair={requestId:original.request_id,bodyHash:original.bodyHash,operation:'edit',repairId:'omit-empty-cell',evidence:'native-inspect.json'};
 await assert.rejects(f.session.resume(),e=>e.code==='PREVIOUS_ENGINE_OPERATION_FAILED');
 await assert.rejects(f.session.recoverFailed({...repair,operation:'other'}),e=>e.code==='ENGINE_REPAIR_MISMATCH');
 await f.session.recoverFailed(repair);assert.deepEqual(f.journal.repairs[0].failed,original);assert.equal(f.journal.done.shape,undefined);assert.equal(jobQueries,0);
 fixed=true;await f.session.step('shape','edit',{value:2});assert.notEqual(ids[0],ids[1]);assert.equal(f.journal.repairs[0].receiptOrigin,'rejected-before-accept');
});

test('未知提交或拒绝状态变化不能走无job修复',async t=>{
 let state='s1';const f=await fixture(t,{async call(op,req){return queries(op,req,state);}});
 f.journal.failed={key:'shape',request_id:'id',operation:'edit',bodyHash:'a'.repeat(64),projectId:'owned',request:{state:'s1'},error:{code:'MAKER_CONNECTION_UNKNOWN'}};
 const repair={requestId:'id',operation:'edit',bodyHash:'a'.repeat(64),repairId:'fix',evidence:'inspect.json'};
 await assert.rejects(f.session.recoverFailed(repair),e=>e.code==='ENGINE_REPAIR_MISMATCH');
 f.journal.failed.error={code:'MAKER_REJECTED',details:{operation:'edit',detail:{code:'invalid_argument'}}};state='changed';
 await assert.rejects(f.session.recoverFailed(repair),e=>e.code==='ENGINE_STATE_CHANGED');assert.equal(f.journal.failed.request_id,'id');
});

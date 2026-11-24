import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {advanceModelPipeline} from '../src/pipeline/model-stages.mjs';

const source={schemaVersion:1,stage:'artwork',status:'completed',taskId:'task',candidateId:'candidate',revision:2,parentRevision:1,inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64),artifacts:[],checks:[],unresolved:[]};
const stage=(name,extra={})=>({...source,stage:name,...extra});
test('no engine handle stops before editor mutations',async()=>{
  let calls=0;
  const result=await advanceModelPipeline(source,{}, {loadStage:async()=>null,rig:async()=>{calls++;}});
  assert.equal(result.error.code,'ENGINE_LEASE_PENDING');assert.equal(calls,0);
});
test('stage order and visual review remain explicit',async()=>{
  const calls=[];
  const result=await advanceModelPipeline(source,{engine:{call(){}}},{loadStage:async()=>null,
    rig:async()=>{calls.push('rig');return stage('rigging');},
    dynamics:async()=>{calls.push('dynamics');return stage('dynamics',{status:'blocked',unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]});},
    preview:async b=>{calls.push('preview');return {...b,previewCapture:{recorded:true}};},packageModel:async()=>{calls.push('packaging');}});
  assert.deepEqual(calls,['rig','dynamics','preview']);assert.equal(result.status,'blocked');assert.equal(result.bundle.previewCapture.recorded,true);
});
test('only completed same-candidate stages reach packaging',async()=>{
  const calls=[];
  const f=name=>async()=>{calls.push(name);return stage(name);};
  const result=await advanceModelPipeline(source,{engine:{call(){}}},{loadStage:async()=>null,rig:f('rigging'),dynamics:f('dynamics'),packageModel:f('packaging')});
  assert.equal(result.status,'completed');assert.deepEqual(calls,['rigging','dynamics','packaging']);
  await assert.rejects(advanceModelPipeline(source,{engine:{call(){}}},{loadStage:async()=>null,rig:async()=>stage('rigging',{revision:'2'})}),{code:'PIPELINE_IDENTITY_MISMATCH'});
});
test('saved stages reject another identity and changed artifact bytes',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-stage-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'rigging'));const file=path.join(root,'rigging/stage.json');
  await fs.writeFile(file,JSON.stringify(stage('rigging',{revision:'2'})));
  await assert.rejects(advanceModelPipeline(source,{taskRoot:root}),{code:'PIPELINE_IDENTITY_MISMATCH'});
  await fs.writeFile(path.join(root,'model'),'changed');await fs.writeFile(file,JSON.stringify(stage('rigging',{artifacts:[{path:'model',bytes:7,sha256:'c'.repeat(64)}]})));
  await assert.rejects(advanceModelPipeline(source,{taskRoot:root}),{code:'REFERENCE_INVALID'});
});

test('resume captures an existing unreviewed dynamics stage without rebuilding it',async()=>{
  const calls=[],completed=[];
  const waiting=stage('dynamics',{status:'blocked',unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]});
  const result=await advanceModelPipeline(source,{engine:{call(){}},stageCompleted:stage=>completed.push(stage)},{
    loadStage:async name=>name==='rigging'?stage(name):name==='dynamics'?waiting:null,
    rig:async()=>assert.fail('must reuse saved rig'),
    dynamics:async()=>assert.fail('must not rebuild existing dynamics'),
    preview:async b=>{calls.push('preview');return {...b,previewCapture:{recorded:true}};},
    packageModel:async()=>assert.fail('unreviewed output cannot be packaged')
  });
  assert.deepEqual(calls,['preview']);assert.equal(result.bundle.previewCapture.recorded,true);
  assert.deepEqual(completed,['rigging']);
  assert.equal(result.status,'blocked');
});

test('saved preview recovery requires an engine and never captures an already captured or wrong candidate',async()=>{
  let captures=0;
  const waiting=stage('dynamics',{status:'blocked',unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]});
  const deps=b=>({loadStage:async name=>name==='rigging'?stage(name):b,preview:async()=>{captures++;}});
  const result=await advanceModelPipeline(source,{},deps(waiting));
  assert.equal(result.error.code,'ENGINE_LEASE_PENDING');assert.equal(captures,0);
  await advanceModelPipeline(source,{engine:{call(){}}},deps({...waiting,previewCapture:{recorded:true}}));
  assert.equal(captures,0);
  await assert.rejects(advanceModelPipeline(source,{engine:{call(){}}},deps({...waiting,revision:'2'})),{code:'PIPELINE_IDENTITY_MISMATCH'});
  assert.equal(captures,0);
});

test('same candidate recovery uses the rig as dynamics input and hands a recovered preview to the visual review gate',async()=>{
  const rig=stage('rigging'),waiting=stage('dynamics',{status:'awaiting_external_result',unresolved:[{code:'EXTERNAL_RESULT_UNKNOWN'}]});
  for(const capture of [false,true]){
    const blocked=stage('dynamics',{status:'blocked',unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]});
    const d=capture?{...waiting,previewCapture:{status:'awaiting_external_result'}}:waiting;
    const calls=[];
    const r=await advanceModelPipeline(source,{withEngine:async(name,input,ctx,run)=>{
      assert.equal(name,'dynamics');assert.equal(ctx.recoverDynamics,true);return run(ctx);
    }},{loadStage:async name=>name==='rigging'?rig:d,
      dynamics:async input=>{assert.equal(input,rig);calls.push('build');return blocked;},
      preview:async input=>{assert.equal(input,capture?d:blocked);calls.push('preview');return {...blocked,previewCapture:{status:'captured'}};},
      packageModel:()=>assert.fail('must not publish before visual review')});
    assert.deepEqual(calls,capture?['preview']:['build','preview']);
    assert.equal(r.bundle.previewCapture.status,'captured');
  }
});

test('saved completed packaging is revalidated against the current HD contract without rebuilding stages',async()=>{
  const saved={rigging:stage('rigging'),dynamics:stage('dynamics'),packaging:stage('packaging')};
  const ctx={buildHdPreview:()=>assert.fail('historical package must not render again')};let validations=0;
  const deps={loadStage:async name=>saved[name],rig:()=>assert.fail('saved rig'),dynamics:()=>assert.fail('saved dynamics'),
    packageModel:async(input,current)=>{validations++;assert.equal(input,saved.dynamics);assert.equal(current,ctx);
      throw Object.assign(new Error('Historical package lacks HD contract'),{code:'REFERENCE_INVALID'});}};
  await assert.rejects(advanceModelPipeline(source,ctx,deps),{code:'REFERENCE_INVALID'});
  assert.equal(validations,1);
  deps.packageModel=async(input,current)=>{validations++;assert.equal(input,saved.dynamics);assert.equal(current,ctx);return saved.packaging;};
  const result=await advanceModelPipeline(source,ctx,deps);
  assert.equal(result.bundle,saved.packaging);assert.equal(validations,2);
});

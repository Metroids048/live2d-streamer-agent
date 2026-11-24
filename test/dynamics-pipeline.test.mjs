import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {buildDynamics,inspectDynamicsExport,inspectDynamicsPending} from '../src/dynamics/index.mjs';
import {artifact,writeJson} from '../src/dynamics/files.mjs';

// All engine responses and all model/archive/PNG bytes below are synthetic boundary fixtures.
// No PSD2Live process, camera, runtime or real model is used by this test file.
const evidenceRoot=path.resolve('evidence/single-image-live2d/04');
async function setup(t,identityOverride={}) {
  await fs.mkdir(evidenceRoot,{recursive:true});
  const root=await fs.mkdtemp(path.join(evidenceRoot,'.test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'rigging'));
  const identity={taskId:'fixture-task',candidateId:'fixture-candidate',revision:'fixture-r1',parentRevision:null,
    inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64),...identityOverride};
  const p=(id,semantic)=>({id,semantic,min:semantic==='body.breath'?0:-1,max:1,default:0,owner:'rigging',available:true,
    targets:['mesh:'+id],bindings:[{target:'mesh:'+id,directAxes:{[id]:[-1,0,1]}}],
    motionEvidence:[{value:1,defaultImage:'rigging/default.png',posedImage:'rigging/posed.png',changedPixels:10,totalPixels:100}]});
  const map={schemaVersion:1,...identity,engineVersion:'3.6.7',projectId:'fixture-parent',state:'state-parent',
    requested:{expressions:[{id:'happy',label:'开心'},{id:'angry',label:'生气'}],actions:[{id:'reset'}]},
    parameters:[p('yaw','head.yaw'),p('roll','head.roll'),p('front','hair.front'),p('back','hair.back'),
      p('breath','body.breath'),p('brow','brow.left'),p('smile','eyes.emotion'),p('corners','mouth.form')]};
  const files={'rigging/parent.psd2live':'fixture archive','rigging/layers.psd':'fixture PSD','rigging/base.model3.json':'{}',
    'rigging/default.png':'fixture neutral PNG bytes','rigging/posed.png':'fixture posed PNG bytes'};
  for(const [file,bytes] of Object.entries(files))await fs.writeFile(path.join(root,file),bytes);
  await writeJson(path.join(root,'rigging/parameter-map.json'),map);
  const rig={schemaVersion:1,...identity,stage:'rigging',status:'completed',engineVersion:'3.6.7',projectId:map.projectId,engineState:map.state,
    projectPath:'rigging/parent.psd2live',psdPath:'rigging/layers.psd',modelPath:'rigging/base.model3.json',parameterMapPath:'rigging/parameter-map.json',
    artifacts:[],checks:[],warnings:[],unresolved:[]};
  const refresh=async()=>{rig.artifacts=await Promise.all([...Object.keys(files),'rigging/parameter-map.json'].map(f=>artifact(root,f,'fixture')));};
  await refresh();
  return {root,rig,map,refresh,ctx:{taskRoot:root,...identity}};
}

function segments(keys) {
  const result=[keys[0].time,keys[0].value];
  for(let i=0;i<keys.length-1;i++) {
    const a=keys[i],b=keys[i+1],span=(b.time-a.time)/3;
    result.push(1,a.time+span,a.value,b.time-span,b.value,b.time,b.value);
  }
  return result;
}

// Models only the documented call schema and file boundary; this is not an emulator or model generator.
function engineFixture(root,{fail,active=true,readbackTransform=c=>c}={}) {
  const calls=[],expressions=[],clips=[],physics=[];let project='fixture-parent',state='state-parent',n=0,clone;
  return {calls,async call(operation,request={},options={}) {
    calls.push({operation,request});
    if(fail&&operation===fail.operation) {
      await options.onJob?.({id:'job-fixture-unknown',status:'running'});
      const error=new Error('synthetic engine failure');error.code=fail.code;throw error;
    }
    if(operation==='workspace_inspect')return {data:request.scope==='physics'?{groups:physics.map(g=>({...g,active}))}:
      {loaded:true,busy:false,project_id:project,state}};
    if(operation==='expression_list')return {data:{expressions}};
    if(operation==='motion_get')return {data:{clip:readbackTransform(structuredClone(clips.find(c=>c.id===request.id)))}};
    assert.equal(request.project_id,project);assert.equal(request.state,state);
    assert.match(request.request_id,/^dyn-[a-f0-9]+$/);
    if(operation==='project_open') {clone=request.path;project='fixture-clone';}
    else if(operation==='settings_update')for(const key of ['physicsFrontHair','physicsBackHair','physicsEyeJelly'])
      assert.equal(request.changes[key],false,key+' must not compound or delay the authored axes');
    else if(operation==='expression_put'){
      assert.ok(request.expression.entries.every(v=>v.blend==='ADD'),'PSD2Live 3.6.7 editor enum');
      if(request.expression.name==='生气')assert.equal(request.expression.id,'angry','replace the existing localized standard expression');
      expressions.push(request.expression);
    }
    else if(operation==='motion_put')clips.push(request.clip);
    else if(operation==='physics_put')physics.push(request);
    else if(operation==='project_save_as')await fs.writeFile(clone,'fixture cloned archive with authored resources');
    else if(operation==='project_export_model') {
      const dir=request.output_directory,write=(f,v)=>writeJson(path.join(dir,f),v);
      await fs.writeFile(path.join(dir,'fixture.moc3'),'fixture, not a real moc3');
      await fs.writeFile(path.join(dir,'texture.png'),'fixture, not a real texture');
      const model={Version:3,FileReferences:{Moc:'fixture.moc3',Textures:['texture.png'],Physics:'fixture.physics3.json',Expressions:[],Motions:{Idle:[]}}};
      await write('fixture.physics3.json',{Version:3,Meta:{Fps:60},PhysicsSettings:physics.map(g=>({Id:g.id,
        Input:g.inputs.map(v=>({Source:{Target:'Parameter',Id:v.parameter},Weight:v.weight,Type:v.type==='angle'?'Angle':'X',Reflect:v.reflect})),
        Output:g.outputs.map(v=>({Destination:{Target:'Parameter',Id:v.parameter},VertexIndex:v.vertex,Scale:v.scale,Weight:v.weight,Type:'Angle',Reflect:v.reflect})),
        Vertices:[{},...g.segments.map(v=>({Radius:v.length,Mobility:v.mobility,Delay:v.delay,Acceleration:v.acceleration}))],
        Normalization:Object.fromEntries(Object.entries(g.normalization).map(([k,v])=>[k==='position'?'Position':'Angle',{Minimum:v.min,Default:v.default,Maximum:v.max}]))}))});
      for(const e of expressions) {
        const file=e.id+'.exp3.json';await write(file,{Type:'Live2D Expression',FadeInTime:e.fade_in,FadeOutTime:e.fade_out,
          Parameters:e.entries.map(v=>({Id:v.parameter,Value:v.value,Blend:v.blend==='ADD'?'Add':v.blend}))});
        model.FileReferences.Expressions.push({Name:e.name,File:file});
      }
      for(const c of clips) {
        const file=c.id+'.motion3.json';await write(file,{Version:3,Meta:{Duration:c.duration,Loop:c.loop,Fps:c.fps},
          Curves:c.curves.map(v=>({Target:'Parameter',Id:v.parameter,Segments:segments(v.keys)}))});
        model.FileReferences.Motions.Idle.push({File:file});
      }
      await write('fixture.model3.json',model);
    }
    state='state-'+(++n);return {data:{project_id:project,state}};
  }};
}

test('numeric revision identity from the real r2 entry stays numeric and rejects string aliases',async t=>{
  const f=await setup(t,{revision:2,parentRevision:1}),engine=engineFixture(f.root);
  await assert.rejects(buildDynamics(f.rig,{...f.ctx,revision:'2',engine}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  await assert.rejects(buildDynamics(f.rig,{...f.ctx,parentRevision:'1',engine}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  assert.equal(engine.calls.length,0);
  const result=await buildDynamics(f.rig,{...f.ctx,engine});
  assert.equal(result.status,'blocked');
  assert.ok(result.unresolved.some(u=>u.code==='DYNAMICS_VISUAL_NOT_RUN'));
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,result.dynamicsManifestPath),'utf8'));
  for(const value of [result,manifest]) {
    assert.equal(value.revision,2);assert.equal(value.parentRevision,1);
  }
  const first=await setup(t,{revision:1,parentRevision:null});
  const waiting=await buildDynamics(first.rig,first.ctx);
  assert.equal(waiting.revision,1);assert.equal(waiting.parentRevision,null);
  assert.ok(waiting.unresolved.some(u=>u.code==='ENGINE_BUSY'));
});

test('upstream blocker is preserved and every unobserved acceptance layer remains not_run',async t=>{
  const f=await setup(t);f.rig.status='blocked';f.rig.unresolved.push({code:'SOURCE_SHAPE_MISSING'});
  const r=await buildDynamics(f.rig,f.ctx);
  assert.equal(r.status,'blocked');assert.ok(r.unresolved.some(u=>u.code==='RIG_NOT_READY'));
  for(const layer of ['visual','runtime','human','user_acceptance'])assert.equal(r.checks.find(c=>c.layer===layer).status,'not_run');
});

test('a ready recipe without injected exclusive engine cannot mutate the parent',async t=>{
  const f=await setup(t),before=await fs.readFile(path.join(f.root,f.rig.projectPath));
  const r=await buildDynamics(f.rig,f.ctx);assert.equal(r.status,'blocked');
  assert.ok(r.unresolved.some(u=>u.code==='ENGINE_BUSY'));
  assert.deepEqual(await fs.readFile(path.join(f.root,f.rig.projectPath)),before);
});

test('clone authoring, indexed export and reopen are checked; simulated success never claims visual acceptance',async t=>{
  const f=await setup(t),engine=engineFixture(f.root),before=await fs.readFile(path.join(f.root,f.rig.projectPath));
  const r=await buildDynamics(f.rig,{...f.ctx,engine});
  assert.equal(r.status,'blocked');assert.ok(r.unresolved.some(u=>u.code==='DYNAMICS_VISUAL_NOT_RUN'));
  assert.equal(r.checks.find(c=>c.name==='dynamics.export-and-reopen').status,'passed');
  assert.equal(r.projectPath,'dynamics/character.psd2live');assert.match(r.modelPath,/^dynamics\/model\//);
  assert.deepEqual(await fs.readFile(path.join(f.root,f.rig.projectPath)),before);
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,r.dynamicsManifestPath),'utf8'));
  assert.equal(manifest.expressions.length,2);assert.equal(manifest.motions.length,1);assert.equal(manifest.exportStatus,'exported');
  assert.ok(!JSON.stringify(manifest).includes('sessionKey":"'));
  const count=engine.calls.length;
  assert.deepEqual(await buildDynamics(f.rig,{...f.ctx,engine}),r);assert.equal(engine.calls.length,count,'no same-candidate resubmission');
});

test('modified motion key values cannot pass using matching IDs/duration alone',async t=>{
  const f=await setup(t),r=await buildDynamics(f.rig,{...f.ctx,engine:engineFixture(f.root)});
  const recipe=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/recipe.json'),'utf8'));
  const file=path.join(f.root,'dynamics/model/dyn_idle.motion3.json'),motion=JSON.parse(await fs.readFile(file,'utf8'));
  motion.Curves[0].Segments[8]=.9;await writeJson(file,motion);
  await assert.rejects(inspectDynamicsExport(f.root,r.modelPath,recipe),{code:'DYNAMICS_EXPORT_INVALID'});
  await assert.rejects(buildDynamics(f.rig,f.ctx),{code:'REFERENCE_INVALID'});
});

test('expression present on disk but absent from model3 is rejected',async t=>{
  const f=await setup(t),r=await buildDynamics(f.rig,{...f.ctx,engine:engineFixture(f.root)});
  const recipe=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/recipe.json'),'utf8'));
  const file=path.join(f.root,r.modelPath),model=JSON.parse(await fs.readFile(file,'utf8'));
  model.FileReferences.Expressions=[];await writeJson(file,model);
  await assert.rejects(inspectDynamicsExport(f.root,r.modelPath,recipe),{code:'DYNAMICS_EXPORT_INVALID'});
});

test('physics duplicate writers and changed normalization are rejected in the actual indexed file',async t=>{
  const f=await setup(t),r=await buildDynamics(f.rig,{...f.ctx,engine:engineFixture(f.root)});
  const recipe=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/recipe.json'),'utf8'));
  const file=path.join(f.root,'dynamics/model/fixture.physics3.json'),data=JSON.parse(await fs.readFile(file,'utf8'));
  data.PhysicsSettings[0].Normalization.Angle.Maximum=60;await writeJson(file,data);
  await assert.rejects(inspectDynamicsExport(f.root,r.modelPath,recipe),{code:'DYNAMICS_EXPORT_INVALID'});
  data.PhysicsSettings[0].Normalization.Angle.Maximum=30;
  data.PhysicsSettings.push({...data.PhysicsSettings[0],Id:'fixture-duplicate'});await writeJson(file,data);
  await assert.rejects(inspectDynamicsExport(f.root,r.modelPath,recipe),{code:'DYNAMICS_EXPORT_INVALID'});
});

test('a reopened archive with different interpolation cannot inherit the export check',async t=>{
  const f=await setup(t),engine=engineFixture(f.root,{readbackTransform:clip=>{
    clip.curves[0].keys[0].interpolation='LINEAR';return clip;
  }});
  const r=await buildDynamics(f.rig,{...f.ctx,engine});assert.equal(r.status,'failed');
  assert.equal(r.unresolved.at(-1).code,'DYNAMICS_REOPEN_INVALID');
  assert.ok(!r.checks.some(c=>c.name==='dynamics.export-and-reopen'&&c.status==='passed'));
});

test('unknown accepted job keeps operation checkpoint and a repeat never submits again',async t=>{
  const f=await setup(t),engine=engineFixture(f.root,{fail:{operation:'project_open',code:'MAKER_HTTP'}});
  const r=await buildDynamics(f.rig,{...f.ctx,engine});
  assert.equal(r.status,'awaiting_external_result');assert.equal(r.unresolved.at(-1).jobId,'job-fixture-unknown');
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/engine-journal.json'),'utf8'));
  assert.equal(journal.pending.operation,'project_open');assert.equal(journal.pending.jobId,'job-fixture-unknown');
  const count=engine.calls.length;await buildDynamics(f.rig,{...f.ctx,engine});assert.equal(engine.calls.length,count);
});

test('explicit engine rejection is failed, with durable failure and no retained live pending',async t=>{
  const f=await setup(t),engine=engineFixture(f.root,{fail:{operation:'project_open',code:'MAKER_REJECTED'}});
  const r=await buildDynamics(f.rig,{...f.ctx,engine});assert.equal(r.status,'failed');
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/engine-journal.json'),'utf8'));
  assert.equal(journal.pending,null);assert.equal(journal.failure.code,'MAKER_REJECTED');
});

test('pending inspection queries only the original job and never resumes edits after its terminal response',async t=>{
  const f=await setup(t);
  await buildDynamics(f.rig,{...f.ctx,engine:engineFixture(f.root,{fail:{operation:'project_open',code:'MAKER_NO_REPLY'}})});
  const calls=[];
  const engine={call:async(operation,request)=>{calls.push({operation,request});return {data:{id:'job-fixture-unknown',terminal:true,status:'completed'}};}};
  const r=await inspectDynamicsPending({...f.ctx,engine});
  assert.equal(r.status,'blocked');assert.equal(r.jobStatus,'completed');
  assert.deepEqual(calls,[{operation:'job_get',request:{id:'job-fixture-unknown'}}]);
  await assert.rejects(inspectDynamicsPending({...f.ctx,taskId:'foreign-task',engine}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  assert.equal(calls.length,1);
});

test('03 engineProjectId/engineRevision aliases and inherited binding axes are consumed',async t=>{
  const f=await setup(t);f.rig.engineProjectId=f.rig.projectId;delete f.rig.projectId;
  f.rig.engineRevision=f.rig.engineState;delete f.rig.engineState;
  const p=f.map.parameters[0];p.bindings[0].inherited=[{target:'warp:head',axes:p.bindings[0].directAxes}];p.bindings[0].directAxes={};
  await writeJson(path.join(f.root,f.rig.parameterMapPath),f.map);await f.refresh();
  const r=await buildDynamics(f.rig,{...f.ctx,engine:engineFixture(f.root)});
  assert.ok(r.checks.some(c=>c.name==='dynamics.export-and-reopen'&&c.status==='passed'));
  assert.equal(r.engineProjectId,'fixture-clone');assert.equal(r.projectId,r.engineProjectId);
});

test('wrong engine project, wrong map identity and changed parent bytes cannot enter editing',async t=>{
  const f=await setup(t);let mutations=0;
  const engine={call:async operation=>{if(operation!=='workspace_inspect')mutations++;return {data:{loaded:true,busy:false,project_id:'foreign-project',state:'other'}};}};
  const r=await buildDynamics(f.rig,{...f.ctx,engine});assert.equal(r.status,'failed');assert.equal(mutations,0);
  const g=await setup(t);g.map.inputSha256='c'.repeat(64);await writeJson(path.join(g.root,g.rig.parameterMapPath),g.map);await g.refresh();
  const bad=await buildDynamics(g.rig,g.ctx);assert.equal(bad.unresolved.at(-1).code,'DYNAMICS_IDENTITY_MISMATCH');
  const h=await setup(t);await fs.appendFile(path.join(h.root,h.rig.projectPath),'changed');
  await assert.rejects(buildDynamics(h.rig,h.ctx),{code:'REFERENCE_INVALID'});
});

test('missing image artifact and out-of-root symlink are rejected before any engine call',async t=>{
  const f=await setup(t);f.rig.artifacts=f.rig.artifacts.filter(a=>a.path!=='rigging/posed.png');
  const r=await buildDynamics(f.rig,f.ctx);assert.equal(r.unresolved.at(-1).code,'REFERENCE_INVALID');
  const g=await setup(t);await fs.unlink(path.join(g.root,g.rig.psdPath));
  await fs.symlink(path.join(f.root,f.rig.psdPath),path.join(g.root,g.rig.psdPath));
  await assert.rejects(buildDynamics(g.rig,g.ctx),{code:'REFERENCE_INVALID'});
});

test('worker recovers only the original completed dynamics job through its production lease; lost replies are not resubmitted',async t=>{
  const {createStageEngine}=await import('../src/pipeline/production-engine.mjs');
  const f=await setup(t),raw=engineFixture(f.root);
  let receipt,answer='wrong',lookups=0;
  const client={async call(op,req,options) {
    if(op==='job_get'){
      lookups++;assert.equal(req.id,receipt.id);
      if(answer==='missing')throw Object.assign(new Error('process-local job unavailable'),{code:'MAKER_REJECTED'});
      return {data:{...receipt,...(answer==='wrong'?{input_state:'foreign'}:{})}};
    }
    const result=await raw.call(op,req,options);
    if(op==='settings_update'&&!receipt) {
      receipt={id:'job-edit-1',operation:op,project_id:req.project_id,input_state:req.state,
        terminal:true,status:'completed',result:result.data};
      await options.onJob(receipt);throw Object.assign(new Error('after commit'),{code:'MAKER_HTTP'});
    }
    return result;
  }};
  const withEngine=createStageEngine({root:f.root,client,ensureEngine:async()=>{}});
  const resume=()=>withEngine('dynamics',f.rig,{...f.ctx,recoverDynamics:true},ctx=>buildDynamics(f.rig,ctx));
  const original=await resume();assert.equal(original.status,'awaiting_external_result');
  assert.deepEqual(await resume(),original);
  answer='missing';assert.deepEqual(await resume(),original);
  const journalFile=path.join(f.root,'dynamics/engine-journal.json'),before=await fs.readFile(journalFile,'utf8');
  assert.equal(JSON.parse(before).pending.jobId,receipt.id);
  answer='correct';const resumed=await resume();
  assert.deepEqual(resumed.unresolved.map(u=>u.code),['DYNAMICS_VISUAL_NOT_RUN']);
  assert.equal(lookups,3);
  assert.equal(raw.calls.filter(c=>c.operation==='settings_update').length,1);
  assert.equal(raw.calls.filter(c=>c.operation==='project_export_model').length,1);
  const after=JSON.parse(await fs.readFile(journalFile,'utf8'));
  assert.equal(after.pending,null);
  assert.equal(after.steps.find(s=>s.operation==='settings_update').recovered,true);
  assert.equal(resumed.revision,original.revision);
});

test('confirmed cancellation stops the same candidate and never reopens or edits again',async t=>{
  const f=await setup(t),raw=engineFixture(f.root),ctx={...f.ctx,recoverDynamics:true};
  let pending,edits=0;
  ctx.engine={async call(op,req,options){
    if(op==='job_get')return {data:{id:'job-stop',operation:pending.op,project_id:pending.req.project_id,
      input_state:pending.req.state,terminal:true,status:'cancelled'}};
    if(op==='settings_update') {
      edits++;pending={op,req};await options.onJob({id:'job-stop'});throw new Error('disconnect');
    }
    return raw.call(op,req,options);
  }};
  const wait=await buildDynamics(f.rig,ctx);assert.equal(wait.status,'awaiting_external_result');
  const failed=await buildDynamics(f.rig,ctx);assert.equal(failed.status,'failed');
  assert.equal(failed.unresolved.at(-1).code,'MAKER_JOB_FAILED');
  assert.deepEqual(await buildDynamics(f.rig,ctx),failed);assert.equal(edits,1);
  assert.equal(raw.calls.filter(c=>c.operation==='project_open').length,1);
});

test('model export reconciliation checks the exact output paths and sizes before reopening or admitting the bundle',async t=>{
  const f=await setup(t),raw=engineFixture(f.root);let receipt,wrong=true,writes=0;
  const ctx={...f.ctx,recoverDynamics:true,engine:{async call(op,req,opts) {
    if(op==='job_get'){
      const job=structuredClone(receipt);
      if(wrong)job.result.files[0].bytes++;
      return {data:job};
    }
    const r=await raw.call(op,req,opts);
    if(op==='project_export_model'){
      writes++;const names=await fs.readdir(req.output_directory);
      const files=await Promise.all(names.map(async name=>{
        const file=path.join(req.output_directory,name);return {path:file,bytes:(await fs.stat(file)).size};
      }));
      receipt={operation:op,id:'job-export',project_id:req.project_id,input_state:req.state,terminal:true,status:'completed',
        result:{...r.data,revision:'revision-fixture',files,warnings:[]}};
      await opts.onJob(receipt);throw new Error('lost export reply');
    }
    return r;
  }}};
  const original=await buildDynamics(f.rig,ctx);assert.equal(original.status,'awaiting_external_result');
  assert.deepEqual(await buildDynamics(f.rig,ctx),original);
  assert.equal(raw.calls.filter(c=>c.operation==='project_open').length,1);
  wrong=false;const resumed=await buildDynamics(f.rig,ctx);
  assert.deepEqual(resumed.unresolved.map(u=>u.code),['DYNAMICS_VISUAL_NOT_RUN']);
  assert.equal(writes,1);assert.equal(raw.calls.filter(c=>c.operation==='project_open').length,2);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,original.dynamicsManifestPath),'utf8')).status,'awaiting_external_result');
});

test('an old first-open receipt needs the matching native manifest, history HEAD and revision; no open is repeated',async t=>{
  const {createHash}=await import('node:crypto'),{archive}=await import('../src/packaging/archive.mjs');
  const f=await setup(t),raw=engineFixture(f.root);
  const projectRoot=path.join(f.root,'native-fixture'),sha=s=>createHash('sha256').update(s).digest('hex');
  const files={'assets/fake.png':'fixture-only', 'history/HEAD.json':JSON.stringify({headNodeId:'head-1',nodeOrder:['head-1']}),
    ['history/nodes/'+sha('head-1')+'.json']:JSON.stringify({id:'head-1',revisionId:'revision-1',snapshotHash:'revision-1'}),
    ['history/revisions/'+sha('revision-1')+'.json']:'{}'};
  files['manifest.json']=JSON.stringify({format:'PSD2Live',version:2,projectId:'fixture-clone',
    files:Object.fromEntries(Object.entries(files).map(([key,value])=>[key,sha(value)]))});
  for(const [name,bytes] of Object.entries(files)){
    const file=path.join(projectRoot,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);
  }
  const parent=path.join(f.root,f.rig.projectPath);
  await fs.unlink(parent);await archive({action:'make',file:parent,root:projectRoot,files:Object.keys(files)});await f.refresh();
  let receipt,wrong=true;
  const ctx={...f.ctx,recoverDynamics:true,engine:{async call(op,req,opts){
    if(op==='job_get')return {data:{...receipt,result:{...receipt.result,history_node_id:wrong?'other':'head-1',revision:'revision-1'}}};
    const r=await raw.call(op,req,opts);
    if(op==='project_open'&&!receipt){
      receipt={operation:op,id:'job-open',project_id:req.project_id,input_state:req.state,status:'completed',terminal:true,result:r.data};
      await opts.onJob(receipt);throw new Error('lost open reply');
    }
    return r;
  }}};
  const pending=await buildDynamics(f.rig,ctx);
  const journalFile=path.join(f.root,'dynamics/engine-journal.json'),j=JSON.parse(await fs.readFile(journalFile,'utf8'));
  await writeJson(journalFile,{schemaVersion:1,taskId:j.taskId,candidateId:j.candidateId,revision:j.revision,steps:[],pending:j.pending});
  const old=await fs.readFile(journalFile,'utf8');
  assert.deepEqual(await buildDynamics(f.rig,ctx),pending);
  assert.equal(await fs.readFile(journalFile,'utf8'),old);
  wrong=false;const resumed=await buildDynamics(f.rig,ctx);
  assert.deepEqual(resumed.unresolved.map(u=>u.code),['DYNAMICS_VISUAL_NOT_RUN']);
  assert.equal(raw.calls.filter(c=>c.operation==='project_open').length,2);
  assert.equal(JSON.parse(await fs.readFile(journalFile,'utf8')).steps[0].recovered,true);
});

test('a worker interrupted before writing its stage pointer can resume from the job journal without another edit',async t=>{
  const f=await setup(t),raw=engineFixture(f.root);let job,edits=0;
  const ctx={...f.ctx,recoverDynamics:true,engine:{async call(op,req,opts) {
    if(op==='job_get')return {data:job};
    const r=await raw.call(op,req,opts);
    if(op==='settings_update'){
      edits++;job={operation:op,id:'job-before-stage',project_id:req.project_id,input_state:req.state,terminal:true,status:'completed',result:r.data};
      await opts.onJob(job);throw new Error('transport closed');
    }
    return r;
  }}};
  const pending=await buildDynamics(f.rig,ctx);
  await fs.unlink(path.join(f.root,'dynamics/stage.json'));
  const resumed=await buildDynamics(f.rig,ctx);
  assert.equal(edits,1);assert.deepEqual(resumed.unresolved.map(u=>u.code),['DYNAMICS_VISUAL_NOT_RUN']);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,pending.dynamicsManifestPath),'utf8')).status,'awaiting_external_result');
});

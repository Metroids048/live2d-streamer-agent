import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {captureDynamicsPreview,recordDynamicsReview,inspectDynamicsPreviewPending} from '../src/dynamics/index.mjs';
import {planDynamicsPreview,previewClip,previewRasterSize,registeredWaveFrames} from '../src/dynamics/preview-plan.mjs';
import {buildBroadcastPlayback,buildVideoOnlyPlayback} from '../src/dynamics/broadcast-preview.mjs';
import {artifact,writeJson,digest} from '../src/dynamics/files.mjs';
import {ffmpeg} from '../src/preview.mjs';

test('broadcast preview takes the original lift, wrist, fingers and reset samples in order',()=>{
  const frame=(phase,wave,wrist,finger)=>({phase,values:{
    ParamWave:wave,ParamGreetingWrist:wrist,ParamGreetingFinger5:finger,ParamAngleX:9
  }});
  const take=[
    frame('neutral',0,0,0),frame('motion:dyn_wave',.13,.12,.2),
    frame('motion:dyn_wave',.88,.75,.35),frame('cancel:dyn_wave',0,0,0),
    frame('restore-baseline',0,0,0)
  ];
  assert.deepEqual(registeredWaveFrames(take),[
    {ParamWave:.13,ParamGreetingWrist:.12,ParamGreetingFinger5:.2},
    {ParamWave:.88,ParamGreetingWrist:.75,ParamGreetingFinger5:.35},
    {ParamWave:0,ParamGreetingWrist:0,ParamGreetingFinger5:0}
  ]);
  assert.deepEqual(registeredWaveFrames([take[0]]),[]);
  take[0].values={...take[0].values,bodyX:0,bodyY:0,bodyZ:0,hair:0,ParamAngleZ:0};
  const playback=buildBroadcastPlayback(take,30,['bodyX','bodyY','bodyZ'],['hair']);
  assert.equal(playback.length,499);
  assert.deepEqual([...new Set(playback.map(f=>f.phase))],['conversation','greeting','return-to-conversation']);
  assert.deepEqual(playback.filter(f=>f.phase==='greeting').map(({values:v})=>[
    v.ParamWave,v.ParamGreetingWrist,v.ParamGreetingFinger5
  ]),[[.13,.12,.2],[.88,.75,.35],[0,0,0]]);
  assert(playback.every(({values:v})=>!Object.hasOwn(v,'hair')&&Math.abs(v.ParamAngleZ)<=3.5));
  assert(playback.some(({phase,values:v})=>phase==='conversation'&&v.bodyX!==0&&v.ParamWave===0));
  const continuousTake=[take[0],frame('motion:dyn_wave',.012,0,0),...take.slice(1)];
  const continuousPlayback=buildBroadcastPlayback(continuousTake,30,['bodyX','bodyY','bodyZ']);
  const conversation=continuousPlayback.filter(f=>f.phase!=='greeting');
  assert(conversation.some(({values:v})=>v.ParamWave>0));
  assert(conversation.every(({values:v})=>v.ParamWave<=.031&&v.ParamGreetingWrist===0));
  assert.equal(continuousPlayback.at(-1).values.ParamWave,0);
  assert.deepEqual(continuousPlayback.filter(f=>f.phase==='greeting').map(f=>f.values.ParamWave),[.012,.13,.88,0]);
  const legacyTake=[{...take[0],values:{...take[0].values,ParamWaveLift:0}},...continuousTake.slice(1)];
  assert(buildBroadcastPlayback(legacyTake,30,['bodyX','bodyY','bodyZ'])
    .filter(f=>f.phase!=='greeting').every(f=>f.values.ParamWave===0));
  const longTake=[take[0],...Array(330).fill(take[1]),take[3],take[4]];
  const longPlayback=buildBroadcastPlayback(longTake,30,['bodyX','bodyY','bodyZ']);
  assert.equal(longPlayback.filter(f=>f.phase==='greeting').length,331);
  assert.equal(longPlayback.filter(f=>f.phase==='return-to-conversation').length,99);
});

test('video-only preview keeps expressive motion, sequenced greeting and complete blinks',()=>{
  const frame=(phase,wave,wrist,finger)=>({phase,values:{
    ParamWave:wave,ParamGreetingWrist:wrist,ParamGreetingFinger1:finger,
    ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0,ParamEyeLOpen:1,ParamEyeROpen:1,
    ParamEyeBallX:0,ParamEyeBallY:0,ParamMouthOpenY:0,ParamMouthForm:0,ParamEyeSmile:0,
    ParamBreath:0,bodyX:0,bodyY:0,bodyZ:0,hair:0
  }});
  const take=[frame('neutral',0,0,0),frame('motion:dyn_wave',1,1,1),frame('cancel:dyn_wave',0,0,0)];
  const playback=buildVideoOnlyPlayback(take,30,['bodyX','bodyY','bodyZ'],['hair'],'silver');
  assert.equal(playback.length,541);
  assert.ok(playback.every(frame=>frame.values.ParamBreath===0));
  assert(playback.every(({values})=>!Object.hasOwn(values,'hair')));
  assert.equal(Math.max(...playback.map(({values})=>values.ParamWave)),.63);
  assert(Math.max(...playback.map(({values})=>values.ParamGreetingWrist))<=.76);
  assert(Math.max(...playback.map(({values})=>Math.abs(values.ParamAngleX)))>=8);
  assert(Math.max(...playback.map(({values})=>Math.abs(values.bodyX)))>=4);
  const raised=playback.findIndex(({values})=>values.ParamWave>.02);
  const bent=playback.findIndex(({values})=>values.ParamGreetingWrist>.02);
  const fingers=playback.findIndex(({values})=>values.ParamGreetingFinger1>.02);
  assert(raised<bent&&bent<fingers);
  assert.equal(playback.at(-1).values.ParamWave,0);
  assert(playback.some(({values})=>values.ParamEyeLOpen===0));
  assert(playback.every(({values})=>values.ParamEyeLOpen!==.1&&values.ParamEyeROpen!==.1));
});

test('teal video edit uses only the registered complete wave keyform span',()=>{
  const frame=(phase,wave,wrist,balance)=>({phase,values:{
    ParamWave:wave,ParamGreetingWrist:wrist,ParamGreetingBalance:balance,
    ParamAngleX:0,ParamAngleY:0,ParamAngleZ:0,ParamEyeLOpen:1,ParamEyeROpen:1,
    ParamEyeBallX:0,ParamEyeBallY:0,ParamMouthOpenY:0,ParamMouthForm:0,ParamEyeSmile:0,
    ParamBreath:0,bodyX:0,bodyY:0,bodyZ:0
  }});
  const take=[frame('neutral',0,0,0),frame('motion:dyn_wave',.69,.8,.4),frame('cancel:dyn_wave',0,0,0)];
  const playback=buildVideoOnlyPlayback(take,30,['bodyX','bodyY','bodyZ'],[],'teal-cut-safe');
  const waveValues=playback.map(({values})=>values.ParamWave);
  assert.equal(Math.max(...waveValues),.69);
  assert(waveValues.every(value=>value===0||(value>=.45&&value<=.69)));
  assert(playback.every(({values})=>values.ParamGreetingWrist===0&&values.ParamGreetingBalance===0));
  assert.equal(playback.at(-1).values.ParamWave,0);
});

// Synthetic model/archive + engine boundary fixtures. Only codec encode/decode is real.
// No fixture may be presented as a Live2D model, business preview or human review.
const exec=promisify(execFile),base=path.resolve('evidence/single-image-live2d/04');
const identity={taskId:'preview-fixture',candidateId:'preview-fixture',revision:'r01',parentRevision:'parent',
  inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
function recipeFixture() {
  const p=(id,semantic,min=-1,max=1,def=0,unit='normalized')=>({id,semantic,min,max,default:def,unit,available:true,
    authoredRange:[min,max],bindings:[{target:'mesh:'+id,directAxes:{[id]:[min,max]}}],
    motionEvidence:[{value:max===def?min:max,defaultImage:'a.png',posedImage:'b.png',changedPixels:1,totalPixels:10}]});
  return {schemaVersion:1,parameters:[p('yaw','head.yaw',-15,15,0,'degree'),p('pitch','head.pitch',-10,10,0,'degree'),
    p('roll','head.roll',-10,10,0,'degree'),p('mouth','mouth.open',0,1),p('left','eye.left.open',0,1,1),
    p('right','eye.right.open',0,1,1),p('brow','brow.left'),p('hair','hair.front'),p('breath','body.breath',0,1)],
    ownership:{physics:['hair']},physics:[{id:'hair'}],
    expressions:[{id:'happy',entries:[{parameter:'brow',blend:'Add',value:.6}]},{id:'angry',entries:[{parameter:'brow',blend:'Add',value:-.6}]}],
    motions:[{id:'dyn_idle',duration:4.5,curves:[{parameter:'breath'}]}]};
}
const brief={intent:{headMotion:{yawDegrees:15,pitchDegrees:10,rollDegrees:10}}};
test('native raster export keeps source detail without upscaling and caps the full retained clip',()=>{
  const source=(right,bottom)=>({parameters:[{motionEvidence:[{defaultMetadata:{canvasRect:{left:0,top:0,right,bottom}}}]}]});
  assert.equal(previewRasterSize(source(128,128),733),128);
  assert.equal(previewRasterSize(source(600,2000),733),1024);
  assert.ok(previewRasterSize(source(2000,2000),733)**2*733<=256*1024*1024);
});
test('the complete preset replay keeps one final key through native Float32 rounding',()=>{
  const recipe=recipeFixture();
  for(let i=0;i<10;i++)recipe.expressions.push({id:'extra'+i,entries:[]});
  [6,1.9,2.75,2.45,1.85,3.1,2.35].forEach((duration,i)=>{
    recipe.motions.push({id:i?'dyn_preset_'+i:'dyn_wave',duration,curves:[]});
  });
  const plan=planDynamicsPreview(recipe,brief);
  assert.equal(plan.frameCount,2065);
  assert.equal(plan.frameCount,Math.ceil(Math.fround(Math.fround(plan.duration)*plan.fps))+1);
  assert.ok(plan.frames.every((f,i)=>!i||Math.fround(f.time)-Math.fround(plan.frames[i-1].time)>.0001));
  assert.ok(plan.frames.some(f=>f.phase==='motion:dyn_wave'&&f.values.yaw!==0&&f.values.mouth>0));
  const presets=plan.frames.filter(f=>f.phase.startsWith('motion:dyn_preset_')||f.phase.startsWith('cancel:dyn_preset_'));
  assert.ok(presets.length>500);
  assert.ok(presets.every(f=>f.values.yaw===0&&f.values.mouth===0));
});
async function fixture(t,{fail,losses=[],identityOverride={}}={}) {
  const candidate={...identity,...identityOverride};
  await fs.mkdir(base,{recursive:true});const root=await fs.mkdtemp(path.join(base,'.test-preview-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'dynamics'));
  const files={'dynamics/character.psd2live':'synthetic archive, not a model','dynamics/model.model3.json':'{}',
    'dynamics/parent.psd2live':'parent untouched'};
  for(const [f,b] of Object.entries(files))await fs.writeFile(path.join(root,f),b);
  const recipe=recipeFixture();await writeJson(path.join(root,'dynamics/recipe.json'),recipe);
  const manifest={schemaVersion:1,...candidate,exportStatus:'exported',parentProject:{path:'dynamics/parent.psd2live',sha256:await digest(path.join(root,'dynamics/parent.psd2live'))},
    expressions:[{id:'happy'},{id:'angry'}],motions:[{id:'dyn_idle'}],checks:[],unresolved:[],warnings:[]};
  await writeJson(path.join(root,'dynamics/dynamics-manifest.json'),manifest);
  const bundle={schemaVersion:1,...candidate,brief,stage:'dynamics',status:'blocked',engineVersion:'3.6.7',engineProjectId:'candidate-project',engineRevision:'candidate-state',
    projectPath:'dynamics/character.psd2live',modelPath:'dynamics/model.model3.json',dynamicsManifestPath:'dynamics/dynamics-manifest.json',
    artifacts:[],checks:[{name:'dynamics.export-and-reopen',layer:'automated',status:'passed'}],warnings:[],
    unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN',message:'synthetic missing review'}]};
  for(const f of [...Object.keys(files),'dynamics/recipe.json',bundle.dynamicsManifestPath])bundle.artifacts.push(await artifact(root,f,'fixture'));
  await writeJson(path.join(root,'dynamics/stage.json'),bundle);
  const calls=[];let state='candidate-state',project='candidate-project',n=0,clip;
  const engine={async call(op,req={},opts={}) {
    calls.push({op,req});
    if(op==='workspace_inspect')return {data:{loaded:true,busy:false,project_id:project,state}};
    if(op==='motion_sample')return {data:{id:req.id,time:req.time,state,values:{breath:.15*(1-Math.cos(req.time))}}};
    if(op==='motion_get')return {data:{clip}};
    assert.equal(req.state,state);assert.equal(req.project_id,project);
    if(op===fail) {await opts.onJob?.({id:'preview-job-unknown'});const e=new Error('synthetic disconnect');e.code='MAKER_HTTP';throw e;}
    if(op==='project_open') {project='opened-'+(++n);state='state-'+n;}
    if(op==='motion_put') {clip=req.clip;state='state-'+(++n);}
    if(op==='project_save_as')await fs.writeFile(req.path,'synthetic test archive with replay clip');
    if(op==='project_export_target') {
      await fs.mkdir(req.output_directory,{recursive:true});
      const video=path.join(req.output_directory,'fixture.mp4');
      await exec(ffmpeg,['-v','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=32x32:rate=30',
        '-frames:v',String(Math.ceil(clip.duration*clip.fps)+1),'-c:v','libx264','-pix_fmt','yuv420p',video]);
      return {data:{state,revision:'fixture',directory:req.output_directory,target:'mp4',files:['fixture.mp4'],losses}};
    }
    return {data:{project_id:project,state}};
  }};
  return {root,recipe,bundle,calls,ctx:{taskRoot:root,taskId:candidate.taskId,candidateId:candidate.candidateId,
    revision:candidate.revision,parentRevision:candidate.parentRevision,engine},engine};
}

test('trajectory preserves requested range, excludes physics writers, restores expression and action baseline',async()=>{
  const recipe=recipeFixture(),plan=planDynamicsPreview(recipe,brief);
  assert.equal(plan.duration,16);assert.equal(plan.frames.length,481);
  assert.ok(plan.frames.every(f=>!Object.hasOwn(f.values,'hair')));
  assert.equal(Math.max(...plan.frames.map(f=>f.values.yaw)),15);
  assert.equal(Math.min(...plan.frames.map(f=>f.values.yaw)),-15);
  const cancel=plan.frames.find(f=>f.phase==='cancel-motion-preserve-expression');
  assert.equal(cancel.values.brow,-.6);assert.ok(!cancel.motion);
  assert.equal(plan.frames.find(f=>f.phase==='restore-baseline').values.brow,0);
  assert.ok(plan.frames.some(f=>f.values.left<.2&&f.values.mouth>0));
  const clip=await previewClip(plan,recipe,async()=>({breath:.1}));
  assert.ok(!clip.curves.some(c=>c.parameter==='hair'));
  assert.equal(clip.curves.find(c=>c.parameter==='breath').keys.at(-1).value,0);
  const bad=structuredClone(recipe);bad.parameters[0].authoredRange=[-10,10];
  assert.throws(()=>planDynamicsPreview(bad,brief),{code:'DYNAMICS_PREVIEW_RANGE_MISSING'});
});

test('native diagnostics carry idle and fade emotions across switching and reset, with unchanged old replay',async()=>{
  const recipe=recipeFixture();
  for(const expression of recipe.expressions)Object.assign(expression,{fade_in:.15,fade_out:.15});
  const plan=planDynamicsPreview(recipe,brief),legacy=planDynamicsPreview(recipe,brief,{expressionFades:false});
  const brow=(trajectory,phase)=>trajectory.frames.filter(f=>f.phase===phase).map(f=>f.values.brow);
  assert.equal(plan.expressionClock,'registered-fades');
  assert.equal(legacy.expressionClock,undefined);
  const happy=brow(plan,'expression:happy'),angry=brow(plan,'expression:angry');
  assert.equal(happy[0],0);
  assert.ok(happy[1]>0&&happy[1]<happy.at(-1));
  assert.equal(angry[0],happy.at(-1));
  assert.ok(angry[1]<angry[0]&&angry[1]>angry.at(-1));
  assert.equal(angry.at(-1),-.6);
  assert.ok(brow(plan,'cancel-motion-preserve-expression').every(value=>value===-.6));
  const reset=brow(plan,'restore-baseline');
  assert.equal(reset[0],-.6);
  assert.ok(reset[1]>-.6&&reset[1]<0);
  assert.equal(reset.at(-1),0);
  assert.equal(brow(legacy,'expression:angry')[0],-.6);
  const firstAngry=plan.frames.findIndex(f=>f.phase==='expression:angry');
  assert.equal(plan.frames[firstAngry].motion.time,2);
  assert.equal(legacy.frames[firstAngry].motion.time,0);
  const firstCancel=plan.frames.findIndex(f=>f.phase==='cancel-motion-preserve-expression');
  assert.equal(plan.frames[firstCancel].motion.time,4);
  assert.equal(plan.frames[firstCancel].motion.weight,1);
  assert.ok(!plan.frames[firstCancel+8].motion);
  const clip=await previewClip(plan,recipe,async()=>({breath:.3}));
  const breath=clip.curves.find(c=>c.parameter==='breath').keys;
  assert.equal(breath[firstCancel].value,.3);
  assert.ok(breath[firstCancel+4].value>0&&breath[firstCancel+4].value<.3);
  assert.equal(breath[firstCancel+8].value,0);
});

test('full-character preview combines speech and turn, lowers the waving arm and toggles only the bow',async()=>{
  const recipe=recipeFixture();
  recipe.parameters.push(...['arm','bow'].map(id=>({id,min:0,max:1,default:0})));
  recipe.appearanceGroups={hide_bow:'chest_bow'};
  recipe.expressions.push({id:'hide_bow',entries:[{parameter:'bow',blend:'Add',value:1}]});
  recipe.motions.push({id:'wave',duration:2,curves:[{parameter:'arm'}]});
  const plan=planDynamicsPreview(recipe,brief);
  assert.ok(plan.frames.some(f=>f.phase==='turn-and-speak'&&f.values.yaw>0&&f.values.mouth>0));
  const clip=await previewClip(plan,recipe,(motion,time)=>motion.id==='wave'
    ?{arm:Math.sin(Math.PI*time/2)}:{breath:0.1});
  const arm=clip.curves.find(c=>c.parameter==='arm').keys;
  assert.ok(arm.some((k,i)=>plan.frames[i].phase==='motion:wave'&&k.value>.99));
  assert.ok(arm.every((k,i)=>['motion:wave','combined-controls:wave:hide_bow'].includes(plan.frames[i].phase)||k.value===0));
  for(const id of ['cancel-motion-preserve-expression','cancel:wave','restore-baseline']) {
    const frames=plan.frames.filter(f=>f.phase===id);
    assert.ok(frames.some(f=>Math.abs(f.values.yaw)>2&&f.values.mouth>.2),id+' should release only owned parameters');
  }
  for(let i=1;i<plan.frames.length;i++) {
    const a=plan.frames[i-1],b=plan.frames[i];
    if(a.phase===b.phase||b.phase.startsWith('physics-'))continue;
    assert.ok(Math.abs(a.values.yaw-b.values.yaw)<1.7&&Math.abs(a.values.mouth-b.values.mouth)<.26,b.phase+' restarted tracking');
  }
  for(const [phase,bow,brow] of [['appearance-on:hide_bow',1,-.6],['appearance-off:hide_bow',0,-.6],['restore-baseline',0,0]]){
    const frames=plan.frames.filter(f=>f.phase===phase);
    assert.ok(frames.length>0&&frames.every(f=>f.values.bow===bow&&f.values.brow===brow));
  }
  for(const [phase,bow,brow,moving] of [
    ['combined-controls:wave:hide_bow',1,-.6,true],
    ['cancel-motion-preserve-appearance:hide_bow',1,-.6,false],
    ['reset-expression-preserve-appearance:hide_bow',1,0,false],
    ['reset-appearance-preserve-tracking:hide_bow',0,0,false]
  ]) {
    const frames=plan.frames.filter(f=>f.phase===phase);
    assert.ok(frames.length>0,phase+' must be covered');
    assert.ok(frames.every(f=>f.values.bow===bow&&f.values.brow===brow));
    assert.ok(frames.some(f=>Math.abs(f.values.yaw)>2&&f.values.mouth>.2),phase+' must preserve live tracking');
    const samples=arm.filter((k,i)=>plan.frames[i].phase===phase);
    assert.ok(moving?samples.some(k=>k.value>.99):samples.every(k=>k.value===0),phase+' arm ownership');
  }
});

test('full-character continuous preview visits all nine requested yaw/pitch poses while eye and mouth remain live',()=>{
  const recipe=recipeFixture();
  recipe.parameters.push({id:'arm',min:0,max:1,default:0});
  recipe.motions.push({id:'wave',duration:2,curves:[{parameter:'arm'}]});
  const plan=planDynamicsPreview(recipe,brief),frames=plan.frames.filter(f=>f.phase==='head-nine-directions');
  assert(frames.length>0);
  for(const yaw of [-15,0,15])for(const pitch of [-10,0,10])
    assert(frames.some(f=>Math.abs(f.values.yaw-yaw)<1e-8&&Math.abs(f.values.pitch-pitch)<1e-8),yaw+','+pitch);
  assert(frames.some(f=>f.values.left<.6&&f.values.mouth>0));
  for(const id of ['happy','angry']) {
    const emotion=plan.frames.filter(f=>f.phase==='expression:'+id);
    assert(emotion.some(f=>f.values.left<.6&&f.values.mouth>0&&Math.abs(f.values.yaw)>1));
  }
});

test('the wrist greeting retains the head check and uses staggered conversation and body motion during the actual wave',()=>{
  const recipe=recipeFixture();
  const yaw=recipe.parameters.find(p=>p.semantic==='head.yaw');
  recipe.parameters.push({...yaw,id:'bodyX',semantic:'body.angleX',bindings:[{target:'mesh:body',directAxes:{bodyX:[-15,15]}}]});
  recipe.motions.push({id:'dyn_wave',duration:6,curves:[{parameter:'ParamGreetingWrist'}]});
  const plan=planDynamicsPreview(recipe,brief);
  const check=plan.frames.filter(f=>f.phase==='head-nine-directions');
  assert(check.some(f=>f.values.yaw===15&&f.values.pitch===10));
  for(const expression of recipe.expressions)Object.assign(expression,{fade_in:.15,fade_out:.15});
  const smooth=planDynamicsPreview(recipe,brief);
  const lastCheck=smooth.frames.findLast(f=>f.phase==='head-nine-directions');
  const firstChat=smooth.frames.find(f=>f.phase==='expression:happy');
  for(const [axis,tolerance] of [['yaw',.2],['pitch',.1],['roll',.3],['mouth',.015],['left',.02],['right',.02]])
    assert.ok(Math.abs(lastCheck.values[axis]-firstChat.values[axis])<tolerance,axis);
  const wave=plan.frames.filter(f=>f.phase==='motion:dyn_wave');
  assert(wave.every(f=>f.motion.id==='dyn_wave'));
  assert(wave.some(f=>Math.abs(f.values.yaw)>4&&Math.abs(f.values.bodyX)>1&&f.values.mouth>.25));
  assert(wave.some(f=>f.values.mouth===0&&Math.abs(f.values.yaw)>4));
  assert(wave.some(f=>Math.abs(f.values.left-f.values.right)>.05));
});

test('native export from byte-identical scratch binds actual media and leaves source/parent intact; reentry never exports twice',async t=>{
  const f=await fixture(t),before=await digest(path.join(f.root,f.bundle.projectPath));
  const r=await captureDynamicsPreview(f.bundle,f.ctx);
  assert.equal(r.status,'blocked');assert.equal(await digest(path.join(f.root,r.projectPath)),before);
  const m=JSON.parse(await fs.readFile(path.join(f.root,r.dynamicsManifestPath),'utf8'));
  assert.equal(m.preview.kind,'parameter-animation');assert.equal(m.preview.projectSha256,before);
  assert.equal(m.preview.modelSha256,await digest(path.join(f.root,r.modelPath)));
  assert.equal(m.preview.frameCount,481);assert.ok(m.preview.videoPath.endsWith('.mp4'));
  assert.ok(f.calls.some(c=>c.op==='project_export_target'&&c.req.settings.physics==='true'));
  assert.ok(!f.calls.some(c=>['preview_physics','expression_put','physics_put','project_export_model'].includes(c.op)));
  const count=f.calls.length;
  assert.deepEqual(await captureDynamicsPreview(f.bundle,f.ctx),r);assert.equal(f.calls.length,count);
});

test('unknown preview export keeps exact pending job and cannot retry, finish review or reopen another project',async t=>{
  const f=await fixture(t,{fail:'project_export_target'}),r=await captureDynamicsPreview(f.bundle,f.ctx);
  assert.equal(r.status,'awaiting_external_result');
  assert.equal(f.calls.at(-1).op,'project_export_target');
  const count=f.calls.length;assert.deepEqual(await captureDynamicsPreview(f.bundle,f.ctx),r);assert.equal(f.calls.length,count);
  const pending=await inspectDynamicsPreviewPending({...f.ctx,engine:{call:async(op,req)=>{
    assert.equal(op,'job_get');assert.equal(req.id,'preview-job-unknown');return {data:{id:req.id,status:'running',terminal:false}};
  }}});
  assert.equal(pending.status,'awaiting_external_result');
  await assert.rejects(recordDynamicsReview(r,{},f.ctx),{code:'DYNAMICS_PREVIEW_NOT_READY'});
});

test('a failed candidate reopen does not replace the original export failure in the journal',async t=>{
  const f=await fixture(t),call=f.engine.call.bind(f.engine);
  f.engine.call=async(op,req,options)=>{
    if(op==='project_export_target'||op==='project_open'&&req.path===path.join(f.root,f.bundle.projectPath))
      throw Object.assign(new Error(op+' failed'),{code:'MAKER_JOB_FAILED'});
    return call(op,req,options);
  };
  const r=await captureDynamicsPreview(f.bundle,f.ctx);
  assert.equal(r.previewCapture.status,'failed');
  const journal=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/preview/engine-journal.json')));
  assert.equal(journal.failure.name,'export-native-preview');
  assert.equal(journal.restoreError.message,'project_open failed');
});

function review(manifest,{failed=false}={}) {
  return {id:failed?'failed-review':'model-review',reviewer:{kind:'model',name:'synthetic test boundary'},
    watchedContinuously:true,range:[0,manifest.preview.duration],videoSha256:manifest.preview.videoSha256,
    modelSha256:manifest.preview.modelSha256,projectSha256:manifest.preview.projectSha256,
    observations:manifest.preview.requiredCriteria.map((criterion,i)=>({criterion,status:failed&&i===2?'failed':'passed',
      from:0,to:manifest.preview.duration,note:failed&&i===2?'synthetic eye/mouth intersection at combination':'synthetic fixture observation; not business evidence'}))};
}
test('numeric r2 identity survives preview and review while string aliases are rejected',async t=>{
  const f=await fixture(t,{identityOverride:{revision:2,parentRevision:1}});
  await assert.rejects(captureDynamicsPreview(f.bundle,{...f.ctx,revision:'2'}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  await assert.rejects(captureDynamicsPreview(f.bundle,{...f.ctx,parentRevision:'1'}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  assert.equal(f.calls.length,0);
  const captured=await captureDynamicsPreview(f.bundle,f.ctx);
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,captured.dynamicsManifestPath),'utf8'));
  await assert.rejects(recordDynamicsReview(captured,review(manifest),{...f.ctx,revision:'2'}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  await assert.rejects(recordDynamicsReview(captured,review(manifest),{...f.ctx,parentRevision:'1'}),{code:'DYNAMICS_IDENTITY_MISMATCH'});
  const reviewed=await recordDynamicsReview(captured,review(manifest),f.ctx);
  const record=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/reviews/model-review/review.json'),'utf8'));
  for(const value of [captured,manifest,reviewed,record.candidate]) {
    assert.equal(value.revision,2);assert.equal(value.parentRevision,1);
  }
});

test('review is hash/time/criterion bound, failures retained, same media may be re-reviewed; completion does not invent runtime or user acceptance',async t=>{
  const f=await fixture(t),r=await captureDynamicsPreview(f.bundle,f.ctx);
  const m=JSON.parse(await fs.readFile(path.join(f.root,r.dynamicsManifestPath),'utf8'));
  await assert.rejects(recordDynamicsReview(r,{...review(m),videoSha256:'c'.repeat(64)},f.ctx),{code:'DYNAMICS_REVIEW_INVALID'});
  await assert.rejects(recordDynamicsReview(r,{...review(m),observations:review(m).observations.slice(1)},f.ctx),{code:'DYNAMICS_REVIEW_INVALID'});
  const failed=await recordDynamicsReview(r,review(m,{failed:true}),f.ctx);
  assert.equal(failed.status,'blocked');assert.ok(failed.unresolved.some(p=>p.code==='DYNAMICS_VISUAL_REVIEW_FAILED'));
  await assert.rejects(recordDynamicsReview(failed,review(m),f.ctx),{code:'DYNAMICS_REVIEW_INVALID'});
  const done=await recordDynamicsReview(failed,{...review(m),supersedesReviewPath:'dynamics/reviews/failed-review/review.json',
    reassessmentReason:'synthetic test proves a review correction must cite prior failure and new evidence'},f.ctx);
  assert.equal(done.status,'completed');assert.ok(done.artifacts.some(a=>a.path.includes('failed-review')));
  assert.equal(done.checks.find(c=>c.name==='dynamics.visual').status,'passed');
  assert.ok(!done.checks.some(c=>['runtime','human','user_acceptance'].includes(c.layer)&&c.status==='passed'));
  await assert.rejects(recordDynamicsReview(r,review(m),f.ctx),{code:'DYNAMICS_STALE_BUNDLE'});
  await fs.appendFile(path.join(f.root,m.preview.videoPath),'tampered');
  await assert.rejects(recordDynamicsReview(done,{...review(m),id:'second'},f.ctx),{code:'REFERENCE_INVALID'});
});

test('frame-page defects block dynamics without claiming continuous observation',async t=>{
  const f=await fixture(t),r=await captureDynamicsPreview(f.bundle,f.ctx);
  const m=JSON.parse(await fs.readFile(path.join(f.root,r.dynamicsManifestPath),'utf8'));
  const frames={...review(m),watchedContinuously:false,observationMedium:'frame_pages'};
  const before=await fs.readFile(path.join(f.root,'dynamics/stage.json'),'utf8');
  await assert.rejects(recordDynamicsReview(r,frames,f.ctx),{code:'DYNAMICS_REVIEW_INVALID'});
  await assert.rejects(recordDynamicsReview(r,{...frames,watchedContinuously:true},f.ctx),{code:'DYNAMICS_REVIEW_INVALID'});
  assert.equal(await fs.readFile(path.join(f.root,'dynamics/stage.json'),'utf8'),before);
  const failed=await recordDynamicsReview(r,{...frames,observations:review(m,{failed:true}).observations},f.ctx);
  assert.equal(failed.status,'blocked');
  const check=failed.checks.find(c=>c.name==='dynamics.visual');
  assert.match(check.note,/连续自审未完成/);
  const saved=JSON.parse(await fs.readFile(path.join(f.root,check.reviewPath),'utf8'));
  assert.equal(saved.watchedContinuously,false);
  assert.equal(saved.observationMedium,'frame_pages');
  assert.match(saved.scope,/联系图缺陷审查；连续自审未完成/);
});

test('missing lease client and narrowed shape evidence stop before creating preview or switching editor',async t=>{
  const f=await fixture(t);
  await assert.rejects(captureDynamicsPreview(f.bundle,{...f.ctx,engine:null}),{code:'ENGINE_BUSY'});
  assert.equal(f.calls.length,0);
  await assert.rejects(fs.stat(path.join(f.root,'dynamics/preview')),{code:'ENOENT'});
  const p=recipeFixture();p.parameters.find(p=>p.semantic==='mouth.open').authoredRange=[0,.5];
  assert.throws(()=>planDynamicsPreview(p,brief),{code:'DYNAMICS_PREVIEW_RANGE_MISSING'});
});

test('a model re-review cannot override a human rejection of the same candidate',async t=>{
  const f=await fixture(t),r=await captureDynamicsPreview(f.bundle,f.ctx);
  const m=JSON.parse(await fs.readFile(path.join(f.root,r.dynamicsManifestPath),'utf8'));
  const rejected=await recordDynamicsReview(r,{...review(m,{failed:true}),
    reviewer:{kind:'human',name:'synthetic test reviewer'}},f.ctx);
  await assert.rejects(recordDynamicsReview(rejected,{...review(m),
    supersedesReviewPath:'dynamics/reviews/failed-review/review.json',
    reassessmentReason:'synthetic test supplies new evidence but cannot replace a human rejection'},f.ctx),{code:'DYNAMICS_REVIEW_INVALID'});
  const current=JSON.parse(await fs.readFile(path.join(f.root,'dynamics/stage.json'),'utf8'));
  assert.equal(current.status,'blocked');assert.equal(current.checks.find(c=>c.layer==='human').status,'failed');
});

test('additional actions retain complete duration, require their own review and native sampled values',async()=>{
  const r=recipeFixture();r.parameters.push({...r.parameters[0],id:'wave',semantic:'action.wave',min:-1,max:1,default:0,unit:'normalized',authoredRange:[-1,1]});
  r.motions.push({id:'dyn_wave',duration:2,curves:[{parameter:'wave'}]});
  const p=planDynamicsPreview(r,brief);assert.equal(p.duration,24.4);
  assert.ok(p.phases.some(v=>v.id==='motion:dyn_wave'&&v.to-v.from===2));
  const clip=await previewClip(p,r,async(m)=>m.id==='dyn_idle'?{breath:.1}:{wave:.75});
  assert.ok(clip.curves.find(c=>c.parameter==='wave').keys.some(k=>k.value===.75));
  const sampled=async n=>previewClip(p,r,async m=>m.id==='dyn_idle'?{breath:.1}:{wave:n});
  assert((await sampled(1.0000001)).curves.find(c=>c.parameter==='wave').keys.every(k=>k.value<=1));
  await assert.rejects(sampled(1.00001),{code:'DYNAMICS_PREVIEW_INVALID'});
  await assert.rejects(previewClip(p,r,async()=>({yaw:99})),{code:'DYNAMICS_PREVIEW_INVALID'});
});

test('physics loss is an actual preview failure and current candidate reopens only after known terminal response',async t=>{
  const f=await fixture(t,{losses:[{feature:'physics',handling:'dropped',note:'synthetic unavailable'}]}),r=await captureDynamicsPreview(f.bundle,f.ctx);
  assert.equal(r.status,'blocked');assert.equal(r.unresolved.at(-1).code,'DYNAMICS_PREVIEW_PHYSICS_LOSS');
  assert.equal(f.calls.at(-1).op,'project_open');
});

test('resume uses the native export receipt and stored trajectory, decodes that video and restores the same source exactly once',async t=>{
  const {createStageEngine}=await import('../src/pipeline/production-engine.mjs');
  const f=await fixture(t);let receipt,wrong=true,fetches=0;
  const client={async call(op,req,opts) {
    if(op==='job_get') {
      fetches++;assert.equal(req.id,receipt.id);
      return {data:{...receipt,result:{...receipt.result,...(wrong?{files:['different.mp4']}:{})}}};
    }
    const r=await f.engine.call(op,req,opts);
    if(op==='project_export_target'&&!receipt){
      receipt={id:'job-render-1',operation:op,project_id:req.project_id,input_state:req.state,terminal:true,status:'completed',result:r.data};
      await opts.onJob(receipt);throw Object.assign(new Error('reply lost after writing video'),{code:'MAKER_HTTP'});
    }
    return r;
  }};
  const withEngine=createStageEngine({root:f.root,client,ensureEngine:async()=>{}});
  const resume=b=>withEngine('dynamics',b,{...f.ctx,recoverDynamics:true},ctx=>captureDynamicsPreview(b,ctx));
  const original=await resume(f.bundle),calls=f.calls.length;
  assert.equal(original.previewCapture.status,'awaiting_external_result');
  const pending=await resume(original);assert.deepEqual(pending,original);
  wrong=false;const resumed=await resume(pending);
  assert.equal(resumed.previewCapture.status,'captured',JSON.stringify(resumed.unresolved));
  assert.equal(fetches,2);assert.equal(resumed.status,'blocked');
  assert.equal(f.calls.filter(c=>c.op==='project_export_target').length,1);
  assert.equal(f.calls.filter(c=>c.op==='motion_put').length,1);
  assert.equal(f.calls.slice(calls).filter(c=>c.op==='motion_sample').length,0);
  assert.equal(f.calls.filter(c=>c.op==='project_open').length,2);
  const report=JSON.parse(await fs.readFile(path.join(f.root,resumed.previewCapture.reportPath),'utf8'));
  assert.equal(report.originalCandidateReopened,true);
  assert.equal(report.decoded,true);
  const before=await fs.readFile(path.join(f.root,original.dynamicsManifestPath),'utf8');
  assert.equal(JSON.parse(before).status,'awaiting_external_result');
  assert.notEqual(resumed.dynamicsManifestPath,original.dynamicsManifestPath);
});

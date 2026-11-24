import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ffmpeg} from '../src/preview.mjs';
import {artifact} from '../src/dynamics/files.mjs';
import {previewCriteria} from '../src/dynamics/preview.mjs';
import {reviewPage,reviewPages,recordNativeReview} from '../src/pipeline/native-review.mjs';
import {parseTemporalObservations,planAnimeDynamicsReview} from '../src/pipeline/anime-render-review.mjs';
import {gestureClips} from '../src/rigging/streamer-presets.mjs';
import {animeModelTreeDigest} from '../src/artwork/anime-semantic-masks.mjs';
import {Maker} from '../src/maker.mjs';

test('native review reads every decoded frame, binds observations to session and version, and persists a failing observation',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-review-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const identity={taskId:'local-test',candidateId:'test-candidate',revision:1,parentRevision:null,inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
  const job={id:identity.taskId,...identity,output:root,session:'synthetic',source:identity,status:'blocked',stage:'dynamics',error:{code:'DYNAMICS_VISUAL_NOT_RUN'}};
  const b={...identity,schemaVersion:1,status:'blocked',stage:'dynamics',modelPath:'dynamics/model',projectPath:'dynamics/project',
    dynamicsManifestPath:'dynamics/manifest.json',previewCapture:{status:'captured'},unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}],artifacts:[],checks:[]};
  await fs.mkdir(path.join(root,'dynamics'));
  for(const p of [b.modelPath,b.projectPath])await fs.writeFile(path.join(root,p),'synthetic, not a model');
  const video='dynamics/synthetic.mp4';
  await promisify(execFile)(ffmpeg,['-loglevel','error','-f','lavfi','-i','testsrc2=size=48x40:rate=10','-frames:v','14','-pix_fmt','yuv420p',path.join(root,video)]);
  for(const p of [b.modelPath,b.projectPath,video])b.artifacts.push(await artifact(root,p,'test'));
  const [model,project,animation]=b.artifacts;
  await fs.writeFile(path.join(root,b.dynamicsManifestPath),JSON.stringify({...identity,preview:{requiredCriteria:previewCriteria,
    duration:1.4,frameCount:14,videoPath:video,videoSha256:animation.sha256,modelSha256:model.sha256,projectSha256:project.sha256}}));
  b.artifacts.push(await artifact(root,b.dynamicsManifestPath,'test'));await fs.writeFile(path.join(root,'dynamics/stage.json'),JSON.stringify(b));
  const first=await reviewPage(job,0),req={id:'fixture-review',stage_sha256:first.info.stage_sha256,watched_continuously:true,
    observations:previewCriteria.map(criterion=>({criterion,status:'failed',from:0,to:1.4,note:'Synthetic test pattern; this is not a character.'}))};
  assert.equal(first.info.page_count,2);assert.equal(first.image.mimeType,'image/jpeg');assert.equal(first.info.seconds.length,12);
  await assert.rejects(recordNativeReview(job,req),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  const batch=await reviewPages(job,0,4);assert.deepEqual(batch.map(p=>p.info.page),[0,1]);
  assert.deepEqual(batch[1].info.seconds,[1.2,1.3]);
  assert.deepEqual(batch.flatMap(p=>p.info.seconds),Array.from({length:14},(_,i)=>i/10));
  await assert.rejects(recordNativeReview({...job,session:'different'},req),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  await assert.rejects(recordNativeReview(job,{...req,stage_sha256:'0'.repeat(64)}),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  const before=await fs.readFile(path.join(root,'dynamics/stage.json'),'utf8');
  await assert.rejects(recordNativeReview(job,{...req,observations:req.observations.map(o=>({...o,status:'passed'}))}),
    {code:'CONTINUOUS_REVIEW_REQUIRED'});
  assert.equal(await fs.readFile(path.join(root,'dynamics/stage.json'),'utf8'),before);
  assert.equal((await recordNativeReview(job,req)).status,'blocked');
  const saved=JSON.parse(await fs.readFile(path.join(root,'dynamics/stage.json')));
  assert.ok(saved.unresolved.every(v=>v.code==='DYNAMICS_VISUAL_REVIEW_FAILED'));
  const review=JSON.parse(await fs.readFile(path.join(root,saved.checks.find(c=>c.name==='dynamics.visual').reviewPath)));
  assert.equal(review.watchedContinuously,false);
  assert.equal(review.observationMedium,'frame_pages');
});
test('only positively unsubmitted, inactive paused artwork yields admission; existing unknown receipts remain locked',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'maker-yield-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const m=new Maker(root),prior={kind:'single_image',status:'blocked',stage:'artwork',error:{code:'ARTWORK_BACKEND_PAUSED'},pipeline:{artwork:{submitted:false}},output:root};
  assert.equal(await m.mayYield(prior),true);assert.equal(await m.mayYield({...prior,pending:{operation:'rh'}}),false);
  assert.equal(await m.mayYield({...prior,error:{code:'BACKEND_AUTH_REQUIRED'}}),true);
  assert.equal(await m.mayYield({...prior,error:{code:'FLASH_SCOPE_MISMATCH'}}),true);
  assert.equal(await m.mayYield({...prior,pipeline:{artwork:{receiptPreserved:true}}}),false);
  assert.equal(await m.mayYield({...prior,pid:process.pid}),false);
  const delivered={...prior,revision:1,pipeline:{artwork:{receiptPreserved:true}},
    completedCandidateDelivery:{status:'published',revision:2}};
  assert.equal(await m.mayYield(delivered),true);
  assert.equal(await m.mayYield({...delivered,completedCandidateDelivery:{status:'publishing',revision:2}}),false);
  assert.equal(await m.mayYield({...delivered,pending:{operation:'rh'}}),false);
  assert.equal(await m.mayYield({...delivered,pid:process.pid}),false);
  await fs.mkdir(path.join(root,'artwork'));await fs.writeFile(path.join(root,'artwork/operation.json'),'{}');
  assert.equal(await m.mayYield(prior),false);
});
test('native dynamics review watches the registered wave through return and keeps the flash check on that motion',()=>{
  const phases=[
    ['neutral',0,1],['expression:dyn_smile',6.4,8.4],['expression:dyn_surprise',8.4,10.4],
    ['cancel-motion-preserve-expression',10.4,11.4],['motion:dyn_wave',11.4,17.4],
    ['cancel:dyn_wave',17.4,18.4],['restore-baseline',18.4,19.4],['physics-slow-turn',19.4,23.4]
  ].map(([id,from,to])=>({id,from,to}));
  const required=[...previewCriteria,'additional-motion:dyn_wave'];
  const {plan,rest}=planAnimeDynamicsReview(phases,required,28.433);
  assert.deepEqual(plan.flatMap(w=>w.criteria).sort(),[...required].sort());
  const wave=plan.find(w=>w.criteria.includes('additional-motion:dyn_wave'));
  assert.ok(wave.from<11.4 && wave.to>=18.4);
  assert.ok(wave.crop && wave.size>320,'keep the shoulder, sleeve and wrist readable during motion review');
  const face=plan.find(w=>w.id==='face'),expressions=plan.find(w=>w.id==='expressions');
  assert.equal(face.to,6.4);
  assert.ok(face.crop&&face.fps===6);
  assert.equal(expressions.from,face.to);
  assert.equal(expressions.to,10.4);
  assert.ok(expressions.crop&&expressions.fps===2);
  assert.deepEqual(rest,[11.4+4.93,11.4+5.18]);
  assert.throws(()=>planAnimeDynamicsReview(phases,[...required,'additional-motion:unhandled'],28.433));
});

test('native video review reads the observed short wave ID without accepting unknown or duplicate results',()=>{
  const answer=(...criteria)=>JSON.stringify({observations:criteria.map(criterion=>({
    criterion,status:'passed',note:'Wrist and cuff descend together.'
  }))});
  const required=['additional-motion:dyn_wave'];
  assert.equal(parseTemporalObservations(answer('dyn_wave'),required)[0].criterion,required[0]);
  assert.equal(parseTemporalObservations('{"status":"failed","note":"Shoulder detaches at peak."}',required)[0].status,'failed');
  const rig=['continuous_motion_reset','gesture_sleeve_return'];
  const keyed=(first,second)=>JSON.stringify({observations:[
    {[first]:'passed',note:'Face settles to the initial shape.'},
    {[second]:'failed',note:'The cuff is detached at peak.'}
  ]});
  assert.equal(parseTemporalObservations(keyed(...rig),rig)[1].status,'failed');
  assert.throws(()=>parseTemporalObservations(keyed(rig[0],rig[0]),rig));
  assert.throws(()=>parseTemporalObservations(keyed(rig[0],'unregistered'),rig));
  for(const invalid of [answer('unknown'),answer('dyn_wave',required[0])])
    assert.throws(()=>parseTemporalObservations(invalid,required));
  assert.throws(()=>parseTemporalObservations(answer('dyn_wave'),['same-candidate-appearance']));
});

test('all reusable gestures have a continuous window covering motion and release',()=>{
  const phases=[{id:'expression:dyn_smile',from:6.4,to:8.4},{id:'expression:dyn_surprise',from:8.4,to:10.4},
    {id:'cancel-motion-preserve-expression',from:10.4,to:11.4}];
  const required=[...previewCriteria];let from=11.4;
  for(const {id,duration} of [{id:'wave',duration:6},...gestureClips]) {
    const motion='dyn_'+id,to=from+duration;required.push('additional-motion:'+motion);
    phases.push({id:'motion:'+motion,from,to},{id:'cancel:'+motion,from:to,to:to+1});from=to+1;
  }
  phases.push({id:'restore-baseline',from,to:from+1},{id:'physics-slow-turn',from:from+1,to:from+5});
  const {plan}=planAnimeDynamicsReview(phases,required,from+10);
  for(const {id} of gestureClips) {
    const motion='dyn_'+id,segment=plan.find(w=>w.criteria.includes('additional-motion:'+motion));
    assert.ok(segment.from<phases.find(p=>p.id==='motion:'+motion).from);
    assert.equal(segment.to,phases.find(p=>p.id==='cancel:'+motion).to);
  }
});

test('the deployed segmentation tree is checked without Git and detects code changes',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'anime-model-tree-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'compiler'));await fs.mkdir(path.join(root,'.git'));
  await fs.writeFile(path.join(root,'compiler','body_parser.py'),'class SemanticSam: pass\n');
  const digest=await animeModelTreeDigest(root);
  await fs.writeFile(path.join(root,'.git','config'),'inaccessible in the native worker');
  assert.equal(await animeModelTreeDigest(root),digest);
  await fs.writeFile(path.join(root,'compiler','body_parser.py'),'raise RuntimeError()\n');
  assert.notEqual(await animeModelTreeDigest(root),digest);
  await fs.symlink('compiler',path.join(root,'override'));
  await assert.rejects(animeModelTreeDigest(root),/非普通文件/);
});

test('worker loss can resume only the captured local preview owned by the active dashboard task',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'review-recovery-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const maker=new Maker(root),output=path.join(root,'result');
  const id='e70d7ce1-189e-4917-b2c1-1ba44008e12c';
  const ctx={sessionKey:'agent:live2d-streamer:dashboard:recovery',sessionId:'same-session'};
  const identity={taskId:id,candidateId:'candidate',revision:1};
  const job={...identity,id,session:maker.store.session(ctx),sessionContext:ctx,kind:'single_image',
    notifyAutomatically:true,status:'running',stage:'dynamics',pid:2147483647,output,
    pipeline:{artwork:{local:{externalSubmitted:false}}}};
  await fs.mkdir(path.join(output,'dynamics/preview'),{recursive:true});
  await fs.writeFile(path.join(output,'dynamics/stage.json'),JSON.stringify({...identity,
    status:'blocked',previewCapture:{status:'captured'},unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]}));
  const journal=path.join(output,'dynamics/preview/engine-journal.json');
  await maker.store.write('maker-active',{id});
  await maker.store.write('make-'+id,job);
  maker.resume=async (...args)=>args;
  await fs.writeFile(journal,JSON.stringify({...identity,status:'captured',revision:2}));
  assert.equal(await maker.recoverAutomaticReview(),undefined);
  await fs.writeFile(journal,JSON.stringify({...identity,status:'captured'}));
  assert.deepEqual(await maker.recoverAutomaticReview(),[id,ctx]);
  await maker.store.write('make-'+id,{...job,pending:{operation:'unknown'}});
  assert.equal(await maker.recoverAutomaticReview(),undefined);
});

test('local packaging can retry ENOSPC once and preserves the rejected receipt',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'packaging-storage-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const maker=new Maker(root),id='e70d7ce1-189e-4917-b2c1-1ba44008e12c';
  const ctx={sessionKey:'agent:live2d-streamer:dashboard:storage',sessionId:'same-session'};
  const output=path.join(root,'openclaw-workspace','outputs',id);
  const identity={taskId:id,candidateId:'candidate',revision:1,parentRevision:null,
    inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
  const error={code:'ENOSPC',message:'package scratch ran out of space'};
  const job={...identity,id,session:maker.store.session(ctx),sessionContext:ctx,kind:'single_image',
    notifyAutomatically:true,status:'failed',stage:'packaging',error,output,
    pipeline:{artwork:{local:{externalSubmitted:false}},dynamics:{status:'completed'}}};
  const writeStage=async (stage,fields)=>{
    await fs.mkdir(path.join(output,stage),{recursive:true});
    await fs.writeFile(path.join(output,stage,'stage.json'),JSON.stringify({...identity,stage,...fields}));
  };
  await writeStage('dynamics',{status:'completed',revision:2});
  await writeStage('packaging',{status:'failed',unresolved:[error],deliveryFiles:[]});
  await maker.store.write('maker-active',{id});
  await maker.store.write('make-'+id,job);
  let launches=0;
  maker.launch=async ()=>{launches++;};
  assert.equal(await maker.recoverPackageStorage(id,{...ctx,sessionId:'different'}),undefined);
  await maker.recoverAutomaticReview();
  assert.equal(launches,0);
  await writeStage('dynamics',{status:'completed'});
  await maker.recoverAutomaticReview();
  const queued=await maker.store.read('make-'+id);
  assert.equal(queued.status,'queued');
  assert.deepEqual(JSON.parse(await fs.readFile(queued.storageRecovery.receiptPath,'utf8')).unresolved,[error]);
  await maker.store.write('make-'+id,{...queued,status:'failed',error});
  await maker.recoverAutomaticReview();
  assert.equal(launches,1);
});

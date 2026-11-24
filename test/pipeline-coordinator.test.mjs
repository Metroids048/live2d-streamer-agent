import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {runImagePipeline} from '../src/pipeline/index.mjs';
import {Store} from '../src/store.mjs';
import {Maker,claimQueuedJob} from '../src/maker.mjs';
import {Readable} from 'node:stream';
import {createHash} from 'node:crypto';
import {encodePng} from '../src/artwork/png.mjs';
import https from 'node:https';
import {buildArtwork,createRunningHubLayeredBackend} from '../src/artwork/index.mjs';
import {FLASH_ROUTE} from '../src/artwork/runninghub-layered.mjs';
import {writeJson,writeBound,sha256,readJson} from '../src/artwork/files.mjs';
import {LOCAL_ARTWORK_ID,LOCAL_ARTWORK_MANIFEST} from '../src/artwork/local-artwork.mjs';

async function setup(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'avatar-pipeline-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const output=path.join(root,'output');await fs.mkdir(output);
  const job={id:'11111111-1111-4111-8111-111111111111',kind:'single_image',candidateId:'candidate',revision:1,parentRevision:null,output,request:{},steps:[]};
  return {root,job,store:new Store(root)};
}
test('unresolved intake stops before any external artwork call',async t=>{
  const s=await setup(t);let calls=0;
  await runImagePipeline(s.job,{...s,vision:{},prepare:async()=>({status:'needs_input',unresolved:[{code:'RIGHTS_UNRESOLVED'}]}),artwork:async()=>{calls++;}});
  assert.equal(s.job.status,'needs_input');assert.equal(calls,0);
});
test('accepted artwork immediately queries the same receipt; blocked pixels never become a model',async t=>{
  const s=await setup(t);let calls=0;const identity={sourceImage:{sha256:'normalized'},inputSha256:'source',descriptionSha256:'text',rights:{}};
  await runImagePipeline(s.job,{...s,vision:{},artworkPolicy:{enabled:true},prepare:async()=>({status:'completed',...identity}),artworkBackend:{id:'explicit-fixture'},artwork:async(input,ctx)=>{
    calls++;assert.equal(input.sourceImage.sha256,'normalized');assert.equal(ctx.artworkBackend.id,'explicit-fixture');
    await fs.mkdir(path.join(s.job.output,'artwork'),{recursive:true});
    if(calls===1){await fs.writeFile(path.join(s.job.output,'artwork/operation.json'),JSON.stringify({status:'running',jobId:'same-job'}));return {status:'awaiting_external_result'};}
    return {status:'blocked',unresolved:[{code:'ARTWORK_QUALITY_FAILED',message:'missing real eyelids'}]};
  }});
  assert.equal(calls,2);assert.equal(s.job.status,'blocked');assert.equal(s.job.stage,'artwork');assert.equal(s.job.error.code,'ARTWORK_QUALITY_FAILED');
  assert.equal(s.job.artifacts,undefined);
});
test('paused backend preserves completed intake without calling external generation',async t=>{
  const s=await setup(t);let calls=0;
  await fs.mkdir(path.join(s.root,'config'));await fs.writeFile(path.join(s.root,'config/project.json'),JSON.stringify({singleImage:{artwork:{enabled:false,reason:'provider failed; retain original jobs'}}}));
  await runImagePipeline(s.job,{...s,vision:{},prepare:async()=>({status:'completed',sourceImage:{sha256:'normalized'},inputSha256:'source',descriptionSha256:'text',rights:{}}),artwork:async()=>{calls++;}});
  assert.equal(s.job.pipeline.intake.status,'completed');assert.equal(s.job.status,'blocked');assert.equal(calls,0);
  assert.equal(s.job.error.code,'ARTWORK_BACKEND_PAUSED');assert.equal(s.job.pipeline.artwork.submitted,false);assert.equal(s.job.artifacts,undefined);
});
test('resume preserves immutable candidate and refuses other sessions or active makers',async t=>{
  const s=await setup(t),ctx={sessionKey:'agent:live2d-streamer:test',sessionId:'one'},maker=new Maker(s.root);let launches=0;
  maker.launch=async j=>{launches++;assert.equal(j.id,s.job.id);assert.equal(j.candidateId,'candidate');assert.equal(j.revision,1);await s.store.write('make-'+j.id,{...j,pid:process.pid});};
  Object.assign(s.job,{session:s.store.session(ctx),status:'awaiting_external_result',stage:'artwork',pending:{jobId:'external-original'}});
  await s.store.write('make-'+s.job.id,s.job);await s.store.write('maker-active',{id:s.job.id});
  assert.equal((await maker.run('make',{resume_job_id:s.job.id},{...ctx,sessionId:'other'})).code,'SESSION_MISMATCH');
  const result=await maker.run('make',{resume_job_id:s.job.id},ctx);assert.equal(result.status,'queued');assert.equal(launches,1);
  const saved=await s.store.read('make-'+s.job.id);assert.deepEqual(saved.pending,{jobId:'external-original'});
  await maker.run('make',{resume_job_id:s.job.id},ctx);assert.equal(launches,1);
  await s.store.write('maker-active',{id:'other'});assert.equal((await maker.run('make',{resume_job_id:s.job.id},ctx)).code,'MAKER_BUSY');
});
test('a dead queued dispatch resumes, and only its current child can claim the job',async t=>{
  const s=await setup(t),ctx={sessionKey:'queue-test',sessionId:'one'},maker=new Maker(s.root);
  Object.assign(s.job,{session:s.store.session(ctx),status:'queued',pid:2147483647});
  await s.store.write('make-'+s.job.id,s.job);await s.store.write('maker-active',{id:s.job.id});
  assert.equal(await claimQueuedJob(s.store,s.job.id),null);
  maker.launch=async job=>s.store.write('make-'+job.id,{...job,pid:process.pid});
  assert.equal((await maker.resume(s.job.id,ctx)).status,'queued');
  const claims=await Promise.all([claimQueuedJob(s.store,s.job.id),claimQueuedJob(s.store,s.job.id)]);
  assert.equal(claims.filter(Boolean).length,1);
  assert.equal((await s.store.read('make-'+s.job.id)).status,'running');
});
test('needs_input can revalidate saved analysis without changing the request or candidate',async t=>{
  const s=await setup(t),ctx={sessionKey:'agent:live2d-streamer:test',sessionId:'one'},maker=new Maker(s.root);let launches=0;
  const request={imageRef:'same-image',description:'same original text',rights:{license:'CC0'}};
  Object.assign(s.job,{session:s.store.session(ctx),request,status:'needs_input',stage:'intake'});
  await s.store.write('make-'+s.job.id,s.job);await s.store.write('maker-active',{id:s.job.id});
  maker.launch=async j=>{launches++;assert.deepEqual(j.request,request);assert.equal(j.candidateId,'candidate');assert.equal(j.revision,1);};
  const result=await maker.run('make',{resume_job_id:s.job.id},ctx);
  assert.equal(result.status,'queued');assert.equal(launches,1);
  const saved=await s.store.read('make-'+s.job.id);assert.deepEqual(saved.request,request);
  // A local revalidation that still needs a user decision stays blocked at intake.
  let artCalls=0;
  await runImagePipeline(saved,{...s,vision:{},prepare:async()=>({status:'needs_input',unresolved:[{code:'USER_DECISION_REQUIRED'}]}),artwork:async()=>{artCalls++;}});
  assert.equal(saved.status,'needs_input');assert.equal(artCalls,0);
});

// All RunningHub calls below use an injected offline transport and synthetic pixels.
const rhPolicy={enabled:true,provider:'runninghub',pollIntervalMs:1000,maxWaitMs:5000};
async function rhInput(s) {
  const png=encodePng({width:2,height:1,data:Buffer.from([80,20,30,128,0,0,0,0])});
  const sha=createHash('sha256').update(png).digest('hex');
  await fs.writeFile(path.join(s.job.output,'source.png'),png);
  return {schemaVersion:1,stage:'intake',status:'completed',taskId:s.job.id,candidateId:s.job.candidateId,revision:1,parentRevision:null,
    inputSha256:sha,descriptionSha256:'d'.repeat(64),sourceImage:{path:'source.png',sha256:sha,width:2,height:1,mimeType:'image/png'},
    brief:{intent:{eyes:{blink:true},mouth:{speech:true}}},rights:{allowDerivatives:true},artifacts:[],checks:[],warnings:[],unresolved:[]};
}
function offlineOnly(t) {t.mock.method(https,'request',()=>{throw new Error('TEST_EXTERNAL_NETWORK_FORBIDDEN');});}
test('native local-only replay revalidates the saved brief without using an external backend',async t=>{
  offlineOnly(t);
  const s=await setup(t);
  Object.assign(s.job,{notifyAutomatically:true,request:{description:'只在本机处理；允许用 Codex Image 2 的旧备注作废。'}});
  await writeJson(s.job.output,'intake/vision-response.json',{});
  const never=()=>assert.fail('local-only replay must not use an external backend');
  await runImagePipeline(s.job,{...s,vision:{describeImage:never,recoverDescription:never},
    artworkPolicy:{enabled:true,provider:'runninghub'},artwork:never,artworkCredentialResolver:never,
    prepare:async(_,ctx)=>{
      assert.equal(ctx.normalizeOnly,false);
      assert.equal(ctx.describeImage,undefined);
      assert.equal(ctx.recoverDescription,undefined);
      return {status:'needs_input',unresolved:[{code:'CACHED_BRIEF_INVALID',message:'缓存分析未通过原图核对'}]};
    }});
  assert.equal(s.job.status,'needs_input');
  assert.equal(s.job.error.unresolved[0].code,'CACHED_BRIEF_INVALID');
  assert.equal(await readJson(s.job.output,'artwork/operation.json'),null);
});
test('bound local layers enter Artwork without provider or vision access; bad hashes and existing remote receipts fail closed',async t=>{
  offlineOnly(t);
  const s=await setup(t),input=await rhInput(s);
  input.brief.externalApprovalNotes=['No external submission'];
  const png=await fs.readFile(path.join(s.job.output,'source.png'));
  await writeBound(s.job.output,'input/source.png',png);
  const part=encodePng({width:1,height:1,data:Buffer.from([80,20,30,128])});
  await writeBound(s.job.output,'local-artwork/parts/face.png',part);
  const canvas={width:1,height:1},rect={left:0,top:0,...canvas};
  await writeJson(s.job.output,LOCAL_ARTWORK_MANIFEST,{schemaVersion:1,taskId:input.taskId,candidateId:input.candidateId,
    revision:input.revision,inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256,normalizedSha256:input.sourceImage.sha256,
    canvas,sourceCrop:rect,parts:[{id:'face',name:'Face',tags:['face'],origin:'segmented',rect,sha256:sha256(part)}]});
  const never=()=>assert.fail('a local task must not call a remote provider or reach rigging with incomplete parts');
  const options={...s,vision:{describeImage:never},prepare:async(_,ctx)=>{
    assert.equal(ctx.describeImage,undefined);return input;
  },artworkPolicy:{enabled:false,provider:'runninghub'},artworkCredentialResolver:never,artworkRequest:never,modelStages:never};
  s.job.localArtwork={manifestSha256:'0'.repeat(64)};
  await runImagePipeline(s.job,options);
  assert.equal(s.job.error.code,'LOCAL_ARTWORK_BINDING_INVALID');
  assert.equal(await readJson(s.job.output,'artwork/operation.json'),null);
  s.job.localArtwork.manifestSha256=sha256(await fs.readFile(path.join(s.job.output,LOCAL_ARTWORK_MANIFEST)));
  await writeJson(s.job.output,'artwork/operation.json',{backend:{id:'runninghub-standard-flash'},jobId:'existing'});
  await runImagePipeline(s.job,options);
  assert.equal(s.job.error.code,'LOCAL_ARTWORK_BINDING_INVALID');
  assert.equal((await readJson(s.job.output,'artwork/operation.json')).jobId,'existing');
  await fs.unlink(path.join(s.job.output,'artwork/operation.json'));
  await runImagePipeline(s.job,options);
  assert.equal((await readJson(s.job.output,'artwork/operation.json')).backend.id,LOCAL_ARTWORK_ID);
  const manifest=await readJson(s.job.output,'artwork/artwork-manifest.json');
  assert.equal(manifest.previews.comparison.meanAbsoluteRgbDifference,0);
  assert.equal(manifest.sourceMapping.verified,true);
  assert.ok(manifest.missingSemantics.includes('eye:iris:left'));
  assert.equal(s.job.error.code,'ARTWORK_QUALITY_FAILED');
  assert.equal(s.job.pending,undefined);
  assert.equal(s.job.artifacts,undefined);
  await writeBound(s.job.output,'local-artwork/parts/face.png',png);
  await runImagePipeline(s.job,options);
  assert.equal(s.job.error.code,'LOCAL_ARTWORK_BINDING_INVALID');
});
test('native Flash reports missing gesture recipes before quoting or uploading artwork',async t=>{
  offlineOnly(t);
  const s=await setup(t),input=await rhInput(s);
  input.brief.intent.actions=[
    ['hand_on_chest','抚胸'],['point_up','竖食指'],['hold_grass','持草'],['wave','挥手'],['reset','复位'],
  ].map(([id,label])=>({id,label,source:'user',quote:label}));
  await runImagePipeline(s.job,{...s,vision:{},prepare:async()=>input,
    artworkPolicy:{...rhPolicy,route:FLASH_ROUTE,flashIntake:{allowUploadForQuote:true}},
    modelStages:async()=>{throw new Error('must not start the model stages');},
    artworkCredentialResolver:async()=>{throw new Error('must stop before accessing the provider');},
    artworkRequest:async()=>{throw new Error('must not upload');}});
  assert.equal(s.job.status,'blocked');
  assert.equal(s.job.error.code,'DYNAMICS_ACTION_UNAVAILABLE');
  assert.deepEqual(s.job.error.actions,input.brief.intent.actions.slice(0,3));
  assert.equal(s.job.pipeline.artwork.submitted,false);
});
function rhTransport({runningQueries=0,loseInference=false}={}) {
  const counts={upload:0,inference:0,query:0,download:0},jobId='2009191190196789249';
  const response=body=>({status:200,body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body))])});
  const request=async(url,options={})=>{
    if(String(url).endsWith('/binary')){counts.upload++;return response({code:0,data:{type:'image',fileName:'openapi/offline.png'}});}
    if(String(url).endsWith('/ai-app/run')){counts.inference++;if(loseInference)throw new Error('offline lost reply');return response({code:0,data:{taskId:jobId,taskStatus:'QUEUED'}});}
    if(String(url).endsWith('/query')){counts.query++;assert.deepEqual(JSON.parse(options.body),{taskId:jobId});return response(counts.query<=runningQueries?{taskId:jobId,status:'RUNNING'}:{taskId:jobId,status:'SUCCESS',results:Array.from({length:4},(_,i)=>({url:`https://rh-images.xiaoyaoyou.com/offline/output/layer-${i+1}.png`,outputType:'png'}))});}
    counts.download++;assert.equal(options.headers.Authorization,undefined);const n=Number(new URL(url).pathname.match(/layer-(\d+)/)[1]);
    return response(encodePng({width:2,height:1,data:Buffer.from([n,20,30,128,0,0,0,0])}));
  };
  return {counts,request};
}
test('public RunningHub selection blocks before artwork intents when budget or unpinned acceptance is absent',async t=>{
  offlineOnly(t);
  for(const [extra,code] of [[{},'BACKEND_BUDGET_NOT_AUTHORIZED'],[{budgetAuthorized:true},'BACKEND_MODEL_UNPINNED']]) {
    const s=await setup(t),input=await rhInput(s);let calls=0;
    await runImagePipeline(s.job,{...s,vision:{},prepare:async()=>input,artworkPolicy:{...rhPolicy,...extra},artworkCredentials:{runninghub:'offline-fake-key'},artworkRequest:async()=>{calls++;throw new Error('must not call');}});
    assert.equal(s.job.status,'blocked');assert.equal(s.job.error.code,code);assert.equal(s.job.pipeline.artwork.submitted,false);assert.equal(calls,0);
    await assert.rejects(fs.access(path.join(s.job.output,'artwork/operation.json')),e=>e.code==='ENOENT');
  }
});
test('unknown configured provider never falls back to a generation backend',async t=>{
  offlineOnly(t);
  const s=await setup(t),input=await rhInput(s);let calls=0;
  await runImagePipeline(s.job,{...s,vision:{},prepare:async()=>input,artworkPolicy:{enabled:true,provider:'unknown'},artwork:async()=>{calls++;}});
  assert.equal(s.job.error.code,'ARTWORK_BACKEND_UNSUPPORTED');assert.equal(calls,0);
});
test('public RunningHub polling uses one original job and coarse RGBA stays quality blocked',async t=>{
  offlineOnly(t);
  const s=await setup(t),input=await rhInput(s),tr=rhTransport({runningQueries:1});let modelCalls=0;
  await runImagePipeline(s.job,{...s,vision:{},prepare:async()=>input,artworkPolicy:{...rhPolicy,budgetAuthorized:true,allowUnpinnedModel:true},
    artworkCredentials:{runninghub:'offline-fake-key'},artworkRequest:tr.request,modelStages:async()=>{modelCalls++;}});
  assert.deepEqual(tr.counts,{upload:1,inference:1,query:2,download:4});assert.equal(modelCalls,0);
  assert.equal(s.job.status,'blocked');assert.equal(s.job.error.code,'ARTWORK_QUALITY_FAILED');assert.equal(s.job.artifacts,undefined);
  assert.ok(!JSON.stringify(await s.store.read('make-'+s.job.id)).includes('offline-fake-key'));
});
test('public wait deadline retains original job for recovery with generation gates closed',async t=>{
  offlineOnly(t);
  const s=await setup(t),input=await rhInput(s),tr=rhTransport({runningQueries:1});
  // Establish a durable original task before exercising a short QUERY deadline.
  // A deadline during initial upload/inference legitimately has an unknown ID instead.
  const backend=createRunningHubLayeredBackend({stateDir:path.join(s.job.output,'artwork/backend'),apiKey:'offline-fake-key',budgetAuthorized:true,allowUnpinnedModel:true,pollIntervalMs:1000,request:tr.request});
  assert.equal((await buildArtwork(input,{taskRoot:s.job.output,artworkBackend:backend})).status,'awaiting_external_result');
  const options={...s,vision:{},prepare:async()=>input,artworkCredentials:{runninghub:'offline-fake-key'},artworkRequest:tr.request};
  await runImagePipeline(s.job,{...options,artworkPolicy:{...rhPolicy,maxWaitMs:40}});
  assert.equal(s.job.status,'awaiting_external_result');assert.equal(s.job.error.code,'ARTWORK_WAIT_EXPIRED');
  assert.equal(s.job.pending.jobId,'2009191190196789249');assert.equal(tr.counts.upload,1);assert.equal(tr.counts.inference,1);assert.ok(tr.counts.query<=1);assert.equal(tr.counts.download,0);
  await runImagePipeline(s.job,{...options,artworkPolicy:rhPolicy});
  assert.deepEqual(tr.counts,{upload:1,inference:1,query:2,download:4});assert.equal(s.job.error.code,'ARTWORK_QUALITY_FAILED');
});
test('public recovery of lost inference receipt never starts polling or resubmits',async t=>{
  offlineOnly(t);
  const s=await setup(t),input=await rhInput(s),tr=rhTransport({loseInference:true});
  const options={...s,vision:{},prepare:async()=>input,artworkCredentials:{runninghub:'offline-fake-key'},artworkRequest:tr.request,
    artworkPolicy:{...rhPolicy,budgetAuthorized:true,allowUnpinnedModel:true}};
  await runImagePipeline(s.job,options);await runImagePipeline(s.job,options);
  assert.deepEqual(tr.counts,{upload:1,inference:1,query:0,download:0});assert.equal(s.job.error.code,'EXTERNAL_RESULT_UNKNOWN');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildArtwork,artworkRecipe} from '../src/artwork/index.mjs';
import {encodePng,decodePng} from '../src/artwork/png.mjs';
import {artifact,sha256,writeBound,readJson} from '../src/artwork/files.mjs';
import {reviewPage,reviewAvailable,recordNativeReview} from '../src/pipeline/native-review.mjs';
import {localRepairCriteria} from '../src/artwork/local-repair.mjs';

// Offline geometric rasters only. Use the real builder, native evidence reader and recovery path.
async function fixture(t,{omit}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'art-review-')));t.after(()=>fs.rm(root,{force:true,recursive:true}));
  const solid=(w,h,c)=>encodePng({width:w,height:h,data:Buffer.from(Array.from({length:w*h},()=>[c,35,150,255]).flat())});
  const source=solid(64,48,10),name='intake/normalized.png';await writeBound(root,name,source);
  const brief={originalDescription:'offline test',intent:{eyes:{blink:true},mouth:{speech:true},actions:[{id:'wave'}],clothingVariants:[{id:'chest_bow'}]}};
  const input={schemaVersion:1,taskId:path.basename(root),candidateId:'fixture',revision:1,parentRevision:null,inputSha256:sha256('raw source'),descriptionSha256:sha256('fixture spec'),
    sourceImage:{path:name,sha256:sha256(source),width:64,height:48,mimeType:'image/png'},brief,stage:'intake',status:'completed',
    artifacts:[await artifact(root,name,'normalized_source_image')],checks:[],warnings:[],unresolved:[],rights:{allowDerivatives:true}};
  let submissions=0,queries=0;
  const parts=artworkRecipe(brief).required.filter(s=>s!==omit).map((s,i)=>{
    const tags=s.split(':'),hidden=tags.includes('closed')&&tags.includes('eye')||tags.includes('raised')||tags.includes('underlay')||s==='mouth:open';
    return {id:'p-'+i,name:s,png:solid(2,2,40+i),origin:'generated',tags,rect:{left:(i%9)*6,top:Math.floor(i/9)*8,width:4,height:4},
      ...(hidden?{visible:false,variant:{type:'toggle',parameter:'p'+i}}:{})};
  });
  const backend={id:'offline-geometry',version:'1',modelVersion:'1',submit:async()=>{++submissions;return {status:'completed',jobId:'test-job',
    result:{canvas:{width:64,height:48},parts,quality:{checks:[],sourceCanvasMapping:{method:'source-pixels',verified:true}}}};},
    query:async()=>{++queries;throw Error('cached visual result must never query or resubmit');}};
  const ctx={taskRoot:root,artworkBackend:backend},stage=await buildArtwork(input,ctx);
  const job={id:input.taskId,candidateId:input.candidateId,revision:1,parentRevision:null,source:input,output:root,
    session:'isolated-fixture',stage:'artwork',status:stage.status,error:stage.unresolved.at(-1)};
  return {root,ctx,input,stage,job,calls:()=>[submissions,queries]};
}
async function watch(job) {
  const {info}=await reviewPage(job);
  const req={id:'offline-test',stage_sha256:info.stage_sha256,watched_continuously:true,
    observations:info.criteria.map(criterion=>({criterion,status:'passed',from:0,to:0,note:'Offline fixture: visible distinct geometric pixels.',evidencePaths:info.evidence_by_criterion[criterion]}))};
  await assert.rejects(recordNativeReview(job,req),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  const shown=new Set();
  for(let n=0;n<info.page_count;n++){
    const page=await reviewPage(job,n);assert.equal(page.image.mimeType,'image/png');assert.ok(decodePng(Buffer.from(page.image.data,'base64')).width>0);shown.add(page.info.source);
  }
  assert.deepEqual([...shown],info.pose_files);
  return req;
}
test('half blink moves only eye layers and preserves the source closed mouth',async t=>{
  const {root,stage}=await fixture(t),layout=await readJson(root,stage.layoutPath);
  const mouth=layout.layers.find(p=>p.tags?.includes('mouth')&&p.tags.includes('closed')).rect;
  const [neutral,blink]=await Promise.all(['composite','half-blink'].map(async n=>decodePng(await fs.readFile(path.join(root,'artwork',n+'.png')))));
  const i=4*(neutral.width*(mouth.top+1)+mouth.left+1);
  assert.ok(neutral.data[i+3]);assert.deepEqual(blink.data.subarray(i,i+4),neutral.data.subarray(i,i+4));
});
test('02 uses all same-session PNGs, binds each observation to the actual image, promotes only model review and resumes without inference',async t=>{
  const {job,stage,ctx,input,root,calls}=await fixture(t);
  assert.equal(job.error.code,'ARTWORK_VISUAL_REVIEW_REQUIRED');const req=await watch(job);
  assert.ok(req.observations.some(o=>o.criterion==='half-blink'&&o.evidencePaths.includes('artwork/half-blink.png')));
  await assert.rejects(recordNativeReview({...job,session:'other'},req),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  await assert.rejects(recordNativeReview(job,{...req,stage_sha256:'0'.repeat(64)}),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  const wrong=structuredClone(req);wrong.observations.find(o=>o.criterion==='raised-hand').evidencePaths=['artwork/composite.png'];
  await assert.rejects(recordNativeReview(job,wrong),{code:'ARTWORK_REVIEW_NOT_READY'});
  const next=await recordNativeReview(job,req);
  assert.equal(next.status,'completed');assert.equal(next.visualReview.reviewerKind,'model');assert.notEqual(next.artworkManifestPath,stage.artworkManifestPath);
  assert.equal((await readJson(root,stage.artworkManifestPath)).status,'blocked');assert.equal((await readJson(root,next.artworkManifestPath)).status,'completed');
  assert.ok(next.checks.some(c=>c.layer==='user_acceptance'&&c.status==='not_run'));
  assert.ok(next.checks.some(c=>c.layer==='runtime'&&c.status==='not_run'));
  assert.deepEqual(await buildArtwork(input,ctx),next);assert.deepEqual(calls(),[1,0]);
});
test('02 preserves a negative observation and refuses to send it to rigging or replay the backend',async t=>{
  const {job,input,ctx,calls}=await fixture(t),req=await watch(job);
  const row=req.observations.find(o=>o.criterion==='removed-chest-bow');row.status='failed';row.note='Offline test: unsuitable replacement pixels in this fixture.';
  const rejected=await recordNativeReview(job,req);assert.equal(rejected.status,'blocked');
  assert.equal(rejected.unresolved[0].code,'ARTWORK_VISUAL_REVIEW_FAILED');assert.equal(rejected.checks.find(c=>c.name===row.criterion).status,'failed');
  assert.equal(reviewAvailable({...job,error:rejected.unresolved[0]}),false);
  assert.deepEqual(await buildArtwork(input,ctx),rejected);assert.deepEqual(calls(),[1,0]);
});
test('only a first Flash rejection confined to a supported face defect selects local repair',async t=>{
  const {job}=await fixture(t),req=await watch(job);
  for(const o of req.observations)if(['occlusion-completion','half-blink'].includes(o.criterion))o.status='failed';
  const rejected=await recordNativeReview(job,req);
  assert.deepEqual(localRepairCriteria(rejected),[]); // non-Flash backend
  const flash={...rejected,processorSha256:'a'.repeat(64)};
  assert.deepEqual(localRepairCriteria(flash),['half-blink','occlusion-completion']);
  assert.deepEqual(localRepairCriteria({...flash,localMaterialRepair:{criteria:['half-blink']}}),[]);
  assert.deepEqual(localRepairCriteria({...flash,checks:[...flash.checks,{name:'raised-hand',layer:'visual',status:'failed'}]}),[]);
});
test('02 cannot override missing material or a registered part which changed after viewing',async t=>{
  const missing=await fixture(t,{omit:'gesture:wave:raised'});assert.equal(reviewAvailable(missing.job),false);
  await assert.rejects(reviewPage({...missing.job,error:{code:'ARTWORK_VISUAL_REVIEW_REQUIRED'}},0),{code:'ARTWORK_REVIEW_NOT_READY'});
  const {job,stage,root}=await fixture(t),req=await watch(job),part=stage.artifacts.find(a=>a.role==='artwork_part');
  await fs.appendFile(path.join(root,part.path),'changed');
  await assert.rejects(recordNativeReview(job,req),{code:'ARTWORK_REVIEW_NOT_READY'});
  assert.equal((await readJson(root,'artwork/stage.json')).status,'blocked');
});
test('native same-candidate artwork review follows the corrected operation and refuses a mismatched replacement',async t=>{
  const {job,root}=await fixture(t),op=path.join(root,'artwork/operation.json'),corrected=path.join(root,'artwork/operation-upload-correction-1013.json');
  const good=await fs.readFile(op);await fs.writeFile(corrected,good);await fs.writeFile(op,JSON.stringify({...JSON.parse(good),status:'failed'}));
  assert.ok((await reviewPage(job)).info.criteria.includes('raised-hand'));
  await fs.writeFile(corrected,JSON.stringify({...JSON.parse(good),jobId:'wrong'}));
  await assert.rejects(reviewPage(job),{code:'ARTWORK_REVIEW_NOT_READY'});
});

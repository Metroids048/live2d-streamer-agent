import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {promisify} from 'node:util';
import {Maker} from '../src/maker.mjs';
import {artifact} from '../src/packaging/files.mjs';
import {finalPreviewReviewGate,recordFinalPreviewReview} from '../src/packaging/final-preview-review.mjs';
import {equalReviewedMedia,prepareCachedReplay,verifyReplayCache} from '../src/pipeline/cached-replay.mjs';
import {ffmpeg} from '../src/preview.mjs';

async function workspace(t){
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-cache-replay-')));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;
}

test('cache review ignores only video metadata, rejects changed pixels or timing',async t=>{
  const root=await workspace(t);
  const run=promisify(execFile), video=label=>path.join(root,label+'.mp4');
  const render=async(label,color,fps)=>run(ffmpeg,['-v','error','-f','lavfi','-i',`color=${color}:s=16x16:r=${fps}`,
    '-frames:v','3','-c:v','libx264','-metadata','comment='+label,video(label)]);
  await Promise.all([render('first','red',15),render('copy','red',15),render('pixels','blue',15),render('timing','red',30)]);
  assert.equal(await equalReviewedMedia(video('first'),video('copy')),true);
  assert.equal(await equalReviewedMedia(video('first'),video('pixels')),false);
  assert.equal(await equalReviewedMedia(video('first'),video('timing')),false);
});

test('rejected or obsolete final preview cannot prevent rebuilding from verified intake cache',async t=>{
  const root=await workspace(t),id='original',candidateId='candidate',revision=30,parentRevision=29;
  const base=path.join(root,'openclaw-workspace','outputs',id),output=path.join(base,'revisions','r0030');
  const hash=value=>createHash('sha256').update(value).digest('hex');
  const description='original request',normalized='normalized image',mask='semantic mask';
  const source={inputSha256:hash('original image'),descriptionSha256:hash(description),normalizedSha256:hash(normalized)};
  const identity={taskId:id,candidateId,revision,parentRevision,...source};
  const maskPath='artwork/semantic-masks/face.png',receipt='artwork/semantic-masks/receipt.json';
  const brief={intent:{actions:[{id:'wave'}]}};
  for(const [dir,rel,value] of [[base,'intake/normalized.png',normalized],[base,'intake/normalization.json',source],
    [base,'intake/vision-response.json',{}],[output,'intake/stage.json',{...identity,status:'completed',brief,
      sourceImage:{sha256:source.normalizedSha256}}],[output,maskPath,mask],
    [output,receipt,{...identity,parts:[{id:'face',path:maskPath,sha256:hash(mask)}]}],
    [output,'packaging-hd-preview/final-review.json',{schemaVersion:2,observations:[{status:'failed'}]}]]) {
    const file=path.join(dir,rel);await fs.mkdir(path.dirname(file),{recursive:true});
    await fs.writeFile(file,typeof value==='string'?value:JSON.stringify(value));
  }
  const next=await prepareCachedReplay(root,{id,candidateId,revision,parentRevision,output,source,request:{description}});
  assert.equal(next.revision,31);
  await verifyReplayCache({...next,cachedReplay:next.cache});
  await assert.rejects(fs.stat(path.join(next.output,'packaging-hd-preview/final-review.json')),{code:'ENOENT'});

  const refinedOutput=path.join(base,'revisions','r0036');
  const artworkManifestPath='artwork/manifest.json',layoutPath='artwork/layout.json';
  await fs.mkdir(path.join(refinedOutput,'artwork'),{recursive:true});
  for(const rel of [artworkManifestPath,layoutPath])await fs.writeFile(path.join(refinedOutput,rel),'{}');
  const stagePath=path.join(refinedOutput,'artwork/stage.json');
  const stage=JSON.stringify({schemaVersion:1,stage:'artwork',status:'completed',...identity,revision:36,parentRevision:35,
    brief,artworkManifestPath,layoutPath,checks:[],unresolved:[],
    artifacts:await Promise.all([artworkManifestPath,layoutPath].map(rel=>artifact(refinedOutput,rel)))});
  await fs.writeFile(stagePath,stage);
  const parent={id,candidateId,revision,parentRevision,output,source,request:{description}};
  const refined={revision:36,parentRevision:35,artworkSha256:hash(stage)};
  const registered=await prepareCachedReplay(root,parent,refined);
  assert.equal(registered.cache.refinedArtworkSha256,refined.artworkSha256);
  await verifyReplayCache({...registered,cachedReplay:registered.cache});
  assert.deepEqual(await prepareCachedReplay(root,parent,refined),registered);
  await fs.writeFile(path.join(refinedOutput,layoutPath),'changed');
  await assert.rejects(prepareCachedReplay(root,parent,refined),{code:'REFERENCE_INVALID'});
  await fs.writeFile(path.join(refinedOutput,layoutPath),'{}');
  await fs.writeFile(stagePath,stage+'\n');
  await assert.rejects(prepareCachedReplay(root,parent,refined),{code:'CACHE_REPLAY_MISMATCH'});
});

test('refined replay from a legacy root requires the newer revision’s own final review and completed Dynamics',async t=>{
  const root=await workspace(t),maker=new Maker(root),store=maker.store;
  const id='744564ef-c324-427e-9e22-a71c6bd5f6ef',candidateId='candidate';
  const sessionContext={sessionKey:'original-owner',sessionId:'original-session'};
  const output=path.join(root,'openclaw-workspace','outputs',id);
  const source={inputSha256:'input',descriptionSha256:'description'};
  for(const revision of [9,10]) {
    const dir=path.join(output,'revisions','r00'+String(revision).padStart(2,'0'),'artwork');
    await fs.mkdir(dir,{recursive:true});
    await fs.writeFile(path.join(dir,'stage.json'),JSON.stringify({
      taskId:id,candidateId,...source,revision,parentRevision:revision-1
    }));
  }
  const job={id,candidateId,revision:1,parentRevision:null,source,output,
    kind:'single_image',status:'completed',stage:'packaging',notifyAutomatically:true,
    sessionContext,session:store.session(sessionContext)};
  await store.write('make-'+id,job);
  await assert.rejects(maker.replayCached(id,1,sessionContext,{revision:10,artworkSha256:'a'.repeat(64)}),
    {code:'FINAL_PREVIEW_REVIEW_REQUIRED'});
  const refined=path.join(output,'revisions','r0010');
  const candidate={taskId:id,candidateId,revision:10,parentRevision:9,...source};
  const videoPath='packaging-hd-preview/final.mp4';
  await fs.mkdir(path.join(refined,'packaging-hd-preview'));
  await fs.writeFile(path.join(refined,videoPath),'fixture video');
  const video=await artifact(refined,videoPath,'hd-preview-video');
  const gate=await finalPreviewReviewGate(refined,candidate,{videoPath,artifacts:[video],frameCount:90,fps:30});
  const request=JSON.parse(await fs.readFile(path.join(refined,gate.requestPath),'utf8'));
  await recordFinalPreviewReview(refined,{...request,reviewer:'test observer',observationMedium:'continuous_video',playbackRate:1,
    range:[0,3],observations:request.criteria.map(criterion=>({criterion,status:'passed',note:'Fixture observation, not visual signoff.'}))});
  await fs.mkdir(path.join(refined,'dynamics'));
  await fs.writeFile(path.join(refined,'dynamics/stage.json'),JSON.stringify({...candidate,status:'blocked',
    unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]}));
  await assert.rejects(maker.replayCached(id,1,sessionContext,{revision:10,artworkSha256:'a'.repeat(64)}),
    {code:'CACHE_REPLAY_NOT_READY'});
  assert.deepEqual(await store.read('make-'+id),job);
});

test('active packaging waits for its own full original-speed receipt, then launches once',async t=>{
  const root=await workspace(t),maker=new Maker(root),store=maker.store;
  const id='93012d0c-e203-427a-a904-3271363ddad6',candidateId='candidate';
  const sessionContext={sessionKey:'agent:live2d-streamer:dashboard:test',sessionId:'original'};
  const videoPath='packaging-hd-preview/final.mp4',file=path.join(root,videoPath);
  await fs.mkdir(path.dirname(file));await fs.writeFile(file,'exact video');
  const candidate={taskId:id,candidateId,revision:30,parentRevision:29,inputSha256:'input',descriptionSha256:'request'};
  const video=await artifact(root,videoPath,'hd-preview-video');
  const gate=await finalPreviewReviewGate(root,candidate,{videoPath,artifacts:[video],frameCount:90,fps:30});
  const job={id,candidateId,revision:30,parentRevision:29,source:{inputSha256:'input',descriptionSha256:'request'},
    kind:'single_image',status:'blocked',stage:'packaging',error:{code:'FINAL_PREVIEW_REVIEW_REQUIRED'},
    sessionContext,session:store.session(sessionContext),notifyAutomatically:true,output:root,
    pipeline:{packaging:{finalPreviewReview:gate}}};
  let launches=0;
  maker.launch=async()=>{launches++;};
  await store.write('maker-active',{id});await store.write('make-'+id,job);
  await maker.recoverAutomaticReview();assert.equal(launches,0);
  const request=JSON.parse(await fs.readFile(path.join(root,gate.requestPath),'utf8'));
  await recordFinalPreviewReview(root,{...request,reviewer:'test observer',observationMedium:'continuous_video',playbackRate:1,
    range:[0,3],observations:request.criteria.map(criterion=>({criterion,status:'passed',note:'Fixture observation, not visual signoff.'}))});
  await fs.writeFile(file,'changed video');
  await assert.rejects(maker.recoverAutomaticReview(),{code:'FINAL_PREVIEW_CHANGED'});assert.equal(launches,0);
  await fs.writeFile(file,'exact video');
  await store.write('make-'+id,{...job,revision:31});
  await assert.rejects(maker.recoverAutomaticReview(),{code:'FINAL_PREVIEW_CHANGED'});assert.equal(launches,0);
  await store.write('make-'+id,job);
  await maker.recoverAutomaticReview();await maker.recoverAutomaticReview();
  assert.equal(launches,1);assert.equal((await store.read('make-'+id)).status,'queued');
});

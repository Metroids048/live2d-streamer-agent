import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {ffmpeg} from '../src/preview.mjs';
import {artifact} from '../src/dynamics/files.mjs';
import {rigCriteriaFor} from '../src/rigging/review.mjs';
import {reviewPage,reviewPages,recordNativeReview} from '../src/pipeline/native-review.mjs';
import {Maker} from '../src/maker.mjs';

// Decodable synthetic pixels verify the native review contract, never production quality.
async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'native-rig-review-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const identity={taskId:randomUUID(),candidateId:'synthetic-candidate',revision:1,parentRevision:null,
    inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
  const brief={intent:{actions:[{id:'wave'}],clothingVariants:[{id:'chest_bow'}]}};
  const bundle={schemaVersion:1,...identity,stage:'rigging',status:'blocked',brief,engineProjectId:'synthetic-project',engineRevision:'synthetic-state',
    projectPath:'rigging/project.psd2live',psdPath:'rigging/project.psd',modelPath:'rigging/model.model3.json',parameterMapPath:'rigging/parameter-map.json',
    artifacts:[],checks:['rigging_input_integrity','rigging_rest_topology','rigging_save_reopen','rigging_export_integrity']
      .map(name=>({name,layer:'automated',status:'passed'})),unresolved:[{code:'RIG_VISUAL_REVIEW_REQUIRED'}]};
  bundle.checks.push({name:'rigging_visual_review',layer:'visual',status:'not_run'},
    {name:'rigging_runtime_follow',layer:'runtime',status:'not_run'},{name:'rigging_user_acceptance',layer:'user_acceptance',status:'not_run'});
  const put=async(relative,bytes)=>{await fs.mkdir(path.dirname(path.join(root,relative)),{recursive:true});
    await fs.writeFile(path.join(root,relative),bytes);bundle.artifacts.push(await artifact(root,relative,'synthetic'));};
  for(const relative of [bundle.projectPath,bundle.psdPath,bundle.modelPath])await put(relative,'SYNTHETIC, NOT A MODEL');
  const gif='rigging/preview/synthetic.gif';await fs.mkdir(path.join(root,'rigging/preview'));
  await promisify(execFile)(ffmpeg,['-loglevel','error','-f','lavfi','-i','testsrc2=size=24x24:rate=2',
    '-frames:v','4',path.join(root,gif)]);
  bundle.artifacts.push(await artifact(root,gif,'synthetic'));
  const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
  const poseSets={before:{},after:{}};
  for(const phase of ['before','after'])for(const name of ['headXY','midpoints','eyes','mouth','wave','bow']) {
    const file=`rigging/poses/${phase}-${name}.png`;poseSets[phase][name]=file;
    await put(file,png);await put(file.replace(/\.png$/,'.json'),JSON.stringify({...identity,projectId:bundle.engineProjectId,state:bundle.engineRevision}));
  }
  await put(bundle.parameterMapPath,JSON.stringify({...identity,projectId:bundle.engineProjectId,state:bundle.engineRevision,poseSets}));
  await fs.writeFile(path.join(root,'rigging/state.json'),JSON.stringify({identity,projectId:bundle.engineProjectId,state:bundle.engineRevision,pending:null}));
  await fs.writeFile(path.join(root,'rigging/stage.json'),JSON.stringify(bundle));
  const job={id:identity.taskId,...identity,output:root,source:identity,session:'synthetic-native-session',
    status:'blocked',stage:'rigging',error:{code:'RIG_VISUAL_REVIEW_REQUIRED'}};
  return {root,identity,job,criteria:rigCriteriaFor(brief)};
}

async function readAll(job,info) {
  for(let start=0;start<info.page_count;start+=4)await reviewPages(job,start,4);
}

test('native rigging publishes its evidence contract and records failure and reassessment in the same candidate',async t=>{
  const f=await fixture(t),{info}=await reviewPage(f.job);
  assert.equal(info.frame_count,4);assert.equal(info.page_count,13);
  assert.deepEqual(info.criteria,f.criteria);
  assert.deepEqual(info.evidence_by_criterion.head_volume_occlusion,
    ['rigging/poses/before-headXY.png','rigging/poses/after-headXY.png']);
  assert.deepEqual(info.evidence_by_criterion.gesture_sleeve_return,
    ['rigging/poses/after-wave.png','rigging/preview/synthetic.gif']);
  assert.deepEqual(info.observation_time_range,{minimum:0,maximum:info.duration,requires_positive_interval:true});
  const review={id:'synthetic-failure',stage_sha256:info.stage_sha256,watched_continuously:true,
    observations:info.criteria.map(criterion=>({criterion,status:criterion==='head_volume_occlusion'?'failed':'passed',
      from:0,to:info.duration,note:'Synthetic pixels test storage only, not a character review.',
      evidencePaths:info.evidence_by_criterion[criterion]}))};
  await assert.rejects(recordNativeReview(f.job,review),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  await readAll(f.job,info);
  const invalid={...review,observations:review.observations.map((o,i)=>i?o:{...o,to:0,evidencePaths:o.evidencePaths.slice(1)})};
  await assert.rejects(recordNativeReview(f.job,invalid),error=>{
    assert.equal(error.code,'RIG_REVIEW_INVALID');
    assert.ok(error.details.invalidFields.some(f=>f.path==='observations[0].to'));
    assert.ok(error.details.invalidFields.some(f=>f.missingPaths?.includes('rigging/poses/before-headXY.png')));return true;
  });
  const failed=await recordNativeReview(f.job,review);
  assert.equal(failed.status,'blocked');assert.equal(failed.candidateId,f.identity.candidateId);
  assert.equal(failed.rigReviews[0].status,'failed');
  assert.equal(failed.unresolved[0].criterion,'head_volume_occlusion');
  const {info:next}=await reviewPage({...f.job,error:{code:'RIG_VISUAL_REVIEW_FAILED'}});
  assert.notEqual(next.stage_sha256,info.stage_sha256);
  assert.equal(next.previous_review.path,'rigging/reviews/synthetic-failure/review.json');
  const reassessment={...review,id:'synthetic-reassessment',stage_sha256:next.stage_sha256,
    observations:review.observations.map(o=>({...o,status:'passed'}))};
  await assert.rejects(recordNativeReview(f.job,reassessment),{code:'REVIEW_EVIDENCE_INCOMPLETE'});
  await readAll(f.job,next);
  await assert.rejects(recordNativeReview(f.job,{...reassessment,supersedesReviewPath:next.previous_review.path,
    reassessmentReason:'Synthetic reassessment must use real continuous evidence.'}),{code:'CONTINUOUS_REVIEW_REQUIRED'});
  const stage=JSON.parse(await fs.readFile(path.join(f.root,'rigging/stage.json')));
  assert.equal(stage.rigReviews.length,1);
  assert.equal(stage.rigReviews[0].status,'failed');
});

test('review_only records still-frame failures without launching and rejects dynamic passes from stills',async t=>{
  for(const verdict of ['failed','passed']) {
    const f=await fixture(t),maker=new Maker(f.root),ctx={sessionKey:'synthetic-review-only',sessionId:verdict};
    f.job.kind='single_image';f.job.session=maker.store.session(ctx);f.job.steps=[];
    f.job.pipeline={rigging:{status:'blocked',bundlePath:'rigging/stage.json'}};
    await fs.writeFile(path.join(f.root,'rigging/recipe.json'),JSON.stringify({repairProfile:'synthetic-old-profile'}));
    await maker.store.write('make-'+f.job.id,f.job);await maker.store.write('maker-active',{id:f.job.id});
    const launches=[];maker.launch=async job=>launches.push(structuredClone(job));
    const {info}=await reviewPage(f.job);await readAll(f.job,info);
    const visual_review={id:'review-only-'+verdict,stage_sha256:info.stage_sha256,watched_continuously:true,
      observations:info.criteria.map((criterion,i)=>({criterion,status:i===0?verdict:'passed',from:0,to:info.duration,
        note:'Synthetic review-only lifecycle test; no character quality assertion.',evidencePaths:info.evidence_by_criterion[criterion]}))};
    const result=await maker.run('make',{resume_job_id:f.job.id,visual_review,review_only:true},ctx);
    if(verdict==='passed') {
      assert.equal(result.ok,false);assert.equal(result.code,'CONTINUOUS_REVIEW_REQUIRED');
      assert.equal(launches.length,0);
      const stage=JSON.parse(await fs.readFile(path.join(f.root,'rigging/stage.json')));
      assert.equal(stage.rigReviews,undefined);
      continue;
    }
    assert.equal(result.ok,true);assert.equal(result.status,'blocked');assert.equal(launches.length,0);
    assert.deepEqual(result.reviewRecorded,{stage:'rigging',status:verdict==='failed'?'blocked':'completed'});
    const stored=await maker.store.read('make-'+f.job.id);
    assert.equal(stored.id,f.job.id);assert.equal(stored.candidateId,f.identity.candidateId);assert.equal(stored.revision,1);
    assert.equal(stored.pipeline.rigging.status,verdict==='failed'?'blocked':'completed');
    assert.equal(stored.error.code,verdict==='failed'?'RIG_VISUAL_REVIEW_FAILED':'VISUAL_REVIEW_RECORDED');
    const stage=JSON.parse(await fs.readFile(path.join(f.root,'rigging/stage.json')));
    assert.equal(stage.rigReviews.at(-1).status,verdict);
    const resumed=await maker.run('make',{resume_job_id:f.job.id},ctx);
    assert.equal(resumed.status,'queued');assert.equal(launches.length,1);assert.equal(launches[0].candidateId,f.identity.candidateId);
  }
});

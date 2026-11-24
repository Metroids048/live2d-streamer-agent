import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {recordRigReview,rigReviewCriteria} from '../src/rigging/index.mjs';

// Synthetic files exercise review recording only; no character, editor or visual acceptance.
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const identityKeys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
async function fixture(t,{revision=2,parentRevision=1}={}) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rig-review-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const identity={taskId:'synthetic-task',candidateId:'synthetic-candidate',revision,parentRevision,inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)};
  const bundle={schemaVersion:1,...identity,stage:'rigging',status:'blocked',engineVersion:'3.6.7',engineProjectId:'synthetic-project',engineRevision:'s10',
    projectPath:'rigging/candidate.psd2live',psdPath:'rigging/candidate.psd',modelPath:'rigging/model/fixture.model3.json',parameterMapPath:'rigging/parameter-map.json',
    artifacts:[],checks:['rigging_input_integrity','rigging_rest_topology','rigging_save_reopen','rigging_export_integrity'].map(name=>({name,layer:'automated',status:'passed'})),
    warnings:[],unresolved:[{code:'RIG_VISUAL_REVIEW_REQUIRED',stage:'rigging',message:'Synthetic review required'}]};
  bundle.checks.push({name:'rigging_visual_review',layer:'visual',status:'not_run'},{name:'rigging_runtime_follow',layer:'runtime',status:'not_run'},
    {name:'rigging_user_acceptance',layer:'user_acceptance',status:'not_run'});
  const put=async(relative,data)=>{const file=path.join(root,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,data);bundle.artifacts.push({role:'synthetic_review_fixture',path:relative,sha256:sha(data),bytes:Buffer.byteLength(data)});};
  for(const relative of [bundle.projectPath,bundle.psdPath,bundle.modelPath])await put(relative,'SYNTHETIC '+relative);
  const poseSets={before:{},after:{}};
  for(const phase of ['before','after'])for(const key of ['headXY','midpoints','eyes','mouth']) {
    const relative=`rigging/poses/${phase}-${key}.png`;poseSets[phase][key]=relative;
    await put(relative,'SYNTHETIC pose bytes '+relative);
    await put(relative.replace(/\.png$/,'.json'),JSON.stringify({identity,projectId:bundle.engineProjectId,state:bundle.engineRevision}));
  }
  await put(bundle.parameterMapPath,JSON.stringify({schemaVersion:1,...identity,projectId:bundle.engineProjectId,state:bundle.engineRevision,poseSets}));
  const gif=Buffer.from('47494638396101000100800000000000ffffff21f90401640000002c00000000010001000002024401003b','hex');
  await put('rigging/preview/synthetic.gif',Buffer.concat([gif.subarray(0,19),gif.subarray(19,-1),gif.subarray(19)]));
  await fs.writeFile(path.join(root,'rigging/state.json'),JSON.stringify({identity,projectId:bundle.engineProjectId,state:bundle.engineRevision,pending:null}));
  const save=()=>fs.writeFile(path.join(root,'rigging/stage.json'),JSON.stringify(bundle));await save();
  const ctx={taskRoot:root,...identity,engine:{call(){throw new Error('Review must not use the editor');}}};
  const review={id:'synthetic-observation',candidate:Object.fromEntries(identityKeys.map(k=>[k,identity[k]])),reviewer:{kind:'model',name:'synthetic test, not real observation'},
    watchedContinuously:true,range:[0,2],evidence:bundle.artifacts.map(({path,sha256})=>({path,sha256})),
    observations:rigReviewCriteria.map(criterion=>({criterion,status:'passed',from:0,to:2,note:'Synthetic fixture observation, not production quality evidence',
      evidencePaths:bundle.artifacts.map(a=>a.path)}))};
  return {root,bundle,review,ctx,save};
}

test('review accepts real contract numeric identities 1/null and 2/1, but does not promote runtime or user acceptance',async t=>{
  for(const versions of [{revision:1,parentRevision:null},{revision:2,parentRevision:1}]) {
    const f=await fixture(t,versions),saved=[];
    const result=await recordRigReview(f.bundle,f.review,{...f.ctx,checkpoint:async data=>saved.push(data)});
    assert.equal(result.status,'completed');assert.equal(result.revision,versions.revision);assert.equal(result.parentRevision,versions.parentRevision);
    assert.equal(result.checks.find(c=>c.name==='rigging_visual_review').status,'passed');
    assert(!result.checks.some(c=>['runtime','human','user_acceptance'].includes(c.layer)&&c.status==='passed'));
    assert(result.artifacts.some(a=>a.path==='rigging/reviews/synthetic-observation/review.json'));assert.equal(saved.at(-1).status,'completed');
  }
});

test('wrong revision, stale bundle, changed model and reused review IDs cannot approve another state',async t=>{
  const f=await fixture(t);
  await assert.rejects(recordRigReview(f.bundle,f.review,{...f.ctx,revision:'2'}),{code:'RIG_REVIEW_IDENTITY_MISMATCH'});
  await assert.rejects(recordRigReview(f.bundle,{...f.review,candidate:{...f.review.candidate,revision:1}},f.ctx),{code:'RIG_REVIEW_INVALID'});
  const completed=await recordRigReview(f.bundle,f.review,f.ctx);
  await assert.rejects(recordRigReview(f.bundle,{...f.review,id:'stale'},f.ctx),{code:'RIG_REVIEW_STALE_BUNDLE'});
  await assert.rejects(recordRigReview(completed,f.review,f.ctx),{code:'RIG_REVIEW_EXISTS'});
  await fs.appendFile(path.join(f.root,f.bundle.modelPath),'changed');
  await assert.rejects(recordRigReview(completed,{...f.review,id:'changed'},f.ctx),{code:'ARTIFACT_HASH_MISMATCH'});
});

test('missing criteria, hash evidence, concrete observations or full continuous range remain unreviewed',async t=>{
  const f=await fixture(t),original=await fs.readFile(path.join(f.root,'rigging/stage.json'),'utf8');
  for(const review of [
    {...f.review,observations:f.review.observations.slice(1)},
    {...f.review,evidence:f.review.evidence.slice(1)},
    {...f.review,evidence:f.review.evidence.map((a,i)=>i? a:{...a,sha256:'c'.repeat(64)})},
    {...f.review,observations:f.review.observations.map((o,i)=>i?o:{...o,note:'OK'})},
    {...f.review,observations:f.review.observations.map((o,i)=>i?o:{...o,evidencePaths:[]})},
    {...f.review,watchedContinuously:false},{...f.review,range:[0,1]},
  ])await assert.rejects(recordRigReview(f.bundle,review,f.ctx),{code:'RIG_REVIEW_INVALID'});
  assert.equal(await fs.readFile(path.join(f.root,'rigging/stage.json'),'utf8'),original);
});

test('failed observations stay blocked; history survives reassessment, and model cannot override human rejection',async t=>{
  const f=await fixture(t);
  const failedReview={...f.review,reviewer:{kind:'human',name:'Synthetic human test boundary'},observations:f.review.observations.map((o,i)=>i?o:{...o,status:'failed',note:'Synthetic head occlusion defect, not a real candidate'})};
  const failed=await recordRigReview(f.bundle,failedReview,f.ctx);assert.equal(failed.status,'blocked');
  assert(failed.unresolved.some(u=>u.code==='RIG_VISUAL_REVIEW_FAILED'));
  const retry={...f.review,id:'reassessment',supersedesReviewPath:'rigging/reviews/synthetic-observation/review.json',reassessmentReason:'Synthetic review correction with explicit fresh observations'};
  await assert.rejects(recordRigReview(failed,retry,f.ctx),{code:'RIG_REVIEW_INVALID'});
  const done=await recordRigReview(failed,{...retry,reviewer:failedReview.reviewer},f.ctx);
  assert.equal(done.status,'completed');assert.equal(done.rigReviews.length,2);assert.equal(done.rigReviews[0].status,'failed');
  assert.equal(done.checks.find(c=>c.name==='rigging_human_review').status,'passed');
  assert.equal(done.checks.find(c=>c.name==='rigging_user_acceptance').status,'not_run');
});

test('frame-page defects remain blocked and do not claim continuous observation',async t=>{
  const f=await fixture(t);
  const frames={...f.review,watchedContinuously:false,observationMedium:'frame_pages'};
  await assert.rejects(recordRigReview(f.bundle,frames,f.ctx),{code:'RIG_REVIEW_INVALID'});
  await assert.rejects(recordRigReview(f.bundle,{...frames,watchedContinuously:true},f.ctx),{code:'RIG_REVIEW_INVALID'});
  const result=await recordRigReview(f.bundle,{...frames,observations:frames.observations.map(o=>({...o,status:'failed'}))},f.ctx);
  assert.equal(result.status,'blocked');
  const check=result.checks.find(c=>c.name==='rigging_visual_review');
  assert.match(check.note,/连续自审未完成/);
  const saved=JSON.parse(await fs.readFile(path.join(f.root,check.reviewPath)));
  assert.equal(saved.watchedContinuously,false);
  assert.match(saved.scope,/联系图缺陷审查/);
});

test('pending edit or missing automated reopen evidence prevents review; unrelated defects are never cleared',async t=>{
  const f=await fixture(t);
  const statePath=path.join(f.root,'rigging/state.json'),state=JSON.parse(await fs.readFile(statePath));
  await fs.writeFile(statePath,JSON.stringify({...state,pending:{operation:'project_open'}}));
  await assert.rejects(recordRigReview(f.bundle,f.review,f.ctx),{code:'RIG_REVIEW_NOT_READY'});
  await fs.writeFile(statePath,JSON.stringify(state));
  f.bundle.checks=f.bundle.checks.filter(c=>c.name!=='rigging_save_reopen');await f.save();
  await assert.rejects(recordRigReview(f.bundle,f.review,f.ctx),{code:'RIG_REVIEW_NOT_READY'});
  f.bundle.checks.push({name:'rigging_save_reopen',layer:'automated',status:'passed'});
  f.bundle.unresolved.push({code:'RIG_PARAMETER_NOT_MOVING',message:'Synthetic required parameter remains unavailable'});await f.save();
  const result=await recordRigReview(f.bundle,f.review,f.ctx);assert.equal(result.status,'blocked');
  assert(result.unresolved.some(u=>u.code==='RIG_PARAMETER_NOT_MOVING'));
});


test('invalid observations identify the exact range and missing per-criterion evidence without accepting either',async t=>{
  const f=await fixture(t),stage=await fs.readFile(path.join(f.root,'rigging/stage.json'),'utf8');
  const invalid={...f.review,observations:f.review.observations.map((o,i)=>i?o:{...o,from:0,to:0,
    evidencePaths:o.evidencePaths.filter(p=>p!=='rigging/poses/before-headXY.png')})};
  await assert.rejects(recordRigReview(f.bundle,invalid,f.ctx),error=>{
    assert.equal(error.code,'RIG_REVIEW_INVALID');
    assert.ok(error.details.invalidFields.some(f=>f.path==='observations[0].to'&&f.rule==='positive_interval'));
    assert.ok(error.details.invalidFields.some(f=>f.path==='observations[0].evidencePaths'&&
      f.missingPaths?.includes('rigging/poses/before-headXY.png')));return true;
  });
  assert.equal(await fs.readFile(path.join(f.root,'rigging/stage.json'),'utf8'),stage);
});

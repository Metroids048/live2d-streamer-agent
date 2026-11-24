import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID,createHash} from 'node:crypto';
import {engineLocation,imageEngineDirectory} from '../src/pipeline/engine-location.mjs';
import {RIG_REPAIR_PROFILE} from '../src/rigging/recipe.mjs';
import {prepareReviewedRigRepair,archivedRig} from '../src/pipeline/reviewed-rig-repair.mjs';

const legacyProfile='hachi-g1-shared-parent-v5';
async function failedRig(t,profile=legacyProfile) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-profile-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const job={id:randomUUID(),candidateId:randomUUID(),revision:1,parentRevision:null,kind:'single_image',output:path.join(root,'out'),source:{inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)}};
  const identity={taskId:job.id,candidateId:job.candidateId,revision:1,parentRevision:null,...job.source},dir=path.join(job.output,'rigging');
  const reviewPath='rigging/reviews/old/review.json',data='immutable failed review';
  await fs.mkdir(path.dirname(path.join(job.output,reviewPath)),{recursive:true});
  await fs.writeFile(path.join(job.output,reviewPath),data);
  const stage={...identity,stage:'rigging',status:'blocked',engineProjectId:'p',engineRevision:'v',
    rigReviews:[{path:reviewPath,status:'failed',reviewer:{kind:'model'}}],
    artifacts:[{role:'rigging_visual_review',path:reviewPath,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}],
    unresolved:[{code:'RIG_VISUAL_REVIEW_FAILED',criterion:'head_volume_occlusion',reviewPath}]};
  const journal={identity,projectId:'p',state:'v',repairProfile:profile,pending:null};
  const write=(name,value)=>fs.writeFile(path.join(dir,name),JSON.stringify(value));
  await write('stage.json',stage);await write('state.json',journal);await write('recipe.json',{repairProfile:profile});
  return {root,job,dir,stage,journal,reviewPath,data,write};
}

test('a new candidate gets its own service; a pre-existing unscoped journal keeps its engine',async t=>{
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'scoped-psd2live-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const job={id:randomUUID(),candidateId:randomUUID(),revision:1,kind:'single_image',output:path.join(root,'out')};
  const first=await engineLocation(root,job);
  assert.deepEqual(first.args,[job.id,job.candidateId,'1']);
  assert.notEqual(first.dir,(await engineLocation(root,{...job,revision:2})).dir);
  await fs.mkdir(path.join(job.output,'rigging'),{recursive:true});
  await fs.writeFile(path.join(job.output,'rigging/state.json'),'{}');
  assert.deepEqual((await engineLocation(root,job)).args,[]);
  await fs.mkdir(first.dir,{recursive:true});
  assert.deepEqual(await engineLocation(root,job),first);
  assert.deepEqual((await engineLocation(root,{...job,kind:'registered_psd'})).args,[]);
  await assert.rejects(engineLocation(root,{...job,candidateId:'../other'}),{code:'ENGINE_LEASE_IDENTITY'});
});

test('only a fully reviewed failed rig can be archived once; its next engine cannot replay the original writes',async t=>{
  const {prepareReviewedRigRepair,fitProfile,archivedRig}=await import('../src/pipeline/reviewed-rig-repair.mjs');
  const {createHash}=await import('node:crypto');
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'rig-refit-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const job={id:randomUUID(),candidateId:randomUUID(),revision:1,parentRevision:null,kind:'single_image',output:path.join(root,'out'),source:{inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)}};
  const id={taskId:job.id,candidateId:job.candidateId,revision:1,parentRevision:null,...job.source},dir=path.join(job.output,'rigging');
  await fs.mkdir(dir,{recursive:true});await fs.mkdir(path.join(root,'.local'));
  const data='immutable previous engine output',reviewPath='rigging/reviews/old/review.json';
  await fs.mkdir(path.join(dir,'reviews/old'),{recursive:true});await fs.writeFile(path.join(job.output,reviewPath),data);
  const record={...id,stage:'rigging',status:'blocked',engineProjectId:'p',engineRevision:'v',rigReviews:[{path:reviewPath,status:'failed',reviewer:{kind:'model'}}],
    artifacts:[{role:'rigging_visual_review',path:reviewPath,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')}],
    unresolved:[{code:'RIG_VISUAL_REVIEW_FAILED',criterion:'gesture_sleeve_return',reviewPath}]};
  const write=(n,j)=>fs.writeFile(path.join(dir,n),JSON.stringify(j));
  const journal={identity:id,projectId:'p',state:'v',pending:{jobId:'in-progress'}};
  await write('state.json',journal);await write('recipe.json',{});await write('stage.json',record);
  assert.equal(await prepareReviewedRigRepair(root,job,fitProfile),false);
  await write('state.json',{...journal,pending:null});
  const original=await engineLocation(root,job);
  assert.equal(await prepareReviewedRigRepair(root,job,'different'),false);
  assert.equal(await prepareReviewedRigRepair(root,job,fitProfile),true);
  assert.equal(await fs.readFile(path.join(archivedRig(job.output),'reviews/old/review.json'),'utf8'),data);
  assert.notEqual((await engineLocation(root,job)).dir,original.dir);
  assert.equal(await prepareReviewedRigRepair(root,job,fitProfile),false);
});

test('the default worker can refit a reviewed old recipe into the current recipe exactly once',async t=>{
  const f=await failedRig(t);
  const original=await engineLocation(f.root,f.job);
  assert.equal(await prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),true);
  assert.equal(await fs.readFile(path.join(archivedRig(f.job.output,RIG_REPAIR_PROFILE),'reviews/old/review.json'),'utf8'),f.data);
  const next=await engineLocation(f.root,f.job);
  assert.deepEqual(next.args,[f.job.id,f.job.candidateId,'1',RIG_REPAIR_PROFILE]);
  assert.notEqual(next.dir,original.dir);
  assert.equal(await prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),false);
  await fs.mkdir(f.dir);
  await f.write('stage.json',f.stage);await f.write('recipe.json',{repairProfile:RIG_REPAIR_PROFILE});
  await f.write('state.json',{...f.journal,repairProfile:RIG_REPAIR_PROFILE});
  assert.equal(await prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),false);
  assert.deepEqual(await engineLocation(f.root,f.job),next);
  assert.equal(await fs.readFile(path.join(archivedRig(f.job.output),'reviews/old/review.json'),'utf8'),f.data);
});

for(const historicalProfile of ['hachi-g1-shared-face-v3',legacyProfile,'hachi-full-quality-v6','hachi-full-quality-v8','semantic-surface-v9','semantic-surface-v10','semantic-surface-v11'])
test('a historical '+historicalProfile+' repair keeps its service while in flight, then gets a separate archive and engine',async t=>{
  const f=await failedRig(t,historicalProfile);
  const oldArchive=path.join(f.job.output,'rigging-before-'+historicalProfile);
  await fs.mkdir(oldArchive);await fs.writeFile(path.join(oldArchive,'stage.json'),JSON.stringify(f.stage));
  await f.write('state.json',{...f.journal,pending:{jobId:'still-on-v5'}});
  const oldLocation=await engineLocation(f.root,f.job);
  assert.deepEqual(oldLocation.args,[f.job.id,f.job.candidateId,'1',historicalProfile]);
  assert.equal(await prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),false);
  assert.deepEqual(await engineLocation(f.root,f.job),oldLocation);
  await f.write('state.json',f.journal);
  assert.equal(await prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),true);
  const next=await engineLocation(f.root,f.job);
  assert.deepEqual(next.args,[f.job.id,f.job.candidateId,'1',RIG_REPAIR_PROFILE]);
  assert.notEqual(next.dir,oldLocation.dir);
  assert.equal(JSON.parse(await fs.readFile(path.join(oldArchive,'stage.json'),'utf8')).engineProjectId,'p');
  assert.equal(imageEngineDirectory(f.root,f.job.id,f.job.candidateId,1,historicalProfile),oldLocation.dir);
  assert.throws(()=>imageEngineDirectory(f.root,f.job.id,f.job.candidateId,1,'../other'),{code:'ENGINE_LEASE_IDENTITY'});
});

for(const guard of ['same-recipe','pending','failed','identity','recipe-mismatch','hash','unreviewed','other-issue','lease-pending','build-lock','dynamics','packaging']) {
  test('current-recipe recovery preserves the '+guard+' safety guard',async t=>{
    const f=await failedRig(t,guard==='same-recipe'?RIG_REPAIR_PROFILE:legacyProfile);
    if(guard==='pending')await f.write('state.json',{...f.journal,pending:{jobId:'unknown'}});
    if(guard==='failed')await f.write('state.json',{...f.journal,failed:{code:'EDIT_FAILED'}});
    if(guard==='identity')await f.write('state.json',{...f.journal,identity:{...f.journal.identity,candidateId:randomUUID()}});
    if(guard==='recipe-mismatch')await f.write('recipe.json',{repairProfile:'another-old-recipe'});
    if(guard==='hash')await fs.writeFile(path.join(f.job.output,f.reviewPath),'tampered review');
    if(guard==='unreviewed')await f.write('stage.json',{...f.stage,rigReviews:[{...f.stage.rigReviews[0],status:'pending'}]});
    if(guard==='other-issue')await f.write('stage.json',{...f.stage,unresolved:[...f.stage.unresolved,{code:'MATERIALS_MISSING'}]});
    if(guard==='lease-pending') {
      await fs.mkdir(path.join(f.root,'.local'));
      await fs.writeFile(path.join(f.root,'.local/engine-lease.json'),JSON.stringify({...f.journal.identity,stage:'rigging',version:2,pid:null,pending:{jobId:'unresolved'}}));
    }
    if(guard==='build-lock')await fs.writeFile(path.join(f.dir,'.build.lock'),'still building');
    if(guard==='dynamics'||guard==='packaging')await fs.mkdir(path.join(f.job.output,guard));
    if(guard==='hash')await assert.rejects(prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),{code:'ARTIFACT_HASH_MISMATCH'});
    else assert.equal(await prepareReviewedRigRepair(f.root,f.job,RIG_REPAIR_PROFILE),false);
    assert.equal(await fs.readFile(path.join(f.dir,'recipe.json'),'utf8'),JSON.stringify({repairProfile:guard==='same-recipe'?RIG_REPAIR_PROFILE:guard==='recipe-mismatch'?'another-old-recipe':legacyProfile}));
    await assert.rejects(fs.stat(archivedRig(f.job.output,RIG_REPAIR_PROFILE)),{code:'ENOENT'});
    if(guard==='lease-pending')assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'.local/engine-lease.json'),'utf8')).pending.jobId,'unresolved');
  });
}

for(const guard of ['archive-identity','journal-identity','missing-journal','wrong-profile','archive-link']) {
  test('engine routing rejects '+guard+' rather than selecting another repair service',async t=>{
    const f=await failedRig(t),archive=path.join(f.job.output,'rigging-before-'+legacyProfile);
    await fs.mkdir(archive);
    if(guard==='archive-link')await fs.symlink(path.join(f.dir,'stage.json'),path.join(archive,'stage.json'));
    else await fs.writeFile(path.join(archive,'stage.json'),JSON.stringify(guard==='archive-identity'?{...f.stage,inputSha256:'c'.repeat(64)}:f.stage));
    if(guard==='journal-identity')await f.write('state.json',{...f.journal,identity:{...f.journal.identity,descriptionSha256:'c'.repeat(64)}});
    if(guard==='missing-journal')await fs.unlink(path.join(f.dir,'state.json'));
    if(guard==='wrong-profile')await f.write('state.json',{...f.journal,repairProfile:RIG_REPAIR_PROFILE});
    await assert.rejects(engineLocation(f.root,f.job),{code:'ENGINE_LEASE_IDENTITY'});
  });
}

import * as fs from 'node:fs/promises';
import path from 'node:path';
import {identityKeys,verifyArtifacts} from '../rigging/files.mjs';
import {RIG_REPAIR_PROFILE} from '../rigging/recipe.mjs';
import {acquireEngineLease} from './lease.mjs';
import {Fault} from '../rpc.mjs';

// A rejected, fully observed rig stays intact. A different fitting recipe gets one
// empty editor and the exact same approved artwork. No in-flight edit can be replaced.
export const fitProfile=RIG_REPAIR_PROFILE;
// Keep the profiles already registered by this project routable after a recipe bump.
export const rigRepairProfiles=[...new Set([fitProfile,'hachi-g1-shared-face-v3','hachi-g1-shared-parent-v5',
  'hachi-full-quality-v6','hachi-full-quality-v8','semantic-surface-v9','semantic-surface-v10','semantic-surface-v11','semantic-surface-v12',
  'semantic-surface-v42','semantic-surface-v43'])];
const issues=new Set(['gesture_sleeve_return','head_volume_occlusion','head_midpoint_continuity',
  'eye_blink_detail','mouth_cavity_closure','head_eye_mouth_combinations','continuous_motion_reset']);
const exists=async p=>{try{await fs.lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const ordinary=async p=>{if(await fs.realpath(p)!==p)throw new Fault('REFERENCE_INVALID','绑定返修路径含链接');};
const json=async p=>{await ordinary(p);return JSON.parse(await fs.readFile(p,'utf8'));};
export const archivedRig=(root,profile=fitProfile)=>path.join(root,'rigging-before-'+profile);

export async function hasReviewedRigRepair(job,stage,recipeProfile) {
  const review=stage.rigReviews?.at(-1);
  if(job.kind!=='single_image'||recipeProfile!==fitProfile||stage.stage!=='rigging'||stage.status!=='blocked'||
    review?.status!=='failed'||review.reviewer?.kind!=='model'||!stage.unresolved?.length||
    !stage.unresolved.every(i=>i.code==='RIG_VISUAL_REVIEW_FAILED'&&issues.has(i.criterion)&&i.reviewPath===review.path))return false;
  if(await exists(archivedRig(job.output,recipeProfile)))return false;
  return (await json(path.join(job.output,'rigging/recipe.json'))).repairProfile!==recipeProfile;
}

export async function prepareReviewedRigRepair(root,job,recipeProfile) {
  if(job.kind!=='single_image'||recipeProfile!==fitProfile)return false;
  const dir=path.join(job.output,'rigging'),archive=archivedRig(job.output,recipeProfile);
  if(await exists(archive)||!await exists(path.join(dir,'stage.json')))return false;
  const stage=await json(path.join(dir,'stage.json'));
  if(!await hasReviewedRigRepair(job,stage,recipeProfile))return false;
  const identity={taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision??null,
    inputSha256:job.source?.inputSha256,descriptionSha256:job.source?.descriptionSha256};
  if(identityKeys.some(k=>stage[k]!==identity[k]))throw new Fault('PIPELINE_IDENTITY_MISMATCH','绑定审查属于其他候选');
  const lease=await acquireEngineLease(root,{...identity,stage:'rigging'});
  try {
    if(lease.record.pending||await exists(archive)||await exists(path.join(dir,'.build.lock'))||await exists(path.join(job.output,'dynamics'))||await exists(path.join(job.output,'packaging')))return false;
    const journal=await json(path.join(dir,'state.json'));
    const recipe=await json(path.join(dir,'recipe.json'));
    if(journal.pending||journal.failed||journal.repairProfile===recipeProfile||journal.repairProfile!==recipe.repairProfile||
      !stage.engineProjectId||journal.projectId!==stage.engineProjectId||journal.state!==stage.engineRevision||
      identityKeys.some(k=>journal.identity?.[k]!==identity[k]))return false;
    await ordinary(dir);await verifyArtifacts(job.output,stage.artifacts);
    await fs.rename(dir,archive);return true;
  } finally {await lease.release({outcomeUnknown:!!lease.record.pending});}
}

import * as fs from 'node:fs/promises';
import path from 'node:path';
import {RigError,writeJson} from './engine.mjs';
import {identityKeys,safePath,artifact,verifyArtifacts} from './files.mjs';
import {requestedControls} from './controls.mjs';
import {inspectGif} from './geometry.mjs';

export const rigReviewCriteria=Object.freeze(['head_volume_occlusion','head_midpoint_continuity','eye_blink_detail',
  'mouth_cavity_closure','head_eye_mouth_combinations','continuous_motion_reset']);
export function rigCriteriaFor(brief) {
  const {wave,bow}=requestedControls(brief??{intent:{}});
  return [...rigReviewCriteria,...(wave?['gesture_sleeve_return']:[]),...(bow?['bow_underlay_restore']:[])];
}
// The native page descriptor and the recorder share the exact per-criterion evidence contract.
export function rigReviewEvidenceGroups(poses,animationPath) {
  return {head_volume_occlusion:[poses.before.headXY,poses.after.headXY],
    head_midpoint_continuity:[poses.before.midpoints,poses.after.midpoints],
    eye_blink_detail:[poses.before.eyes,poses.after.eyes],mouth_cavity_closure:[poses.before.mouth,poses.after.mouth],
    head_eye_mouth_combinations:poses.after.combined?[poses.after.combined]:[poses.after.eyes,poses.after.mouth],continuous_motion_reset:[animationPath],
    gesture_sleeve_return:[poses.after.wave,animationPath],bow_underlay_restore:[poses.after.bow,animationPath]};
}

const requiredChecks=['rigging_input_integrity','rigging_rest_topology','rigging_save_reopen','rigging_export_integrity'];
const fault=(code,note,details)=>{throw new RigError(code,note,details);};

async function currentState(bundle,ctx,root) {
  if(bundle?.schemaVersion!==1||bundle.stage!=='rigging'||identityKeys.some(k=>!Object.hasOwn(bundle,k))||
    ['taskId','candidateId','revision','parentRevision'].some(k=>bundle[k]!==ctx[k])||
    ['inputSha256','descriptionSha256'].some(k=>ctx[k]!==undefined&&ctx[k]!==bundle[k]))
    fault('RIG_REVIEW_IDENTITY_MISMATCH','审查必须属于同一任务、候选、修订和输入');
  const stagePath=await safePath(root,'rigging/stage.json');
  if(stagePath!==path.join(root,'rigging/stage.json'))fault('RIG_REVIEW_NOT_READY','阶段写入路径不得为软链接');
  const current=JSON.parse(await fs.readFile(stagePath,'utf8'));
  if(identityKeys.some(k=>current[k]!==bundle[k]))fault('RIG_REVIEW_IDENTITY_MISMATCH','当前阶段属于另一候选');
  await verifyArtifacts(root,current.artifacts);await verifyArtifacts(root,bundle.artifacts);
  if(JSON.stringify(current)!==JSON.stringify(bundle))fault('RIG_REVIEW_STALE_BUNDLE','请读取最新阶段，旧审查不能覆盖后续状态');
  const journal=JSON.parse(await fs.readFile(await safePath(root,'rigging/state.json'),'utf8'));
  if(!['blocked','completed'].includes(current.status)||current.pending||journal.pending||
    identityKeys.some(k=>journal.identity?.[k]!==current[k])||
    !current.engineProjectId||!current.engineRevision||journal.projectId!==current.engineProjectId||journal.state!==current.engineRevision||
    requiredChecks.some(name=>!current.checks?.some(c=>c.name===name&&c.layer==='automated'&&c.status==='passed')))
    fault('RIG_REVIEW_NOT_READY','需要已导出重开的同候选工程、实际检查和空 pending');
  for(const key of ['projectPath','psdPath','modelPath','parameterMapPath'])if(!current.artifacts.some(a=>a.path===current[key]))
    fault('RIG_REVIEW_NOT_READY','关键产物未登记实际哈希：'+key);
  const map=JSON.parse(await fs.readFile(await safePath(root,current.parameterMapPath),'utf8'));
  if(identityKeys.some(k=>map[k]!==current[k])||map.projectId!==current.engineProjectId||map.state!==current.engineRevision)
    fault('RIG_REVIEW_IDENTITY_MISMATCH','参数表不属于当前工程状态');
  const poses={before:{},after:{}};
  const {wave,bow}=requestedControls(current.brief??{intent:{}});
  const combined=!!(map.poseSets?.before?.combined||map.poseSets?.after?.combined);
  for(const phase of ['before','after'])for(const key of ['headXY','midpoints','eyes','mouth',...(wave?['wave']:[]),...(bow?['bow']:[]),...(combined?['combined']:[])]) {
    const file=map.poseSets?.[phase]?.[key];
    if(typeof file!=='string'||!file.startsWith('rigging/poses/')||!file.endsWith('.png'))fault('RIG_REVIEW_NOT_READY','缺少同版 before/after 姿态图');
    poses[phase][key]=file;
  }
  const animations=current.artifacts.filter(a=>a.path.startsWith('rigging/preview/')&&a.path.endsWith('.gif'));
  if(animations.length!==1)fault('RIG_REVIEW_NOT_READY','需要唯一的实际连续制作动画');
  const animation=animations[0],info=inspectGif(await fs.readFile(await safePath(root,animation.path)));
  if(info.frames<2||info.durationSeconds<1)fault('RIG_REVIEW_NOT_READY','制作动画没有有效连续帧');
  const poseFiles=Object.values(poses).flatMap(group=>Object.values(group));
  const paths=[current.projectPath,current.psdPath,current.modelPath,current.parameterMapPath,
    ...poseFiles,...poseFiles.map(p=>p.replace(/\.png$/,'.json')),animation.path];
  const evidence=paths.map(p=>current.artifacts.find(a=>a.path===p));
  if(evidence.some(a=>!a)||new Set(paths).size!==paths.length)fault('RIG_REVIEW_NOT_READY','姿态、回执或动画未独立登记');
  return {current,evidence,poses,animation,duration:info.durationSeconds};
}

// Records externally supplied observations; this function cannot prove that a person/model watched.
// File integrity never supplies a visual verdict, runtime result or user acceptance.
export async function recordRigReview(bundle,review,ctx) {
  const root=await fs.realpath(ctx.taskRoot),dir=path.join(root,'rigging');
  if(await fs.realpath(dir)!==dir)fault('RIG_REVIEW_NOT_READY','绑定写入目录不得为软链接');
  const lock=path.join(dir,'.build.lock');let handle;
  try {handle=await fs.open(lock,'wx');}catch(error) {if(error.code==='EEXIST')fault('RIG_REVIEW_BUSY','已有制作/审查锁，先核原操作');throw error;}
  try {
    const {current,evidence,poses,animation,duration}=await currentState(bundle,ctx,root);
    const obs=review?.observations,groups=rigReviewEvidenceGroups(poses,animation.path),criteria=rigCriteriaFor(current.brief);
    const invalidFields=[],invalid=(path,rule,extra={})=>invalidFields.push({path,rule,...extra});
    if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(review?.id??''))invalid('id','review_id');
    if(!['model','human'].includes(review?.reviewer?.kind))invalid('reviewer.kind','model_or_human');
    if(typeof review?.reviewer?.name!=='string'||!review.reviewer.name.trim())invalid('reviewer.name','nonempty_string');
    for(const key of identityKeys)if(review?.candidate?.[key]!==current[key])invalid('candidate.'+key,'same_candidate');
    const frameFailure=review?.observationMedium==='frame_pages'&&review.watchedContinuously===false&&
      Array.isArray(obs)&&obs.some(o=>o.status==='failed');
    if(review?.watchedContinuously!==true&&!frameFailure)invalid('watchedContinuously','must_be_true');
    if(review?.observationMedium==='frame_pages'&&!frameFailure)invalid('observationMedium','frame_pages_only_record_failures_without_continuous_review');
    if(!Array.isArray(review?.range)||review.range.length!==2||review.range[0]!==0||review.range[1]!==duration)
      invalid('range','full_animation_range',{expected:[0,duration]});
    if(!Array.isArray(review?.evidence)||review.evidence.length!==evidence.length||
      new Set(review.evidence.map(a=>a?.path)).size!==evidence.length||
      evidence.some(a=>!review.evidence.some(e=>e?.path===a.path&&e.sha256===a.sha256)))invalid('evidence','exact_registered_hashes');
    if(!Array.isArray(obs)||obs.length!==criteria.length||new Set(obs.map(o=>o?.criterion)).size!==criteria.length)
      invalid('observations','one_per_required_criterion',{expectedCriteria:criteria});
    if(Array.isArray(obs))for(const [i,o] of obs.entries()) {
      const field='observations['+i+']';
      if(!criteria.includes(o?.criterion))invalid(field+'.criterion','required_criterion');
      if(!['passed','failed'].includes(o?.status))invalid(field+'.status','passed_or_failed');
      if(!Number.isFinite(o?.from)||o.from<0||o.from>=duration)invalid(field+'.from','animation_time',{minimum:0,maximumExclusive:duration});
      if(!Number.isFinite(o?.to)||o.to<=o.from||o.to>duration)invalid(field+'.to','positive_interval',{after:o?.from,maximum:duration});
      if(typeof o?.note!=='string'||o.note.trim().length<8)invalid(field+'.note','concrete_observation');
      if(!Array.isArray(o?.evidencePaths))invalid(field+'.evidencePaths','required_paths',{missingPaths:groups[o?.criterion]??[]});
      else {
        const missingPaths=(groups[o.criterion]??[]).filter(p=>!o.evidencePaths.includes(p));
        const unknownPaths=o.evidencePaths.filter(p=>!evidence.some(a=>a.path===p));
        if(missingPaths.length||unknownPaths.length)invalid(field+'.evidencePaths','required_registered_paths',{missingPaths,unknownPaths});
      }
    }
    if(invalidFields.length)fault('RIG_REVIEW_INVALID',
      '审查字段无效：'+invalidFields.map(f=>f.path).join('、')+'；按每项证据路径和非零动画时间范围更正，保留实际视觉结论',
      {invalidFields});
    const previous=current.rigReviews?.at(-1);
    if(previous?.status==='failed'&&(review.supersedesReviewPath!==previous.path||
      typeof review.reassessmentReason!=='string'||review.reassessmentReason.trim().length<12||
      previous.reviewer.kind==='human'&&review.reviewer.kind!=='human'))
      fault('RIG_REVIEW_INVALID','旧失败须明确引用及给出新的核查依据；模型审查不能覆盖真人否决',
        {invalidFields:[{path:'supersedesReviewPath / reassessmentReason / reviewer.kind',rule:'explicit_reassessment',previousReviewPath:previous.path,previousReviewerKind:previous.reviewer.kind}]});
    const reviewRoot=path.join(dir,'reviews');await fs.mkdir(reviewRoot,{recursive:true});
    if(await fs.realpath(reviewRoot)!==reviewRoot)fault('RIG_REVIEW_NOT_READY','审查目录不得为软链接');
    const directory=path.join(reviewRoot,review.id);
    try {await fs.mkdir(directory);}catch(error) {if(error.code==='EEXIST')fault('RIG_REVIEW_EXISTS','保留原审查，新观察须用新的 review ID');throw error;}
    const reviewPath=`rigging/reviews/${review.id}/review.json`,record={schemaVersion:1,...structuredClone(review),recordedAt:new Date().toISOString(),
      engineProjectId:current.engineProjectId,engineRevision:current.engineRevision,animation:{...animation,durationSeconds:duration},
      scope:frameFailure?'同候选联系图缺陷审查；连续自审未完成；不代表运行器兼容、真人跟随或用户认可':
        '同候选制作姿态与连续动画的视觉审查；不代表运行器兼容、真人跟随、专业认证或用户认可'};
    await fs.writeFile(path.join(root,reviewPath),JSON.stringify(record,null,2)+'\n',{flag:'wx'});
    const failures=obs.filter(o=>o.status==='failed'),status=failures.length?'failed':'passed';
    current.unresolved=current.unresolved.filter(u=>!['RIG_VISUAL_REVIEW_REQUIRED','RIG_VISUAL_REVIEW_FAILED'].includes(u.code));
    for(const o of failures)current.unresolved.push({code:'RIG_VISUAL_REVIEW_FAILED',stage:'rigging',message:o.note,
      criterion:o.criterion,from:o.from,to:o.to,reviewPath});
    current.checks=current.checks.filter(c=>c.name!=='rigging_visual_review');
    current.checks.push({name:'rigging_visual_review',layer:'visual',status,reviewPath,
      note:(frameFailure?'联系图缺陷审查；连续自审未完成；':'同候选姿态/连续制作动画；')+'审查来源：'+review.reviewer.kind});
    if(review.reviewer.kind==='human') {
      current.checks=current.checks.filter(c=>c.name!=='rigging_human_review');
      current.checks.push({name:'rigging_human_review',layer:'human',status,reviewPath,note:'制作预览人审，非专业认证或用户认可'});
    }
    current.rigReviews=[...(current.rigReviews??[]),{path:reviewPath,reviewer:structuredClone(review.reviewer),status}];
    current.artifacts.push(await artifact(root,'rigging_visual_review',reviewPath));
    current.status=current.unresolved.length||current.checks.some(c=>['automated','visual','human'].includes(c.layer)&&['failed','blocked'].includes(c.status))?'blocked':'completed';
    await writeJson(path.join(dir,'stage.json'),current);
    await ctx.checkpoint?.({stage:'rigging',status:current.status,bundle:current});return current;
  } finally {await handle.close();await fs.unlink(lock);}
}

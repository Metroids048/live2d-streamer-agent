import * as fs from 'node:fs/promises';
import path from 'node:path';
import {Fault} from '../rpc.mjs';
import {digest,taskFile,writeJson} from './files.mjs';
import {dynamicsState,commitDynamics} from './preview-state.mjs';
import {previewCriteria} from './preview.mjs';

// A caller supplies actual timestamped observations. This API cannot prove somebody watched a video.
// It records the review source explicitly and never substitutes file checks for those observations.
export async function recordDynamicsReview(bundle,review,ctx) {
  const {root,current,manifest}=await dynamicsState(bundle,ctx),p=manifest.preview;
  if(current.previewCapture?.status!=='captured'||!p||current.status==='awaiting_external_result')
    throw new Fault('DYNAMICS_PREVIEW_NOT_READY','没有可审查的同候选完整动态采集');
  if(await digest(await taskFile(root,p.videoPath))!==p.videoSha256||
    await digest(await taskFile(root,current.modelPath))!==p.modelSha256||await digest(await taskFile(root,current.projectPath))!==p.projectSha256)
    throw new Fault('REFERENCE_INVALID','预览、模型或工程已变化，旧审查失效');
  const obs=review?.observations;
  const frameFailure=review?.observationMedium==='frame_pages'&&review.watchedContinuously===false&&
    Array.isArray(obs)&&obs.some(o=>o.status==='failed');
  const criteria=p.requiredCriteria;
  if(!Array.isArray(criteria)||!previewCriteria.every(c=>criteria.includes(c)))
    throw new Fault('DYNAMICS_PREVIEW_NOT_READY','采集缺少必需审查范围');
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(review?.id??'')||!['model','human'].includes(review?.reviewer?.kind)||
    typeof review.reviewer.name!=='string'||!review.reviewer.name.trim()||review.watchedContinuously!==true&&!frameFailure||
    review.observationMedium==='frame_pages'&&!frameFailure||
    !Array.isArray(review.range)||review.range.length!==2||review.range[0]!==0||review.range[1]!==p.duration||
    ['videoSha256','modelSha256','projectSha256'].some(k=>review[k]!==p[k])||!Array.isArray(obs)||
    obs.length!==criteria.length||new Set(obs.map(o=>o.criterion)).size!==criteria.length||
    obs.some(o=>!criteria.includes(o.criterion)||!['passed','failed'].includes(o.status)||
      !Number.isFinite(o.from)||!Number.isFinite(o.to)||o.from<0||o.to<=o.from||o.to>p.duration||
      typeof o.note!=='string'||o.note.trim().length<8))
    throw new Fault('DYNAMICS_REVIEW_INVALID','需真实连续观察、同版哈希、完整条目及有效时间段；不能用文件存在或空结论完成审查');
  const lastReview=manifest.reviews?.at(-1);
  if(lastReview?.status==='failed'&&(review.supersedesReviewPath!==lastReview.path||
    typeof review.reassessmentReason!=='string'||review.reassessmentReason.trim().length<12||
    lastReview.reviewer.kind==='human'&&review.reviewer.kind!=='human'))
    throw new Fault('DYNAMICS_REVIEW_INVALID','旧失败须明确引用及给出新的核查依据；模型审查不能覆盖真人否决');
  const lock=path.join(root,'dynamics/.review.lock');
  let handle;try {handle=await fs.open(lock,'wx');}catch(e) {
    if(e.code==='EEXIST')throw new Fault('DYNAMICS_REVIEW_BUSY','已有审查提交/恢复锁，先核原操作');throw e;
  }
  try {
    await dynamicsState(bundle,ctx); // A competing commit may have won before this lock.
    const directory='dynamics/reviews/'+review.id,reviewRoot=path.join(root,'dynamics/reviews');
    await fs.mkdir(reviewRoot,{recursive:true});
    if(await fs.realpath(reviewRoot)!==reviewRoot)throw new Fault('REFERENCE_INVALID','审查目录不得为软链接');
    try {await fs.mkdir(path.join(root,directory));}catch(e) {
      if(e.code==='EEXIST')throw new Fault('DYNAMICS_REVIEW_EXISTS','保留原审查；新观察须用新的review ID');throw e;
    }
    const reviewPath=directory+'/review.json';
    await writeJson(path.join(root,reviewPath),{schemaVersion:1,recordedAt:new Date().toISOString(),...review,
      candidate:{taskId:current.taskId,candidateId:current.candidateId,revision:current.revision,parentRevision:current.parentRevision},
      scope:(frameFailure?'同候选联系图缺陷审查；连续自审未完成；':'制作预览的视觉审查；')+'不证明运行器原生释放、真人跟随、专业人审或用户认可'},{exclusive:true});
    const failures=obs.filter(o=>o.status==='failed');
    current.unresolved=current.unresolved.filter(u=>!['DYNAMICS_VISUAL_NOT_RUN','DYNAMICS_VISUAL_REVIEW_FAILED'].includes(u.code));
    for(const o of failures)current.unresolved.push({code:'DYNAMICS_VISUAL_REVIEW_FAILED',message:o.note,
      criterion:o.criterion,from:o.from,to:o.to,reviewPath});
    const visual={name:'dynamics.visual',layer:'visual',status:failures.length?'failed':'passed',
      note:(frameFailure?'同候选联系图缺陷审查，连续自审未完成；':'同候选连续制作预览；')+'审查来源：'+review.reviewer.kind,reviewPath};
    current.checks=current.checks.filter(c=>c.name!=='dynamics.visual');current.checks.push(visual);
    for(const layer of ['runtime','human','user_acceptance'])if(!current.checks.some(c=>c.name==='dynamics.'+layer))
      current.checks.push({name:'dynamics.'+layer,layer,status:'not_run'});
    // A human visual review is recorded as such, never as professional or user acceptance.
    if(review.reviewer.kind==='human') {
      current.checks=current.checks.filter(c=>c.name!=='dynamics.human');
      current.checks.push({name:'dynamics.human',layer:'human',status:visual.status,reviewPath,note:'制作预览人审，非专业认证/用户认可'});
    }
    current.status=current.unresolved.length||current.checks.some(c=>['automated','visual','human'].includes(c.layer)&&
      ['failed','blocked'].includes(c.status))?'blocked':'completed';
    manifest.reviews=[...(manifest.reviews??[]),{path:reviewPath,reviewer:review.reviewer,status:visual.status}];
    return await commitDynamics(root,current,manifest,directory,[reviewPath],ctx);
  } finally {await handle.close();await fs.rm(lock,{force:true});}
}

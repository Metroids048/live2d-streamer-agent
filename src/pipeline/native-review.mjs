import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ffmpeg} from '../preview.mjs';
import {Fault} from '../rpc.mjs';
import {taskFile,digest} from '../dynamics/files.mjs';
import {rigCriteriaFor,rigReviewEvidenceGroups,recordRigReview} from '../rigging/review.mjs';
import {recordDynamicsReview} from '../dynamics/review.mjs';
import {inspectGif} from '../rigging/geometry.mjs';
import {identityKeys} from './lease.mjs';
import {artworkReviewDescriptor,recordArtworkReview} from '../artwork/visual-review.mjs';

const exec=promisify(execFile),perPage=12,seen=new Map();
const fail=(code,message)=>{throw new Fault(code,message);};
export function reviewAvailable(job) {
  if(job.stage==='artwork')return job.status==='blocked'&&job.error?.code==='ARTWORK_VISUAL_REVIEW_REQUIRED';
  return job.status==='blocked'&&['RIG_VISUAL_REVIEW_REQUIRED','RIG_VISUAL_REVIEW_FAILED',
    'DYNAMICS_VISUAL_NOT_RUN','DYNAMICS_VISUAL_REVIEW_FAILED'].includes(job.error?.code)&&
    ['rigging','dynamics'].includes(job.stage);
}
export async function reviewDescriptor(job,{checkAll=false}={}) {
  if(!reviewAvailable(job))fail('VISUAL_REVIEW_NOT_READY','此任务尚无可审查的完整同版制作预览');
  const root=await fs.realpath(job.output),raw=await fs.readFile(await taskFile(root,job.stage+'/stage.json'));
  const sha=createHash('sha256').update(raw).digest('hex'),bundle=JSON.parse(raw);
  const ctx={taskRoot:root,taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision??null,
    inputSha256:job.source?.inputSha256,descriptionSha256:job.source?.descriptionSha256};
  if(bundle.schemaVersion!==1||bundle.stage!==job.stage||identityKeys.some(k=>bundle[k]!==ctx[k]))
    fail('VISUAL_REVIEW_IDENTITY','预览与当前原生请求不同版');
  if(job.stage==='artwork'){
    const a=await artworkReviewDescriptor(bundle,ctx,{checkAll});
    return {root,ctx,bundle,sha,...a,count:0,duration:0,total:a.stills.length,binding:{stageSha256:sha}};
  }
  const files=new Map(bundle.artifacts.map(a=>[a.path,a]));
  async function checked(relative) {
    const a=files.get(relative);if(!a)fail('REFERENCE_INVALID','审查证据未登记');
    const file=await taskFile(root,relative);
    if(await digest(file)!==a.sha256)fail('REFERENCE_INVALID','审查证据字节已改变');
    return file;
  }
  const read=async relative=>JSON.parse(await fs.readFile(await checked(relative),'utf8'));
  let duration,count,video,stills=[],criteria,binding,paths;
  if(job.stage==='rigging') {
    const map=await read(bundle.parameterMapPath);
    if(identityKeys.some(k=>map[k]!==ctx[k]))fail('VISUAL_REVIEW_IDENTITY','姿态表与当前候选不符');
    stills=['before','after'].flatMap(phase=>Object.values(map.poseSets?.[phase]??{}));
    const animations=bundle.artifacts.filter(a=>a.path.startsWith('rigging/preview/')&&a.path.endsWith('.gif'));
    if(animations.length!==1)fail('VISUAL_REVIEW_NOT_READY','缺少唯一连续制作动画');
    video=animations[0].path;
    const info=inspectGif(await fs.readFile(await checked(video)));count=info.frames;duration=info.durationSeconds;
    paths=rigReviewEvidenceGroups(map.poseSets,video);
    const evidencePaths=[bundle.projectPath,bundle.psdPath,bundle.modelPath,bundle.parameterMapPath,
      ...stills,...stills.map(p=>p.replace(/\.png$/,'.json')),video];
    binding={candidate:Object.fromEntries(identityKeys.map(k=>[k,ctx[k]])),evidence:evidencePaths.map(p=>{
      if(!files.has(p))fail('REFERENCE_INVALID','同版证据不完整');return {path:p,sha256:files.get(p).sha256};})};
    criteria=rigCriteriaFor(bundle.brief);
  }else {
    const manifest=await read(bundle.dynamicsManifestPath),p=manifest.preview;
    if(!p||bundle.previewCapture?.status!=='captured')fail('VISUAL_REVIEW_NOT_READY','尚未取得动态预览');
    video=p.videoPath;duration=p.duration;count=p.frameCount;criteria=p.requiredCriteria;
    if(files.get(video)?.sha256!==p.videoSha256)fail('REFERENCE_INVALID','动态预览输入哈希不符');
    binding={videoSha256:p.videoSha256,projectSha256:p.projectSha256,modelSha256:p.modelSha256};
  }
  if(!Number.isInteger(count)||count<2||count>4800||!(duration>0))fail('VISUAL_REVIEW_NOT_READY','缺少有效的完整时间范围');
  const total=stills.length+Math.ceil(count/perPage);
  return {root,ctx,bundle,sha,stills,video,count,duration,criteria,binding,checked,total,paths};
}

// 'making' stays read-only: reviewed-page receipts are process-local. A plugin reload requires
// rereading pixels, never a fresh editor run. Every decoded frame is shown, in presentation order.
export async function reviewPage(job,page,{mark=true}={}) {
  const d=await reviewDescriptor(job,{checkAll:page===undefined||page===0}),art=job.stage==='artwork';
  const info={stage:job.stage,stage_sha256:d.sha,page_count:d.total,original:d.video,pose_files:d.stills,
    frame_count:d.count,duration:d.duration,criteria:d.criteria,
    observation_medium:art?'static_pages':'frame_pages',continuous_review_provided:false,
    order:'先逐页查看姿态与随后按时间顺序排列的全部原生帧，再逐项记录实际观察；联系图不提供连续运动感知，只能据此记录动态缺陷，不能据此通过动态验收。'};
  if(job.stage==='rigging')Object.assign(info,{
    evidence_by_criterion:Object.fromEntries(d.criteria.map(c=>[c,d.paths[c]])),
    observation_time_range:{minimum:0,maximum:d.duration,requires_positive_interval:true},
    ...(d.bundle.rigReviews?.length?{previous_review:d.bundle.rigReviews.at(-1)}:{}),
    order:info.order+' 每项 evidencePaths 必须包含 evidence_by_criterion 的全部路径；from/to 是动画观察区间，须 0<=from<to<=duration，静态姿态项也不能填 from=to=0。'});
  if(art)Object.assign(info,{evidence_by_criterion:d.paths,order:'脸部六格图按行依次是原图、默认、移开刘海、半闭眼、张嘴、小幅移动刘海。逐页查看原画与实际分层重组 PNG；逐项写明观察与该项所列 evidencePaths，静态图 from=to=0。watched_continuously 表示看完本组静态图；不代表动态、人审或真人跟随。'});
  if(page===undefined)return {info};
  if(!Number.isInteger(page)||page<0||page>=d.total)fail('INVALID_PAGE','页号必须在本候选范围内，从0起算');
  const still=page<d.stills.length,relative=still?d.stills[page]:d.video;
  const start=(page-d.stills.length)*perPage,end=Math.min(start+perPage-1,d.count-1);
  const filter=art?"scale=w='min(2048,iw)':h='min(2048,ih)':force_original_aspect_ratio=decrease":still?'scale=2048:2048:force_original_aspect_ratio=decrease':
    'select=between(n\\,'+start+'\\,'+end+'),showinfo,scale=384:384:force_original_aspect_ratio=decrease,pad=384:384:(ow-iw)/2:(oh-ih)/2,tile=4x3';
  const {stdout,stderr}=await exec(ffmpeg,['-nostdin','-hide_banner','-nostats','-loglevel',still?'error':'info','-i',await d.checked(relative),
    '-an','-vf',filter,'-frames:v','1',...(art?['-c:v','png']:['-q:v','2','-c:v','mjpeg']),'-f','image2pipe','pipe:1'],
    {encoding:'buffer',timeout:60000,maxBuffer:20*1024*1024});
  if(!(art?stdout.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')):stdout.length>=4&&stdout[0]===0xff&&stdout[1]===0xd8))
    fail('VISUAL_MEDIA_INVALID','审查页未成功解码');
  const times=still?[]:[...stderr.toString().matchAll(/\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:\s*([-+\d.eE]+)/g)].map(m=>Number(m[1]));
  if(!still&&(times.length!==end-start+1||times.some(v=>!Number.isFinite(v))))fail('VISUAL_MEDIA_INVALID','连续帧解码不完整，未登记观察页');
  if(mark) markSeen(job,d.sha,[page]);
  return {info:{...info,page,source:relative,...(!still?{firstFrame:start,lastFrame:end,seconds:times,layout:'4×3 从左到右，再到下一行'}:{})},
    image:{type:'image',mimeType:art?'image/png':'image/jpeg',data:stdout.toString('base64')}};
}

function markSeen(job,sha,pages) {
  const key=job.session+':'+sha;
  if(!seen.has(key)){if(seen.size>=16)seen.delete(seen.keys().next().value);seen.set(key,new Set());}
  for(const page of pages)seen.get(key).add(page);
}

// Return all images at their original review resolution, without skipping frames.
// A failed batch cannot leave a receipt for a page the viewer never received.
export async function reviewPages(job,start,count=1) {
  if(!Number.isInteger(start)||start<0||!Number.isInteger(count)||count<1||count>4)fail('INVALID_PAGE','每次可连续读取 1 至 4 页');
  const pages=[];
  for(let i=0;i<count;i++) {
    if(pages.length&&start+i>=pages[0].info.page_count)break;
    const page=await reviewPage(job,start+i,{mark:false});
    if(pages.length&&page.info.stage_sha256!==pages[0].info.stage_sha256)fail('VISUAL_REVIEW_IDENTITY','审查版本已变化');
    pages.push(page);
  }
  markSeen(job,pages[0].info.stage_sha256,pages.map(p=>p.info.page));
  return pages;
}

export async function recordNativeReview(job,submission) {
  const d=await reviewDescriptor(job);
  if(submission.stage_sha256!==d.sha||submission.watched_continuously!==true||seen.get(job.session+':'+d.sha)?.size!==d.total)
    fail('REVIEW_EVIDENCE_INCOMPLETE','请在同一会话按页逐帧查看完整同版证据；重载后须重新查看，不重跑制作');
  // This tool transports still pages only. Its receipts cannot attest to a video
  // observation, even when a caller sets watched_continuously=true.
  const art=job.stage==='artwork';
  if(!art&&!(Array.isArray(submission.observations)&&submission.observations.some(o=>o?.status==='failed')))
    fail('CONTINUOUS_REVIEW_REQUIRED','本工具仅提供联系图，连续自审未完成；保留待验，不能提交动态通过。实际连续视频审查须由可感知视频的独立入口记录。');
  const review={...d.binding,id:submission.id,reviewer:{kind:'model',name:art?'OpenClaw 同会话分层图审查':'OpenClaw 同会话逐帧缺陷审查'},
    range:[0,d.duration],watchedContinuously:art,observationMedium:art?'static_pages':'frame_pages',observations:submission.observations,
    ...(submission.supersedesReviewPath?{supersedesReviewPath:submission.supersedesReviewPath,reassessmentReason:submission.reassessmentReason}:{})};
  return (job.stage==='artwork'?recordArtworkReview:job.stage==='rigging'?recordRigReview:recordDynamicsReview)(d.bundle,review,d.ctx);
}

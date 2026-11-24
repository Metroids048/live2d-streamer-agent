import * as fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {artifact,json,regular,reject,writeJson} from './files.mjs';
import {identityKeys} from '../pipeline/lease.mjs';

const requestPath='packaging-hd-preview/final-review-request.json';
const receiptPath='packaging-hd-preview/final-review.json';
const legacyCriteria=['hair_and_layer_overlap','composition_and_crop','natural_motion','gesture_and_return'];
const rigCriteria=[...legacyCriteria,'brow_layer_ownership','hand_wrist_elbow'];
const criteriaByVersion={
  1:legacyCriteria,
  2:rigCriteria,
  3:[...rigCriteria,'idle_hands_and_head_body_coupling','greeting_entry_hold_and_settle']
};
const currentVersion=3;
const identity=value=>Object.fromEntries(identityKeys.map(key=>[key,value[key]]));
const sameBytes=(a,b)=>a.sha256===b?.sha256&&a.bytes===b?.bytes;

async function optionalJson(root,file) {
  try {await fs.lstat(path.join(root,file));}
  catch(error) {if(error.code==='ENOENT')return null;throw error;}
  return json(root,file);
}

async function reviewRequest(root) {
  const request=await json(root,requestPath);
  const video=await artifact(root,request.video.path,'hd-preview-video');
  if(!sameBytes(video,request.video))reject('FINAL_PREVIEW_CHANGED','成片字节已变化，原视觉验收失效');
  return request;
}

export function verifyFinalPreviewReceipt(receipt,candidate,video,duration,version=receipt?.schemaVersion) {
  const criteria=Number.isInteger(version)&&criteriaByVersion[version];
  if(!criteria||receipt?.schemaVersion!==version||!isDeepStrictEqual(receipt.candidate,identity(candidate))||
    !sameBytes(video,receipt.video)||receipt.duration!==duration||
    receipt.observationMedium!=='continuous_video'||receipt.playbackRate!==1||
    !isDeepStrictEqual(receipt.range,[0,duration])||!Number.isFinite(Date.parse(receipt.reviewedAt))||
    typeof receipt.reviewer!=='string'||!receipt.reviewer.trim()||
    !Array.isArray(receipt.observations)||receipt.observations.length!==criteria.length||
    !criteria.every(criterion=>receipt.observations.filter(o=>o?.criterion===criterion&&
      ['passed','failed'].includes(o.status)&&typeof o.note==='string'&&o.note.trim().length>=8).length===1))
    reject('FINAL_PREVIEW_REVIEW_INVALID','成片验收需要同任务、同版、同一份 MP4 的原速全段观察及逐项具体记录');
  return receipt.observations.every(o=>o.status==='passed');
}

export async function passedFinalPreviewReview(root,job,expected) {
  const receipt=await optionalJson(root,receiptPath);
  if(!receipt)return false;
  const request=await reviewRequest(root);
  const candidate={taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision??null,
    inputSha256:job.source?.inputSha256,descriptionSha256:job.source?.descriptionSha256};
  if(!isDeepStrictEqual(request.candidate,candidate)||
    !isDeepStrictEqual(request.criteria,criteriaByVersion[request.schemaVersion])||
    expected&&(!sameBytes(request.video,expected)||request.video.path!==expected.videoPath||request.duration!==expected.duration))
    reject('FINAL_PREVIEW_CHANGED','成片请求与当前制作停点不同版');
  return request.schemaVersion===currentVersion&&verifyFinalPreviewReceipt(receipt,candidate,request.video,request.duration,currentVersion);
}

// Called by the production packager after decoding the actual MP4, before opening or exporting editable files.
export async function finalPreviewReviewGate(root,candidate,hd) {
  const video=await artifact(root,hd.videoPath,'hd-preview-video');
  if(!sameBytes(video,hd.artifacts.find(a=>a.path===hd.videoPath)))reject('FINAL_PREVIEW_CHANGED','成片与渲染登记不符');
  const request={schemaVersion:currentVersion,candidate:identity(candidate),video,duration:hd.frameCount/hd.fps,
    criteria:criteriaByVersion[currentVersion]};
  try {await writeJson(path.join(root,requestPath),request);}
  catch(error) {if(error.code!=='EEXIST')throw error;}
  const existing=await reviewRequest(root);
  const receipt=await optionalJson(root,receiptPath);
  const legacy=[1,2].some(version=>isDeepStrictEqual(existing,{...request,schemaVersion:version,criteria:criteriaByVersion[version]}));
  if(!legacy&&!isDeepStrictEqual(existing,request))
    reject('FINAL_PREVIEW_CHANGED','已有成片验收请求属于不同版本或文件');
  if(legacy&&(!receipt||verifyFinalPreviewReceipt(receipt,candidate,video,request.duration,existing.schemaVersion)))
    reject('FINAL_PREVIEW_REVIEW_UPGRADE_REQUIRED','旧验收缺少待机双手、头身联动和动作收势，请为成片创建新修订');
  const passed=!legacy&&receipt&&verifyFinalPreviewReceipt(receipt,candidate,video,request.duration,currentVersion);
  return {status:passed?'passed':receipt?'failed':'pending',requestPath,
    videoPath:video.path,sha256:video.sha256,bytes:video.bytes,duration:request.duration,
    ...(receipt?{receiptPath}:{})};
}

// Only a local reviewer that could observe continuous playback records the receipt.
// The chat's frame-page tool cannot author or promote this record.
export async function recordFinalPreviewReview(root,observation) {
  const request=await reviewRequest(root);
  if(request.schemaVersion!==currentVersion||!isDeepStrictEqual(request.criteria,criteriaByVersion[currentVersion]))
    reject('FINAL_PREVIEW_REVIEW_UPGRADE_REQUIRED','成片需检查待机双手、头身联动和动作收势');
  const {candidate,video,duration,observationMedium,playbackRate,range,reviewer,observations}=observation??{};
  const receipt={schemaVersion:currentVersion,candidate,video:video&&{sha256:video.sha256,bytes:video.bytes},
    duration,observationMedium,playbackRate,range,reviewer,reviewedAt:new Date().toISOString(),
    observations:Array.isArray(observations)?observations.map(o=>({criterion:o?.criterion,status:o?.status,note:o?.note})):observations};
  const passed=verifyFinalPreviewReceipt(receipt,request.candidate,request.video,request.duration,currentVersion);
  await writeJson(path.join(root,receiptPath),receipt);
  return {status:passed?'passed':'failed',receipt:await regular(root,receiptPath)};
}

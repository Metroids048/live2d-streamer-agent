import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fail} from '../rpc.mjs';
import {artifact,digest,json,regular} from '../packaging/files.mjs';
import {ffmpeg} from '../preview.mjs';
import {recordArtworkReview} from '../artwork/visual-review.mjs';
import {recordRigReview} from '../rigging/review.mjs';
import {recordDynamicsReview} from '../dynamics/review.mjs';
import {reviewDescriptor} from './native-review.mjs';
import {savedStage} from './model-stages.mjs';

const name=n=>'r'+String(n).padStart(4,'0');
const sha=value=>createHash('sha256').update(value).digest('hex');
const requireProof=(condition,message)=>{if(!condition)fail('CACHE_REPLAY_MISMATCH',message);};
const read=(root,rel)=>json(root,rel);
const maskPath='artwork/semantic-masks/receipt.json';
const stageCode={artwork:'ARTWORK_VISUAL_REVIEW_REQUIRED',rigging:'RIG_VISUAL_REVIEW_REQUIRED',dynamics:'DYNAMICS_VISUAL_NOT_RUN'};

function describes(bundle,job){
  return bundle.taskId===job.id&&bundle.candidateId===job.candidateId&&bundle.revision===job.revision&&
    bundle.parentRevision===(job.parentRevision??null)&&bundle.inputSha256===job.source.inputSha256&&
    bundle.descriptionSha256===job.source.descriptionSha256;
}
const write=async(root,rel,value)=>fs.writeFile(path.join(root,rel),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
const copy=async(from,to,rel)=>fs.copyFile(await regular(from,rel),path.join(to,rel),fs.constants.COPYFILE_EXCL);

// Only the original intake and semantic pixels cross revisions. A rejected final
// preview does not invalidate those inputs or authorize delivery of the new build.
export async function prepareCachedReplay(root,parent,refined) {
  const base=path.join(root,'openclaw-workspace','outputs',parent.id);
  const revisions=path.join(base,'revisions'),revision=refined?.revision??parent.revision+1;
  const output=path.join(revisions,name(revision));
  const legacyRoot=refined&&parent.revision===1&&parent.output===base;
  requireProof(Number.isSafeInteger(parent.revision)&&parent.revision>0&&(legacyRoot||parent.output===path.join(revisions,name(parent.revision)))&&
    await fs.realpath(revisions)===revisions&&await fs.realpath(parent.output)===parent.output,'父版输出目录与原任务不符');
  const [intake,masks,normalization]=await Promise.all([read(parent.output,'intake/stage.json'),read(parent.output,maskPath),read(base,'intake/normalization.json')]);
  requireProof(describes(intake,parent)&&intake.status==='completed'&&
    sha(parent.request.description)===parent.source.descriptionSha256&&masks.taskId===parent.id&&masks.candidateId===parent.candidateId&&
    masks.inputSha256===parent.source.inputSha256&&masks.descriptionSha256===parent.source.descriptionSha256&&
    masks.normalizedSha256===parent.source.normalizedSha256&&normalization.inputSha256===parent.source.inputSha256&&
    normalization.normalizedSha256===parent.source.normalizedSha256&&
    (await artifact(base,'intake/normalized.png')).sha256===parent.source.normalizedSha256,'原图、原话或语义缓存不符');
  if(masks.revision!==parent.revision) {
    requireProof(refined&&Number.isSafeInteger(masks.revision)&&masks.revision>0&&masks.revision<parent.revision,
      '语义缓存修订不属于精修原任务');
    let checkpoint=intake,maskRoot;
    while(checkpoint.revision!==masks.revision) {
      const revision=checkpoint.parentRevision;
      requireProof(Number.isSafeInteger(revision)&&revision>=masks.revision&&revision<checkpoint.revision,'找不到登记遮罩的父版');
      maskRoot=path.join(revisions,name(revision));
      checkpoint=await read(maskRoot,'intake/stage.json');
      requireProof(describes(checkpoint,{...parent,revision,parentRevision:checkpoint.parentRevision})&&
        checkpoint.status==='completed','遮罩父版的原任务输入不符');
    }
    requireProof((await artifact(maskRoot,maskPath)).sha256===(await artifact(parent.output,maskPath)).sha256,
      '当前遮罩回执与原登记父版不一致');
  }
  requireProof(Array.isArray(masks.parts)&&masks.parts.length>0,'没有语义缓存');
  const [vision,...maskProofs]=await Promise.all([artifact(base,'intake/vision-response.json'),
    ...masks.parts.map(async part=>{
      requireProof(/^[a-z]+$/.test(part.id)&&part.path===`artwork/semantic-masks/${part.id}.png`,'语义缓存路径无效');
      const actual=await artifact(parent.output,part.path);
      requireProof(actual.sha256===part.sha256,'语义缓存像素已改变');return actual;
    })]);
  const cache={parentOutput:parent.output,parentRevision:parent.revision,parentParentRevision:parent.parentRevision??null,
    visionSha256:vision.sha256,masks:maskProofs.map(({path,sha256})=>({path,sha256}))};
  if(refined) {
    requireProof(revision>parent.revision&&await fs.realpath(output)===output,'精修续跑需要已登记的更新修订');
    cache.refinedArtworkSha256=refined.artworkSha256;
    await loadRefinedArtworkCheckpoint({...parent,output,revision,parentRevision:refined.parentRevision,cachedReplay:cache},
      intake,{taskRoot:output});
    const maskBytes=JSON.stringify({...masks,revision},null,2)+'\n';
    const inputs=[
      {root:base,path:'intake/normalized.png',sha256:parent.source.normalizedSha256},
      {root:base,...await artifact(base,'intake/normalization.json')},
      {root:base,...vision},
      ...cache.masks.map(row=>({root:parent.output,...row}))
    ];
    for(const row of [...inputs,{path:maskPath,sha256:sha(maskBytes)}]) {
      const directory=path.join(output,path.dirname(row.path));
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      requireProof(await fs.realpath(directory)===directory,'精修缓存目录含链接');
      try {
        if(row.root)await copy(row.root,output,row.path);
        else await fs.writeFile(path.join(output,maskPath),maskBytes,{flag:'wx',mode:0o600});
      } catch(e) {if(e.code!=='EEXIST')throw e;}
      requireProof((await artifact(output,row.path)).sha256===row.sha256,'精修候选已有不同的缓存：'+row.path);
    }
    return {output,revision,cache};
  }
  await fs.mkdir(output,{mode:0o700});
  try {
    await fs.mkdir(path.join(output,'intake'));await fs.mkdir(path.join(output,'artwork/semantic-masks'),{recursive:true});
    await Promise.all(['intake/normalized.png','intake/normalization.json',vision.path].map(rel=>copy(base,output,rel)));
    await Promise.all(cache.masks.map(part=>copy(parent.output,output,part.path)));
    await write(output,maskPath,{...masks,revision});
    return {output,revision,cache};
  } catch(e){await fs.rm(output,{recursive:true,force:true});throw e;}
}
export async function verifyReplayCache(job){
  const cache=job.cachedReplay;
  requireProof((await artifact(job.output,'intake/vision-response.json')).sha256===cache.visionSha256,'本机回归缺少原分析回执');
  const masks=await read(job.output,maskPath);
  requireProof(masks.revision===job.revision&&isDeepStrictEqual(masks.parts.map(({path,sha256})=>({path,sha256})),cache.masks),'本机回归缺少原语义缓存');
  await Promise.all(cache.masks.map(async row=>requireProof((await artifact(job.output,row.path)).sha256===row.sha256,'本机回归语义像素已变')));
}

export async function loadRefinedArtworkCheckpoint(job,input,ctx) {
  const expected=job.cachedReplay.refinedArtworkSha256;
  requireProof(/^[a-f0-9]{64}$/.test(expected??'')&&
    input.inputSha256===job.source.inputSha256&&input.descriptionSha256===job.source.descriptionSha256&&
    input.sourceImage.sha256===job.source.normalizedSha256,'精修素材与原图、原话或规范化缓存不符');
  const stage=await savedStage('artwork',{taskId:job.id,candidateId:job.candidateId,revision:job.revision,
    parentRevision:job.parentRevision??null,inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256},ctx,expected);
  requireProof(stage?.status==='completed'&&input.brief?.intent&&isDeepStrictEqual(stage.brief?.intent,input.brief.intent)&&
    [stage.artworkManifestPath,stage.layoutPath].every(rel=>rel&&stage.artifacts.some(a=>a.path===rel)),
    '精修素材阶段缺少原需求或已登记的素材清单');
  return stage;
}

const run=promisify(execFile);
export async function equalReviewedMedia(left,right){
  if((await digest(left)).sha256===(await digest(right)).sha256)return true;
  if(!/\.(?:mp4|gif)$/i.test(left)||path.extname(left)!==path.extname(right))return false;
  // Check each decoded pixel, frame timing and dimensions, ignoring only container metadata.
  const hash=async file=>(await run(ffmpeg,['-v','error','-nostdin','-i',file,'-map','0:v:0','-fps_mode','passthrough',
    '-f','framehash','-hash','sha256','pipe:1'],{timeout:60000,maxBuffer:1024*1024})).stdout;
  const [a,b]=await Promise.all([hash(left),hash(right)]);
  return a===b&&/^0,/m.test(a);
}

export async function reuseReplayReview(job,stage) {
  const cache=job.cachedReplay,code=stageCode[stage];
  const target={...job,stage,status:'blocked',error:{code}};
  const parent={...target,output:cache.parentOutput,revision:cache.parentRevision,parentRevision:cache.parentParentRevision};
  const [current,previous]=await Promise.all([reviewDescriptor(target,{checkAll:true}),read(parent.output,stage+'/stage.json')]);
  requireProof(describes(previous,parent)&&previous.status==='completed','未找到父版已完成的制作审查');
  const reviewPath=stage==='artwork'?previous.visualReview?.path:stage==='rigging'?previous.rigReviews?.at(-1)?.path:
    previous.checks?.findLast(c=>c.name==='dynamics.visual')?.reviewPath;
  const record=previous.artifacts.find(a=>a.path===reviewPath);
  requireProof(record&&(await artifact(parent.output,reviewPath)).sha256===record.sha256,'父版审查记录未登记或已改变');
  const review=await read(parent.output,reviewPath);
  requireProof(review.observations?.length===current.criteria.length&&current.criteria.every(c=>
    review.observations.filter(o=>o.criterion===c&&o.status==='passed').length===1),'父版未通过本版全部检查项');
  const files=new Map(previous.artifacts.map(a=>[a.path,a]));
  const old=async rel=>{
    const file=await regular(parent.output,rel);
    requireProof(files.get(rel)?.sha256===(await digest(file)).sha256,'父版审查画面已改变：'+rel);return file;
  };
  if(stage==='artwork'){
    requireProof(describes(review,parent)&&review.status==='passed'&&isDeepStrictEqual(review.evidence.map(e=>e.path).sort(),[...current.stills].sort()),
      '父版静态审查画面范围不符');
    for(const evidence of review.evidence)requireProof(files.get(evidence.path)?.sha256===evidence.sha256,'父版静态审查哈希不符');
    // Check the entire material set as well as the actual reviewed pages.
    const oldParts=previous.artifacts.filter(a=>a.path.endsWith('.png')).map(a=>a.path).sort();
    const parts=current.bundle.artifacts.filter(a=>a.path.endsWith('.png')).map(a=>a.path).sort();
    requireProof(isDeepStrictEqual(oldParts,parts),'拆层部件发生变化');
    for(const rel of parts)requireProof(await equalReviewedMedia(await old(rel),await current.checked(rel)),'拆层画面发生变化：'+rel);
    const layout=await current.checked(current.bundle.layoutPath);
    requireProof(await equalReviewedMedia(await old(previous.layoutPath),layout),'拆层坐标或层序发生变化');
  }else{
    const d=await reviewDescriptor(parent);
    requireProof(review.watchedContinuously===true&&d.count===current.count&&d.duration===current.duration&&
      isDeepStrictEqual(d.criteria,current.criteria)&&isDeepStrictEqual(d.stills,current.stills),'父版连续播放范围不符');
    if(stage==='rigging')requireProof(isDeepStrictEqual(review.candidate,d.binding.candidate)&&isDeepStrictEqual(review.evidence,d.binding.evidence),'父版绑定审查身份不符');
    else for(const key of ['videoSha256','projectSha256','modelSha256'])requireProof(review[key]===d.binding[key],'父版动态审查身份不符');
    for(let i=0;i<d.stills.length;i++)requireProof(await equalReviewedMedia(await old(d.stills[i]),await current.checked(current.stills[i])),'绑定姿态发生变化：'+current.stills[i]);
    requireProof(await equalReviewedMedia(await old(d.video),await current.checked(current.video)),'连续动作像素或时序发生变化：'+current.video);
  }
  const submission={...current.binding,id:'cached-parent-r'+parent.revision,reviewer:{kind:'model',name:'复用父版同像素视觉观察'},
    reusedObservation:{parentRevision:parent.revision,reviewPath,reviewSha256:record.sha256},
    observations:review.observations.map(o=>({...o,note:'同像素复用 r'+parent.revision+' 观察：'+o.note})),
    ...(stage!=='artwork'?{watchedContinuously:true,range:[0,current.duration],observationMedium:'pixel_identical_parent_continuous_video'}:{})};
  return {artwork:recordArtworkReview,rigging:recordRigReview,dynamics:recordDynamicsReview}[stage](current.bundle,submission,current.ctx);
}

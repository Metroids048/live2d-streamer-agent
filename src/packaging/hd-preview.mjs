import * as fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual as equal} from 'node:util';
import {artifact,digest,json,regular,reject,writeJson} from './files.mjs';
import {inspectModel} from './model.mjs';
import {inspectDynamicsExport} from '../dynamics/export-check.mjs';
import {ffmpeg} from '../preview.mjs';
import {buildBroadcastPlayback} from '../dynamics/broadcast-preview.mjs';
import {finalPreviewReviewGate} from './final-preview-review.mjs';

const exec=promisify(execFile),keys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
const directory='packaging-hd-preview',render=directory+'/render',requestPath=directory+'/input-request.json';
const provenancePath=render+'/render-provenance.json';
const captureManifestPath='dynamics/preview/dynamics-manifest.json';
const media=[['videoPath','preview-1080p30.mp4','hd-preview-video'],['coverPath','pose-0000.png','hd-preview-cover'],
  ['fullBodyPath','full-body.png','hd-preview-full-body'],['facePath','face.png','hd-preview-face']];
const requireThat=(condition,message)=>{if(!condition)reject('HD_PREVIEW_INVALID',message);};
const sameHash=(a,b)=>a?.sha256===b?.sha256&&a?.bytes===b?.bytes;

function trajectoryClock(plan,outputs) {
  requireThat(plan?.fps===30&&Number.isFinite(plan.duration)&&plan.duration>0&&plan.duration<=120&&
    plan.frameCount===Math.ceil(plan.duration*30)+1&&plan.frames?.length===plan.frameCount&&
    plan.clip?.fps===30&&plan.clip.duration===plan.duration&&plan.clip.curves?.length,'登记轨迹时钟或 motion_sample 缺失');
  const phases=plan.phases?.map(p=>p.id),curves=plan.clip.curves;
  requireThat(phases?.length&&new Set(phases).size===phases.length&&
    equal([...new Set(plan.frames.map(f=>f.phase))],phases),'轨迹阶段缺失或顺序不完整');
  requireThat(new Set(curves.map(c=>c.parameter)).size===curves.length&&curves.every(c=>
    typeof c.parameter==='string'&&!outputs.includes(c.parameter)&&c.keys?.length===plan.frameCount),
    '轨迹重复参数或覆盖真实 physics 输出');
  const phaseFrames=[];
  plan.frames.forEach((frame,i)=>{
    requireThat(Number.isFinite(frame.time)&&Math.abs(frame.time-Math.min(plan.duration,i/30))<1e-6&&
      curves.every(c=>Number.isFinite(c.keys[i]?.value)&&Math.abs(c.keys[i].time-frame.time)<1e-6),'轨迹逐帧键或时间不符');
    if(i===0||frame.phase!==plan.frames[i-1].phase)phaseFrames.push({phase:frame.phase,first:i,last:i});
    else phaseFrames.at(-1).last=i;
  });
  return {phases,phaseFrames};
}

async function decodeVideo(file,frameCount,signal) {
  const result=await exec(ffmpeg,['-hide_banner','-nostdin','-v','info','-xerror','-i',file,'-map','0:v:0',
    '-fps_mode','passthrough','-progress','pipe:1','-nostats','-f','null','-'],{signal,maxBuffer:2*1024*1024});
  const input=result.stderr.split('Output #')[0],streams=input.split('\n').filter(line=>/Stream #.*Video:/.test(line));
  const frames=[...result.stdout.matchAll(/^frame=(\d+)\s*$/gm)],video=streams[0]??'';
  requireThat(streams.length===1&&/Video: h264\b/.test(video)&&/\byuv420p\b/.test(video)&&/\b1920x1080\b/.test(video)&&
    /\b30 fps\b/.test(video)&&Number(frames.at(-1)?.[1])===frameCount&&/progress=end/.test(result.stdout),
    'HD 视频必须为 H.264/yuv420p 1920×1080/30fps，并完整解码全部登记帧');
}

/** Render an isolated Dynamics export for packaging or pending visual review.
 * Paths returned below are relative to taskRoot. The renderer plays back parameters.
 */
export async function buildHdPreview({root,taskRoot,dynamics,manifest,signal,prepareReview=false}) {
  root=await fs.realpath(root);taskRoot=await fs.realpath(taskRoot);signal?.throwIfAborted();
  const completed=dynamics?.status==='completed'&&!dynamics.unresolved?.length;
  const capturedForReview=prepareReview&&dynamics?.status==='blocked'&&dynamics.unresolved?.length===1&&
    dynamics.unresolved[0].code==='DYNAMICS_VISUAL_NOT_RUN'&&dynamics.dynamicsManifestPath===captureManifestPath&&
    !dynamics.checks?.some(c=>['automated','visual','human'].includes(c.layer)&&['failed','blocked'].includes(c.status));
  requireThat(dynamics?.schemaVersion===1&&dynamics.stage==='dynamics'&&(completed||capturedForReview)&&
    dynamics.engineVersion==='3.6.7'&&!dynamics.pending&&
    dynamics.previewCapture?.status==='captured'&&dynamics.checks?.some(c=>c.name==='dynamics.export-and-reopen'&&c.status==='passed'),
    'HD 预览只接受已完成、真实导出重开的 Dynamics 候选');
  requireThat(keys.every(k=>Object.hasOwn(dynamics,k)&&dynamics[k]!==undefined)&&
    keys.every(k=>manifest?.[k]===dynamics[k]),'HD 预览六项来源身份不符');
  requireThat(equal(await json(taskRoot,'dynamics/stage.json'),dynamics),'Dynamics 阶段已变化，请读取同版候选');
  const registered=new Map();
  for(const a of dynamics.artifacts??[]) {
    requireThat(!registered.has(a.path),'Dynamics 产物登记重复');registered.set(a.path,a);
  }
  const checked=new Map();
  const source=async relative=>{
    const actual=await artifact(taskRoot,relative,'hd-preview-source'),expected=registered.get(relative);
    requireThat(expected&&sameHash(actual,expected),'HD 预览来源未登记或已变化：'+relative);
    for(const k of keys)requireThat(expected[k]===undefined||expected[k]===dynamics[k],'来源显式身份不符：'+relative);
    checked.set(relative,actual);return actual;
  };
  const currentManifest=await source(dynamics.dynamicsManifestPath);
  requireThat(equal(await json(taskRoot,dynamics.dynamicsManifestPath),manifest)&&manifest.stage==='dynamics'&&
    manifest.status===dynamics.status&&manifest.exportStatus==='exported'&&manifest.modelPath===dynamics.modelPath&&
    manifest.preview?.kind==='parameter-animation','动态清单必须是已登记的同版完成清单');
  let renderManifestPath=dynamics.dynamicsManifestPath;
  if(completed&&renderManifestPath!==captureManifestPath) {
    let previousRequest;
    try {
      await fs.lstat(path.join(taskRoot,requestPath));
      previousRequest=await json(taskRoot,requestPath);
    } catch(error) {
      if(error.code!=='ENOENT')reject('EXTERNAL_RESULT_UNKNOWN','已有 HD 请求无法校验：'+error.message);
    }
    if(previousRequest?.dynamicsManifestPath===captureManifestPath) {
      await source(captureManifestPath);
      const capture=await json(taskRoot,captureManifestPath);
      requireThat(keys.every(k=>capture[k]===manifest[k])&&capture.stage===manifest.stage&&
        capture.exportStatus===manifest.exportStatus&&capture.modelPath===manifest.modelPath&&
        equal(capture.preview,manifest.preview),'动态审查后的候选与原采集来源不一致');
      // Review appends an immutable manifest without altering the captured render inputs.
      checked.delete(renderManifestPath);
      renderManifestPath=captureManifestPath;
    }
  }
  const artworkPath=dynamics.artworkManifestPath;
  await source(artworkPath);const artwork=await json(taskRoot,artworkPath);
  requireThat(keys.every(k=>artwork[k]===dynamics[k]),'Artwork 六项身份不符');
  await source('dynamics/recipe.json');const recipe=await json(taskRoot,'dynamics/recipe.json');
  requireThat(recipe.physics?.length>0,'HD 预览需要模型中实际配置的 physics');
  const model=await inspectModel(taskRoot,dynamics.modelPath);
  for(const file of model.files)await source(file);
  const exported=await inspectDynamicsExport(taskRoot,dynamics.modelPath,recipe);
  const outputs=recipe.physics.flatMap(g=>g.outputs.map(o=>o.parameter));
  const trajectoryPath=manifest.preview.trajectoryPath;await source(trajectoryPath);
  const plan=await json(taskRoot,trajectoryPath);
  const diagnosticClock=trajectoryClock(plan,outputs);
  const hasArticulatedGreeting=recipe.motions.some(m=>m.id==='dyn_wave'&&m.curves.some(c=>c.parameter==='ParamGreetingWrist'));
  const follow=hasArticulatedGreeting?['X','Y','Z'].map(axis=>recipe.parameters?.find(p=>p.semantic==='body.angle'+axis)):[];
  const broadcast=recipe.motions.every(m=>m.id==='dyn_idle'||m.id==='dyn_wave'||m.id.startsWith('dyn_preset_'))&&
    !Object.keys(recipe.appearanceGroups??{}).length;
  const presentation=hasArticulatedGreeting&&follow.every(p=>p?.motionEvidence?.length&&
    p.authoredRange?.[0]<=-6&&p.authoredRange?.[1]>=6&&plan.clip.curves.some(c=>c.parameter===p.id))?
    {profile:broadcast?'studio-live-style-v2':'articulated-greeting-v1',body:follow.map(p=>p.id)}:null;
  const playback=presentation?.profile==='studio-live-style-v2'?buildBroadcastPlayback(plan.frames.map(({time,phase},i)=>({time,phase,
    values:Object.fromEntries(plan.clip.curves.map(c=>[c.parameter,c.keys[i].value]))})),30,presentation.body,outputs):null;
  const phaseFrames=[];
  for(const [i,frame] of (playback??[]).entries()){
    if(frame.phase!==phaseFrames.at(-1)?.phase)phaseFrames.push({phase:frame.phase,first:i,last:i});
    else phaseFrames.at(-1).last=i;
  }
  const clock=playback?{phases:phaseFrames.map(f=>f.phase),phaseFrames}:diagnosticClock;
  const frameCount=playback?.length??plan.frameCount,duration=playback?.at(-1).time??plan.duration;
  const profileScript=playback?await artifact(root,'src/dynamics/broadcast-preview.mjs','hd-preview-profile'):null;
  const rendererScript=await artifact(root,'scripts/hachi-g1-preview.mjs','hd-preview-renderer');
  const request={schemaVersion:1,...Object.fromEntries(keys.map(k=>[k,dynamics[k]])),kind:'parameter_playback',
    width:1920,height:1080,fps:30,frameCount,...clock,modelPath:dynamics.modelPath,
    artworkManifestPath:artworkPath,dynamicsManifestPath:renderManifestPath,trajectoryPath,
    physics:{path:exported.physicsPath,groups:recipe.physics.map(g=>g.id),outputs},
    ...(presentation?{presentation}:{}),...(profileScript?{profileScript}:{}),
    modelFiles:model.files.map(p=>checked.get(p)),sources:[...checked.values()].sort((a,b)=>a.path.localeCompare(b.path)),
    rendererScript};
  let reused=false;
  try {await fs.mkdir(path.join(taskRoot,directory));}
  catch(e) {
    if(e.code!=='EEXIST')throw e;
    try {
      requireThat(await fs.realpath(path.join(taskRoot,directory))===path.join(taskRoot,directory),'HD 目录不得为软链接');
      requireThat(equal(await json(taskRoot,requestPath),request),'已有 HD 预览属于不同来源或渲染版本');
      await regular(taskRoot,provenancePath);reused=true;
    } catch(error) {reject('EXTERNAL_RESULT_UNKNOWN','已有 HD 目录缺少完整同源结果；保留原目录，不覆盖或重跑：'+error.message);}
  }
  if(!reused) {
    await writeJson(path.join(taskRoot,requestPath),request);
    await exec(process.execPath,[path.join(root,rendererScript.path),'--model',path.join(taskRoot,dynamics.modelPath),
      '--artwork',path.join(taskRoot,artworkPath),'--trajectory',path.join(taskRoot,trajectoryPath),
      '--task-root',taskRoot,'--request',path.join(taskRoot,requestPath),'--output',path.join(taskRoot,render)],
    {signal,maxBuffer:4*1024*1024});
  }
  const provenance=await json(taskRoot,provenancePath),requestHash=await digest(await regular(taskRoot,requestPath));
  requireThat(provenance.schemaVersion===2&&keys.every(k=>provenance[k]===dynamics[k])&&
    provenance.kind==='parameter_playback'&&sameHash(provenance.request,requestHash)&&equal(provenance.sourceRequest,request)&&
    provenance.entry===path.join(taskRoot,dynamics.modelPath)&&sameHash(provenance.trajectory,checked.get(trajectoryPath))&&
    sameHash(provenance.artworkManifest,checked.get(artworkPath)),'HD 渲染来源记录缺失或身份不符');
  requireThat(equal(provenance.modelFiles,model.files.map(file=>({file:path.posix.relative(model.directory,file),
    sha256:checked.get(file).sha256,bytes:checked.get(file).bytes})))&&
    provenance.renderer==='VTubeLeaf 1.3.1 installed Cubism WebGL core'&&
    Object.values(provenance.engineAssets??{}).length>0&&Object.values(provenance.engineAssets).every(h=>/^[a-f0-9]{64}$/.test(h)),
    'HD 渲染必须绑定全部实际模型资源和安装的 Leaf Core');
  const physics=provenance.physics;
  if(presentation)requireThat(equal(provenance.presentation,presentation)&&
    provenance.bodyFraming?.topOffset < -100,'成片未应用登记的抬手构图与肩身联动');
  requireThat(physics?.observedFrames===frameCount&&Number.isInteger(physics.nativeEvaluations)&&physics.nativeEvaluations>=frameCount&&
    Math.abs(physics.stepMs-1000/30)<1e-6&&physics.parameterOverrides===false&&
    equal(physics.groups,request.physics.groups)&&equal(physics.outputs?.map(o=>o.parameter),outputs)&&
    physics.outputs.every(o=>o.samples===frameCount&&Number.isFinite(o.min)&&Number.isFinite(o.max)&&o.min<=o.max),
    'HD 渲染缺少全部帧的实际 physics 读回或覆盖了物理输出');
  if(recipe.recipeVersion==='dynamics-1.2') {
    const segmented=new Set(recipe.physics.filter(g=>g.outputs.length>1).flatMap(g=>g.outputs.map(o=>o.parameter)));
    const inert=physics.outputs.filter(o=>segmented.has(o.parameter)&&o.max-o.min<.005);
    requireThat(!inert.length,'分段物理在连续画面中未被实际驱动：'+inert.map(o=>o.parameter).join('、'));
  }
  requireThat(provenance.width===1920&&provenance.height===1080&&provenance.fps===30&&provenance.frameCount===frameCount&&
    Math.abs(provenance.encodedDuration-frameCount/30)<1e-6&&provenance.seconds===duration&&
    equal(provenance.phases,clock.phases)&&equal(provenance.phaseFrames,clock.phaseFrames)&&
    provenance.nativeTracking==='not_run'&&provenance.desktopModelChanged===false&&
    provenance.visualAcceptance==='pending'&&provenance.userAcceptance==='pending','HD 阶段、完整帧或非真人范围记录不符');
  const artifacts=[],paths={};
  for(const [key,file,role] of media) {
    const relative=render+'/'+file,actual=await artifact(taskRoot,relative,role);
    const recorded=key==='videoPath'?provenance.video:provenance.stills?.find(s=>s.file===file);
    requireThat(recorded?.file===file&&sameHash(actual,recorded),'HD 输出已变化或缺少来源哈希：'+file);
    if(key!=='videoPath') {
      const handle=await fs.open(await regular(taskRoot,relative),'r');
      try {
        const head=Buffer.alloc(24);await handle.read(head,0,24,0);
        const [width,height]=key==='fullBodyPath'?[2160,3840]:key==='facePath'?[1080,1080]:[1920,1080];
        requireThat(head.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&
          head.toString('ascii',12,16)==='IHDR'&&head.readUInt32BE(16)===width&&head.readUInt32BE(20)===height,'HD 静帧格式或尺寸不符');
      }
      finally {await handle.close();}
      await exec(ffmpeg,['-hide_banner','-nostdin','-v','error','-xerror','-i',path.join(taskRoot,relative),
        '-frames:v','1','-f','null','-'],{signal,maxBuffer:1024*1024});
    }
    artifacts.push(actual);paths[key]=relative;
  }
  await decodeVideo(path.join(taskRoot,paths.videoPath),frameCount,signal);
  // Detect source changes during a long render before exposing any deliverable.
  for(const a of request.sources)requireThat(sameHash(await digest(await regular(taskRoot,a.path)),a),'HD 渲染期间来源改变：'+a.path);
  requireThat(sameHash(await digest(await regular(root,rendererScript.path)),rendererScript)&&
    (!profileScript||sameHash(await digest(await regular(root,profileScript.path)),profileScript))&&
    (renderManifestPath===currentManifest.path||sameHash(await digest(await regular(taskRoot,currentManifest.path)),currentManifest))&&
    equal(await json(taskRoot,'dynamics/stage.json'),dynamics),'HD 渲染期间脚本或 Dynamics 阶段改变');
  artifacts.push(await artifact(taskRoot,provenancePath,'hd-preview-provenance'));
  return {schemaVersion:1,...Object.fromEntries(keys.map(k=>[k,dynamics[k]])),kind:'parameter_playback',nativeTracking:'not_run',
    width:1920,height:1080,fps:30,frameCount,phases:clock.phases,...paths,provenancePath,
    sourceRequestPath:requestPath,artifacts,reused};
}

export async function prepareFinalPreviewReview({root,taskRoot,signal}) {
  const dynamics=await json(taskRoot,'dynamics/stage.json');
  const manifest=await json(taskRoot,dynamics.dynamicsManifestPath);
  const hd=await buildHdPreview({root,taskRoot,dynamics,manifest,signal,prepareReview:true});
  return finalPreviewReviewGate(taskRoot,dynamics,hd);
}

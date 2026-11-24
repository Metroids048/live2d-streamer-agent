import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ffmpeg} from '../preview.mjs';
import {safePath,sha256} from '../artwork/files.mjs';
import {decodePng} from '../artwork/png.mjs';
import {recordRigReview} from '../rigging/review.mjs';
import {recordDynamicsReview} from '../dynamics/review.mjs';
import {reviewDescriptor} from './native-review.mjs';
import {createCodexVision} from './codex-vision.mjs';
import {makeSheet} from './anime-artwork-review.mjs';
import {gestureClips} from '../rigging/streamer-presets.mjs';

const exec=promisify(execFile);
const python=path.join(os.homedir(),'Desktop/网页教程录制Agent/.runtime/python/bin/python');
const version='anime-native-video-review-7';
const waveCriterion='additional-motion:dyn_wave';
const observationSchema=criteria=>({type:'object',additionalProperties:false,required:['observations'],properties:{
  observations:{type:'array',items:{type:'object',additionalProperties:false,required:['criterion','status','note'],properties:{
    criterion:{type:'string',enum:criteria},status:{type:'string',enum:['passed','failed']},note:{type:'string'}}}}}});
const prompts={
  'continuous_motion_reset':'Compare initial and final head and face. Watch the eye opening, mouth silhouette and face outline at intermediate timestamps; report their changes and whether they settle to neutral. Flag an abrupt jump, detached parts or final residual offsets. Inspect the chin against the neck and collar at both turns. Fail an exposed gray bar, transparent hole or straight cut where the side lock meets the hair behind it.',
  'gesture_sleeve_return':'Watch the cuff and fingers on the viewer-left against the waist and shoulder. Compare the opening and closing rest with intermediate frames. Identify the visible lift, swings, pause and descent. Check shoulder seam/occlusion, fabric elbow silhouette and visible return. Flag rigid slicing, detachment, sharp creases, or abrupt lift.',
  [waveCriterion]:'Compare the wrist and cuff at the side of the character, from before lift to after release; their position relative to the waist and shoulder shows the lift, swings, pause, descent and rest. State visible evidence with times and check whether the shoulder, elbow and wrist remain connected and visible where expected. Look at palm orientation and whether the fingers visibly curl or fan at different times. Check for changes of speed and a short settling beat before lowering. Fail visible detachment, an abrupt lift, or a rigid wrist and fingers throughout.',
  'same-candidate-appearance':'Check the same drawn person, hair, eyes, clothes and seams remain visually coherent across these frames. Flag exposed holes, foreground ghosting and any substituted appearance.',
  'expression-sequence':'Check two visibly different facial expressions and whether they develop without duplicated eye or mouth shapes.',
  'mouth-eye-head-combination':'Check turning with blink and mouth opening/closing, including closed-mouth residue, iris clipping in a partial blink, and forehead gaps. In both yaw directions, inspect the far eyelid and iris for an unnaturally tall oval, detached ink, or a fixed forward gaze. Inspect exposed jaw, collar and hair edges for straight bars, visible holes or double contours.',
  'motion-cancel-preserves-expression':'Check if the arm has returned to rest without discarding the current facial expression across the motion and cancellation boundary.',
  'preview-reset-baseline':'Compare the last relaxed pose with the initial neutral. Look for lingering hand, mouth, eye, head or expression state.',
  'physics-slow-fast-reverse-settle':'Compare the ends of the hair and small hanging details against the main head and torso as the character changes direction and stops. Name a visibly delayed movement and its settling. Fail unexplained twitching, oscillation or no visible secondary response.'
};
const presetCriteria=Object.fromEntries(gestureClips.map(m=>[
  'additional-motion:dyn_'+m.id,'Compare the neutral, peak, and settling poses of this clip ('+m.name+'). Track the chin and shoulders relative to the fixed frame and say which moved in which direction and came back. Do not require an unrelated hand gesture. Flag visibly detached hair, shoulder or clothing.'
]));

async function fixedFile(root,relative,bytes) {
  const dest=await safePath(root,relative,{mkdirParents:true});
  try {await fs.writeFile(dest,bytes,{flag:'wx',mode:0o600});}
  catch(e) {if(e.code!=='EEXIST'||!(await fs.readFile(dest)).equals(Buffer.from(bytes)))throw e;}
  return dest;
}

function window(id,from,to,criteria) {
  if(!(from>=0&&to>from))throw Error('缺少有效的同版审查时间范围');
  return {id,from,to,criteria,overview:true,question:[
    'Compare the timestamped overview tiles first, then inspect the supplied ordered video frames for the actual transitions. A tile label is a timestamp, not a claim about the pose. Evaluate only visible evidence, no assumptions about animation intent.',
    ...criteria.map(k=>k+': '+(prompts[k]??presetCriteria[k])),
    criteria.length===1?
      'Return only {"status":"passed","note":"what visibly changed and when"}. Use "failed" if the evidence is uncertain, obscured or shows a defect. Do not add keys.':
      'Return only a JSON object with an observations array; exactly one row per listed ID. Copy each ID exactly. Each row has criterion, status (passed or failed), and a concrete note describing visible changes with times. Use failed if the evidence is uncertain or obscured.'
  ].join('\n')};
}

function validate(answer,criteria) {
  const obs=answer?.observations;
  if(!Array.isArray(obs)||obs.length!==criteria.length||new Set(obs.map(o=>o?.criterion)).size!==criteria.length||
      obs.some(o=>!criteria.includes(o?.criterion)||!['passed','failed'].includes(o.status)||typeof o.note!=='string'||o.note.trim().length<8))
    throw Error('视觉判读未返回所有登记的具体观察');
  return obs;
}

export function parseTemporalObservations(response,criteria) {
  const answer=JSON.parse(response.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));
  if(criteria.length===1&&answer&&Object.keys(answer).sort().join(',')==='note,status')
    return validate({observations:[{...answer,criterion:criteria[0]}]},criteria);
  if(Array.isArray(answer?.observations)) {
    const aliases=new Map(criteria.filter(k=>k.startsWith('additional-motion:dyn_')).flatMap(k=>{
      const id=k.slice('additional-motion:'.length);
      return [[id,k],[id.replace(/^dyn_/,'dynamic_'),k]];
    }));
    answer.observations=answer.observations.map(o=>{
      if(aliases.has(o?.criterion))return {...o,criterion:aliases.get(o.criterion)};
      // Some valid observations are returned as {theExactCriterion: status, note}.
      const names=Object.keys(o??{}).filter(k=>k!=='note');
      return names.length===1&&criteria.includes(names[0])?
        {criterion:names[0],status:o[names[0]],note:o.note}:o;
    });
  }
  return validate(answer,criteria);
}

export function planAnimeDynamicsReview(phases,required,full) {
  const at=id=>phases.find(p=>p.id===id);
  const expr=phases.filter(p=>p.id.startsWith('expression:')),actions=phases.filter(p=>p.id.startsWith('motion:'));
  const wave=at('motion:dyn_wave'),waveRelease=at('cancel:dyn_wave');
  const extra=actions.filter(p=>p!==wave);
  if(expr.length<2||extra.some(p=>!presetCriteria['additional-motion:'+p.id.slice(7)]||!at('cancel:'+p.id.slice(7)))||
    required.some(k=>!prompts[k]&&!presetCriteria[k])||
    phases.some(p=>p.id.startsWith('appearance-'))||required.includes(waveCriterion)!==Boolean(wave)||
    wave&&!waveRelease)throw Error('当前模型视频审查未覆盖本候选的自定义动作或外观');
  const cancel=at('cancel-motion-preserve-expression'),reset=at('restore-baseline'),physics=at('physics-slow-turn');
  if(!cancel||!reset||!physics)throw Error('动态审查缺少取消动作、复位或物理时间段');
  const plan=[
    {...window('face',0,expr[0].from,['same-candidate-appearance','mouth-eye-head-combination']),
      fps:6,crop:'iw*0.66:ih*0.54:iw*0.17:0',size:384},
    {...window('expressions',expr[0].from,expr.at(-1).to,['expression-sequence']),
      fps:2,crop:'iw*0.66:ih*0.38:iw*0.17:0',size:384},
    ...(wave?[{...window('wave',Math.max(0,wave.from-.5),waveRelease.to,[waveCriterion]),
      crop:'iw*0.84:ih*0.70:iw*0.08:0',size:416}]:[]),
    ...extra.map(p=>{const id=p.id.slice(7),criterion='additional-motion:'+id;
      return {...window(id,Math.max(0,p.from-.15),at('cancel:'+id).to,required.includes(criterion)?[criterion]:[]),
        fps:4,crop:'iw*0.66:ih*0.50:iw*0.17:0',size:384};
    }).filter(w=>w.criteria.length),
    window('release',wave?Math.max(0,wave.to-.5):Math.max(0,cancel.from-.5),waveRelease?.to??cancel.to,['motion-cancel-preserves-expression']),
    window('reset',Math.max(0,reset.from-.2),reset.to,['preview-reset-baseline']),
    window('physics',physics.from,full,['physics-slow-fast-reverse-settle'])
  ];
  const observed=plan.flatMap(w=>w.criteria);
  if(observed.length!==required.length||required.some(k=>!observed.includes(k)))
    throw Error('动态审查未完整覆盖本候选要求');
  return {plan,rest:wave?[wave.from+4.93,wave.from+5.18]:null};
}

export async function reviewAnimeRender(bundle,job,root) {
  const rig=bundle.stage==='rigging';
  const d=await reviewDescriptor({...job,status:'blocked',stage:bundle.stage,error:bundle.unresolved[0]});
  const native=await d.checked(d.video);
  const dir=bundle.stage+'/automatic-review/'+sha256(JSON.stringify({stage:d.sha,version}));
  const required=d.criteria;
  const full=d.duration;
  let plan,rest;
  if(rig) {
    if(required.includes('bow_underlay_restore'))throw Error('当前模型视频审查未覆盖蝴蝶结摘戴');
    plan=required.filter(k=>prompts[k]).map(k=>({
      ...window(k,0,full,[k]),fps:4,size:384,
      crop:k==='gesture_sleeve_return'?'iw*0.68:ih*0.69:iw*0.16:0':'iw*0.62:ih*0.53:iw*0.19:0'
    }));
    if(required.includes('gesture_sleeve_return'))rest=[6.93,7.18];
  } else {
    const trajectory=JSON.parse(await fs.readFile(await d.checked('dynamics/preview/trajectory.json'),'utf8'));
    ({plan,rest}=planAnimeDynamicsReview(trajectory.phases,required,full));
  }
  const planFile=await fixedFile(d.root,dir+'/plan.json',JSON.stringify({windows:plan,version,failOnTruncated:true},null,2)+'\n');
  const output=await safePath(d.root,dir+'/temporal.json',{mkdirParents:true});
  const temporal=async()=>{
    const saved=await fs.readFile(output,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
    if(saved?.stages?.at(-1)?.[0]!=='complete') {
      await exec(python,[path.join(root,'scripts/reference-rig/review-minicpm-temporal.py'),native,output,'--plan',planFile,'--fps','6','--size','320'],
        {timeout:900_000,maxBuffer:256*1024});
    }
    const evidence=JSON.parse(await fs.readFile(output,'utf8'));
    if(evidence.sha256!==(rig?d.binding.evidence.find(f=>f.path===d.video).sha256:d.binding.videoSha256)||
      evidence.stages?.at(-1)?.[0]!=='complete'||evidence.windows?.length!==plan.length)
      throw Error('连续判读回执未完成或不是当前视频');
    return evidence.windows.flatMap((w,i)=>{
      if(w.id!==plan[i].id||w.from!==plan[i].from||w.to!==plan[i].to||w.processedFrames!==w.timestamps?.length||
          w.processedFrames<2||w.finishReason==='length')throw Error('视频窗口回执缺帧或响应未完成');
      return parseTemporalObservations(w.response,plan[i].criteria).map(o=>({...o,from:w.from,to:w.to}));
    });
  };
  const poses=async()=>{
    if(!rig)return [];
    const criteria=required.filter(k=>!prompts[k]);
    const files=[...new Set(criteria.flatMap(k=>d.paths[k]))],absolute=await Promise.all(files.map(d.checked));
    const {stdout}=await exec('/usr/bin/python3',['-c',makeSheet,...absolute],{encoding:'buffer',timeout:30000,maxBuffer:20*1024*1024});
    const imageSha=sha256(stdout),{width,height}=decodePng(stdout);
    const file=await fixedFile(d.root,dir+'/rig-poses.png',stdout);
    const answer=await createCodexVision({taskRoot:d.root,scope:'rigging_review'}).describeImage({
      ...d.ctx,operationKey:'rigging-review-'+sha256(JSON.stringify({imageSha,stage:d.sha,version})),description:'',
      image:{path:file,sha256:imageSha,width,height,mimeType:'image/png'},outputSchema:observationSchema(criteria),
      instructions:'Judge these real before/after pose images of a single character. After must retain identity and coherent hairline, half/closed eyelids and clean mouth cavity/closure during combined head directions. Before is a comparison, not the deliverable. Fail unclear criteria. Give concrete visible details in Chinese. Required tiles (1-based): '+JSON.stringify(Object.fromEntries(criteria.map(k=>[k,d.paths[k].map(f=>files.indexOf(f)+1)])))
    });
    return validate(answer,criteria).map(o=>({...o,from:0,to:full}));
  };
  const flash=async()=>{
    if(!rest)return null;
    const {stdout}=await exec(python,[path.join(root,'scripts/reference-rig/check-wave-frames.py'),native,
      '--ffmpeg',ffmpeg,'--start',String(rest[0]),'--end',String(rest[1]),'--region','0','240','556','144'],
      {timeout:90000,maxBuffer:1024*1024});
    const receipt=JSON.parse(stdout);
    await fixedFile(d.root,dir+'/wave-rest-frames.json',stdout);
    return receipt;
  };
  const results=await Promise.allSettled([temporal(),poses(),flash()]);
  const error=results.find(r=>r.status==='rejected');
  if(error)throw error.reason;
  const [motion,still,wave]=results.map(r=>r.value);
  const observations=[...motion,...still];
  if(wave&&!wave.passed) {
    const o=observations.find(o=>o.criterion===(rig?'gesture_sleeve_return':waveCriterion));
    Object.assign(o,{status:'failed',from:rest[0],to:rest[1],note:'回位静止区间逐原始帧检出异常变化：'+wave.unexpectedExcursions.map(p=>p.seconds).join('、')+' 秒。'});
  }
  if(rig)for(const o of observations)o.evidencePaths=d.paths[o.criterion];
  const evidenceFiles=['plan.json','temporal.json',...(rig?['rig-poses.png']:[]),...(wave?['wave-rest-frames.json']:[])];
  const automatedEvidence=await Promise.all(evidenceFiles.map(async f=>{
    const file=dir+'/'+f;
    return {path:file,sha256:sha256(await fs.readFile(await safePath(d.root,file)))};
  }));
  const review={...d.binding,id:'anime-native-'+d.sha.slice(0,16),reviewer:{kind:'model',name:'Codex 姿态／MiniCPM 时序观察／挥手逐帧检测'},
    range:[0,full],watchedContinuously:true,observationMedium:'chronological_video_samples',
    temporalSampleFps:6,...(!rig?{temporalWindowFps:Object.fromEntries(plan.map(w=>[w.id,w.fps??6]))}:{}),
    automatedEvidence,observations};
  return (rig?recordRigReview:recordDynamicsReview)(d.bundle,review,d.ctx);
}

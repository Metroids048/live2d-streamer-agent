import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {analyzeVisibleAnimeParts} from './anime-semantic-masks.mjs';
import {obtainWaveArtwork} from './codex-wave.mjs';
import {artifact,readJson,safePath,sha256,writeBound,writeJson} from './files.mjs';
import {loadLocalArtwork,LOCAL_ARTWORK_MANIFEST} from './local-artwork.mjs';

const exec=promisify(execFile);
const script=fileURLToPath(new URL('anime-portrait.py',import.meta.url));
const helper=new URL('anime_eye_regions.py',import.meta.url);
const palmScript=fileURLToPath(new URL('palm-artwork.py',import.meta.url));
const unavailableIncludedImage=new Set([
  'CODEX_WAVE_PAID_FALLBACK_UNVERIFIED',
  'CODEX_WAVE_QUOTA_EXHAUSTED',
  'CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN',
  // Reused vision results can drive local artwork without authorizing another remote operation.
  'CODEX_WAVE_NATIVE_INTAKE_REQUIRED'
]);

export function wantsAnimePortrait(description='') {
  // Opt in only from the user's own text, and never override a local-only request.
  if(/全程在本机|只在本机|仅在本机|不要外发|不授权|不允许.{0,12}(?:Codex|Image\s*2)/iu.test(description))return false;
  return /(?:允许|可以用|可以使用)[^。！？\n]{0,44}\bCodex\b[^。！？\n]{0,24}\bImage\s*2\b/iu.test(description);
}

export async function loadAnimePortrait(root,taskRoot,input,{localOnly=false,cacheOnly=false}={}) {
  if(input.rights?.allowDerivatives!==true)throw Error('此任务未确认图像可修改');
  const identity={taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,
    inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256,normalizedSha256:input.sourceImage.sha256};
  const processorSha256=sha256(Buffer.concat(await Promise.all([new URL(import.meta.url),script,helper,palmScript,
    new URL('facial_materials.py',import.meta.url),new URL('codex-wave.mjs',import.meta.url)].map(file=>fs.readFile(file)))));
  let manifest=await readJson(taskRoot,LOCAL_ARTWORK_MANIFEST);
  if(manifest&&!/^[a-f0-9]{64}$/.test(manifest.animePortrait?.processorSha256??''))
    throw Error('已登记的拆层候选缺少处理器记录');
  if(!manifest) {
    const masks=await analyzeVisibleAnimeParts(root,taskRoot,input,{cacheOnly});
    const maskReceipt=await artifact(taskRoot,masks.receiptPath,'anime_semantic_mask_receipt');
    const source=await safePath(taskRoot,input.sourceImage.path);
    const temp=await fs.mkdtemp(path.join(taskRoot,'anime-portrait-'));
    try {
      let data;
      try {
        const files=await Promise.all(masks.parts.map(async part=>{
          if(!/^[a-z]+$/.test(part.id)||part.path!==`artwork/semantic-masks/${part.id}.png`)throw Error('无效的分割图登记');
          return safePath(taskRoot,part.path);
        }));
        const framing=input.brief?.intent?.framing?.value??'preserve_source';
        const {stdout}=await exec('/usr/bin/python3',[script,source,temp,framing,...files],{timeout:60000,maxBuffer:65536,
          env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
        data=JSON.parse(stdout);
      } catch(e) {
        throw Error('复杂立绘拆层失败：'+(e.stderr?.trim().split('\n').at(-1)??e.code??e.message));
      }
      let palmArtwork;
      if(input.brief?.intent?.actions?.some(a=>a.id==='wave')&&(localOnly||wantsAnimePortrait(input.brief.originalDescription))) {
        const authorization={taskId:input.taskId,candidateId:input.candidateId,revision:input.revision,codexWaveEdit:true,includedOnly:true};
        if(localOnly)palmArtwork={status:'blocked',code:'LOCAL_ONLY'};
        else {
          const deadline=Date.now()+20*60*1000;
          do {
            palmArtwork=await obtainWaveArtwork(input,{taskRoot,authorization,purpose:'palm'});
            if(palmArtwork.status!=='awaiting_external_result'||palmArtwork.code==='EXTERNAL_RESULT_UNKNOWN')break;
            await delay(10000);
          } while(Date.now()<deadline);
        }
        const localFallback=localOnly||palmArtwork.status==='blocked'&&unavailableIncludedImage.has(palmArtwork.code);
        if(palmArtwork.status!=='completed'&&!localFallback)throw Error('掌面补绘保留原作业待恢复：'+palmArtwork.code);
        const generated=localFallback?[]:[await safePath(taskRoot,palmArtwork.file)];
        const dataPath=path.join(temp,'source-parts.json');
        await fs.writeFile(dataPath,JSON.stringify(data));
        const {stdout}=await exec('/usr/bin/python3',[palmScript,temp,dataPath,...generated],
          {timeout:30000,maxBuffer:131072,env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
        data=JSON.parse(stdout);
        if(localFallback)palmArtwork={status:'completed',mode:data.palmRegistration.method==='source_side_profile'?
          'local_original_side_hand':'local_source_cuff_and_relaxed_palm',image2NotSubmitted:palmArtwork.code};
      }
      const sourceCrop={left:0,top:0,...data.canvas};
      let sourcePlacement;
      if(data.palmRegistration?.method==='source_side_profile'&&data.anchors.direction===-1) {
        const {shoulder,wrist}=data.anchors;
        const margin=Math.ceil(Math.hypot(wrist[0]-shoulder[0],wrist[1]-shoulder[1])*.73);
        sourcePlacement={left:margin,top:0};
        data.canvas={...data.canvas,width:data.canvas.width+2*margin};
        const move=([x,y])=>[x+margin,y];
        const moveRig=a=>({...a,shoulder:move(a.shoulder),elbow:move(a.elbow),wrist:move(a.wrist),
          ...(a.fingertips?{fingertips:a.fingertips.map(move)}:{}),direction:1,degrees:[26,88,9],
          approach:data.palmRegistration.splitSleeve?'outward_split':'outward_profile'});
        data.anchors=moveRig(data.anchors);
        for(const p of data.parts) {
          p.rect.left+=margin;
          if(p.rigging?.continuousWave)p.rigging.continuousWave=moveRig(p.rigging.continuousWave);
        }
        if(data.palmRegistration.fingertips)data.palmRegistration.fingertips=data.palmRegistration.fingertips.map(move);
      }
      const parts=[];
      for(const p of data.parts) {
        if(!/^[a-z0-9-]+$/.test(p.id))throw Error('无效的部件名');
        if(p.id==='hair-front')p.tags.push('shared-forehair-join');
        const png=await fs.readFile(path.join(temp,p.id+'.png'));
        await writeBound(taskRoot,'local-artwork/parts/'+p.id+'.png',png);
        parts.push({...p,sha256:sha256(png)});
      }
      const productionProfile={continuousWave:true,noLowerLash:data.noLowerLash,
        basis:'透明正面立绘，按本图语义区域、像素色域和轮廓提取眼口；下睫线仅在存在独立笔触时分离。肩、肘、腕在本图袖管截面和袖口肤色边缘上定位。隐区用同一部件邻域采样，不声称恢复原图不可见细节。'};
      manifest={schemaVersion:1,...identity,canvas:data.canvas,sourceCrop,...(sourcePlacement?{sourcePlacement}:{}),parts,productionProfile,
        animePortrait:{processorSha256,maskReceipt,anchors:data.anchors,eyeRegions:data.regions,collarRepairs:data.collarRepairs,
          browBackprintPixels:data.browBackprintPixels,fringeEdgePixels:data.fringeEdgePixels,
          ...(palmArtwork?{palmArtwork,palmRegistration:data.palmRegistration}:{}),
          sleeveHairUnderpaintPixels:data.sleeveHairUnderpaintPixels}};
      await writeJson(taskRoot,LOCAL_ARTWORK_MANIFEST,manifest);
    } finally {await fs.rm(temp,{recursive:true,force:true});}
  }
  const marker={manifestSha256:sha256(await fs.readFile(await safePath(taskRoot,LOCAL_ARTWORK_MANIFEST)))};
  const backend=await loadLocalArtwork(taskRoot,marker,input);
  return {...backend,modelVersion:'anime-source-pixels-1',recipe:{...backend.recipe,processorSha256:manifest.animePortrait.processorSha256},marker};
}

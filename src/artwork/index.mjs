import { readFile, mkdir, open, link, readdir } from 'node:fs/promises';
import { sha256, safePath, writeBound, writeJson, readJson, artifact } from './files.mjs';
import { materializeFlash } from './materialize.mjs';
import {labelFlashLayers,needsLayerLabels} from './layer-labels.mjs';
import {halfBlinkMaterials} from './blink-contour.mjs';
import {localRepairCriteria} from './local-repair.mjs';
import { obtainWaveArtwork } from './codex-wave.mjs';
import { assertDimensions, decodePng, encodePng, alphaBounds, cropPng, composite } from './png.mjs';
import {continuousWaveAnchors} from '../rigging/wave.mjs';
import {LOCAL_ARTWORK_ID} from './local-artwork.mjs';
export { createSeeThroughBackend } from './see-through.mjs';
export { createQwenLayeredBackend } from './qwen-layered.mjs';
export { createFalLayeredBackend } from './fal-layered.mjs';
export { createRunningHubLayeredBackend } from './runninghub-layered.mjs';

const ID=/^[A-Za-z0-9_.:#-]{1,96}$/;
const CHECK_NAMES=['identity-preservation','occlusion-completion','default-composite'];
const check=(name,status,note,layer='automated',evidence)=>({name,layer,status,...(note?{note}:{}),...(evidence?{evidence}:{} )});
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
export function artworkRecipe(brief={},profile) {
  const actions=(brief.intent?.actions||[]).filter(a=>a.id!=='reset');
  const appearances=brief.intent?.clothingVariants||[];
  const controls=[...actions.flatMap(a=>a.id==='wave'?(profile?.continuousWave?['gesture:wave:continuous']:['gesture:wave:rest','gesture:wave:raised']):[`gesture:${a.id}`]),
    ...appearances.flatMap(a=>a.id==='chest_bow'?['appearance:chest_bow','appearance:chest_bow:underlay']:[`appearance:${a.id}`])];
  return {version:controls.length?'live2d-artwork-1.2':'live2d-artwork-1.1',brief:stable(brief),coordinateSystem:'top-left canvas pixels; back-to-front draw order; character-relative sides',
    required:['face','neck','hair:front','hair:back',...['left','right'].flatMap(side=>['eye:white','eye:iris','eye:lash:upper',...(profile?.noLowerLash?.includes(side)?[]:['eye:lash:lower']),'brow',...(brief.intent?.eyes?.blink?['eye:closed']:[])].map(part=>`${part}:${side}`)),'mouth:open','mouth:line:upper','mouth:line:lower',...(brief.intent?.mouth?.speech?['mouth:closed']:[]),...controls],
    ...(profile?{productionProfile:profile}:{}),
    occlusion:['skin beneath eyes and mouth','skin beneath front hair','complete irises and eyewhites','hair roots','neck behind chin and clothing'],
    note:'Infer hidden pixels consistently; do not claim objective recovery. Teeth/tongue, accessories and gestures follow the brief, not a reference model layer count.'};
}
function matchesMaterial(part,requirement) {
  if(part.reference)return false;
  const tags=requirement.split(':');
  if(!tags.every(tag=>part.tags.includes(tag)))return false;
  if(requirement==='face'&&part.tags.includes('detail'))return false;
  if(requirement==='mouth:open'&&part.tags.includes('line'))return false;
  if(requirement==='appearance:chest_bow'&&part.tags.includes('underlay'))return false;
  const alternate=(tags.includes('mouth')&&tags.includes('line')&&part.tags.includes('open'))||tags.includes('closed')||tags.includes('raised')||tags.includes('open')||tags.includes('underlay');
  return part.visible!==false||alternate&&part.variant&&part.variant.type!=='none';
}
function checkResult(result,source,recipe) {
  assertDimensions(result?.canvas?.width,result?.canvas?.height);if(!Array.isArray(result.parts)||!result.parts.length||result.parts.length>4095)throw new Error('ARTWORK_PARTS_INVALID');
  const ids=new Set(),hashes=new Map(),checks=[],parts=[];let sourcePng,totalPixels=0;
  if(source.mimeType==='image/png')sourcePng=decodePng(source.bytes);
  for(const raw of result.parts){
    if(!ID.test(raw.id)||ids.has(raw.id)||typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>128||/[\u0000-\u001f\u007f]/.test(raw.name))throw new Error('ARTWORK_LAYER_ID_OR_NAME_INVALID');ids.add(raw.id);
    if(!Array.isArray(raw.tags)||raw.tags.some(t=>typeof t!=='string'||t.length>80)||raw.tags.includes('left')&&raw.tags.includes('right'))throw new Error('ARTWORK_TAGS_INVALID');
    if(raw.group&&(!/^[\p{L}\p{N} _-]+(?:\/[\p{L}\p{N} _-]+)*$/u.test(raw.group)||raw.group.length>256))throw new Error('ARTWORK_GROUP_INVALID');
    const rect=raw.rect;if(!rect||!['left','top','width','height'].every(k=>Number.isFinite(rect[k]))||rect.width<=0||rect.height<=0)throw new Error('ARTWORK_RECT_INVALID');
    if(!['segmented','inpainted','generated'].includes(raw.origin))throw new Error('ARTWORK_ORIGIN_INVALID');
    if(raw.opacity!==undefined&&(!Number.isFinite(raw.opacity)||raw.opacity<0||raw.opacity>1))throw new Error('ARTWORK_OPACITY_INVALID');
    if(raw.variant){const v=raw.variant;if(!['none','toggle','switch'].includes(v.type)||v.type!=='none'&&(typeof v.parameter!=='string'||!ID.test(v.parameter))||v.switch_id!==undefined&&(!Number.isInteger(v.switch_id)||v.switch_id<0)||v.type==='none'&&v.parameter||v.type!=='switch'&&(v.switch_id??0)!==0||v.type==='switch'&&v.switch_id===undefined)throw new Error('ARTWORK_VARIANT_INVALID');}
    if(raw.id==='source-reference')throw new Error('ARTWORK_RESERVED_ID');
    const image=decodePng(raw.png);totalPixels+=image.width*image.height;if(totalPixels>64*1024*1024)throw new Error('ARTWORK_TOTAL_PIXELS_LIMIT');if(!image.hasAlpha&&!raw.reference)throw new Error('ARTWORK_ALPHA_REQUIRED');const bounds=alphaBounds(image);
    if(!bounds.opaquePixels){checks.push(check(`part:${raw.id}:nonempty`,'failed','Empty provider layer retained as a reported failure, not used for binding.'));continue;}
    const signature=sha256(Buffer.concat([Buffer.from(`${image.width}x${image.height}:`),image.data]));
    if(!raw.reference){
      const peers=hashes.get(signature)??[];
      const opposite=raw.tags.includes('left')?'right':raw.tags.includes('right')?'left':null;
      const role=tags=>tags.filter(t=>t!=='left'&&t!=='right').sort().join(':');
      const separateEyePair=peers.length===1&&opposite&&recipe.productionProfile&&result.quality?.originalCropMatch===true&&
        (raw.tags.includes('eye')||raw.tags.includes('brow'))&&peers[0].tags.includes(opposite)&&
        role(peers[0].tags)===role(raw.tags)&&
        (peers[0].rect.left+peers[0].rect.width<=rect.left||rect.left+rect.width<=peers[0].rect.left);
      if(peers.length&&!separateEyePair)checks.push(check(`part:${raw.id}:unique-pixels`,'failed','Duplicate pixels across named movable layers.'));
      hashes.set(signature,[...peers,raw]);
    }
    if(!raw.reference&&sourcePng&&image.width===sourcePng.width&&image.height===sourcePng.height&&image.data.equals(sourcePng.data))checks.push(check(`part:${raw.id}:not-source-copy`,'failed','Entire source image cannot be a movable split layer.'));
    const cropped=cropPng(image,bounds),cropRect={left:rect.left+bounds.left*rect.width/image.width,top:rect.top+bounds.top*rect.height/image.height,width:bounds.width*rect.width/image.width,height:bounds.height*rect.height/image.height};
    parts.push({...raw,image:cropped,png:encodePng(cropped),rect:cropRect,bounds,pixelSha256:signature});
  }
  if(!parts.length)checks.push(check('nonempty-artwork','failed','No nonempty layers.'));
  checks.push(check('png-layout-integrity','passed','All retained PNGs decoded, alpha verified, dimensions/IDs/tags/rects checked.'));
  const profile=recipe.productionProfile;
  for(const side of profile?.noLowerLash??[])if(parts.some(p=>matchesMaterial(p,'eye:lash:lower:'+side))||!recipe.brief.intent?.eyes?.blink)
    checks.push(check('eye-style:'+side,'failed','No independent lower lash must match supplied pixels and still support blink.'));
  if(recipe.required.includes('gesture:wave:continuous')) {
    const arm=parts.filter(p=>matchesMaterial(p,'gesture:wave:continuous'));
    try {
      if(arm.length!==1||parts.some(p=>matchesMaterial(p,'gesture:wave:raised')||matchesMaterial(p,'gesture:wave:rest')))
        throw new Error('Expected exactly one continuous sleeve');
      const a=continuousWaveAnchors(arm[0],parts);
      const resting=parts.find(p=>p.tags.includes('palm-rest-variant'));
      const sourceLayers=resting?[arm[0],resting,...parts.filter(p=>p.tags.includes('split-forearm'))]:arm;
      const opaqueAt=([x,y],{rect:r,image:i})=>{
        const px=Math.floor((x-r.left)*i.width/r.width),py=Math.floor((y-r.top)*i.height/r.height);
        return px>=0&&py>=0&&px<i.width&&py<i.height&&i.data[(py*i.width+px)*4+3]>=128;
      };
      if(![a.shoulder,a.elbow,a.wrist].every(p=>sourceLayers.some(layer=>opaqueAt(p,layer))))
        throw new Error('Source anchor does not land on opaque arm pixels');
      checks.push(check('continuous-wave-source-anchors','passed','Shoulder, elbow and wrist land on source sleeve/arm pixels; motion remains unreviewed.'));
    }catch(e){checks.push(check('continuous-wave-source-anchors','failed',e.message));}
  }
  const missing=recipe.required.filter(s=>!parts.some(p=>matchesMaterial(p,s)));checks.push(check('deformation-materials',missing.length?'failed':'passed',missing.length?`Missing: ${missing.join(', ')}`:'Required eyes, mouth, face, neck and hair layers exist; geometry and appearance still need review.'));
  const combined=parts.filter(p=>!p.reference&&recipe.required.filter(s=>matchesMaterial(p,s)).length>1);
  if(combined.length)checks.push(check('independent-deformation-materials','failed',`Multiple independently controlled parts share one pixel layer: ${combined.map(p=>p.id).join(', ')}.`));
  if(parts.filter(p=>!p.reference).length<2)checks.push(check('real-decomposition','failed','Fewer than two independent movable parts.'));
  const observation=result.quality?.layerObservation;
  if(observation)checks.push(check('coarse-layer-identification',observation.confirmed?'passed':'failed',observation.confirmed?'Registered layers and their relative order identified in the same candidate contact sheet.':'The role or order of at least one registered layer remains uncertain.'));
  const mapping=result.quality?.sourceCanvasMapping;
  if(mapping?.method==='source-pixels'&&!mapping.verified)checks.push(check('source-space-registration','failed','One or more provider layers lacked a unique original-canvas placement.'));
  const reviews=result.quality?.checks||[];
  const legacyControl=recipe.required.includes('gesture:wave:raised')||recipe.required.includes('appearance:chest_bow');
  const reviewNames=[...CHECK_NAMES,...(legacyControl||profile&&recipe.brief.intent?.eyes?.blink?['half-blink']:[]),
    ...(legacyControl||profile&&recipe.brief.intent?.mouth?.speech?['open-mouth']:[]),
    ...(profile&&recipe.brief.intent?.mouth?.speech?['closed-mouth']:[]),
    ...(recipe.required.includes('gesture:wave:raised')?['raised-hand']:recipe.required.includes('gesture:wave:continuous')?['continuous-arm-source']:[]),
    ...(recipe.required.includes('appearance:chest_bow')?['removed-chest-bow']:[])];
  for(const name of reviewNames){const r=reviews.find(r=>r.name===name&&r.layer==='visual');checks.push(check(name,r?.status==='passed'&&r.evidence?'passed':r?.status==='failed'?'failed':'not_run',r?.note||'No actual visual evidence provided.','visual',r?.evidence));}
  checks.push(check('psd2live-import','not_run','03 imports the real Layout under its engine lease.','runtime'));
  checks.push(check('user-artwork-acceptance','not_run','No user acceptance inferred from file creation.','user_acceptance'));
  return {parts,checks,missing};
}
function inherited(input,ctx) {
  const identity=['taskId','candidateId','revision'];for(const key of identity)if(!input?.[key]||ctx[key]!==undefined&&input[key]!==ctx[key])throw new Error('ARTWORK_IDENTITY_MISMATCH');
  for(const key of ['inputSha256','descriptionSha256'])if(!/^[a-f0-9]{64}$/.test(input[key]||''))throw new Error('ARTWORK_HASH_INVALID');
  return {...Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256','sourceImage','brief','rights','imageNormalization'].map(k=>[k,input[k]??null])),schemaVersion:1,stage:'artwork',status:'blocked',artifacts:[...(input.artifacts||[])],checks:[...(input.checks||[])],warnings:[...(input.warnings||[])],unresolved:[...(input.unresolved||[])]};
}
async function validateArtifacts(root,artifacts) {for(const a of artifacts){const current=await artifact(root,a.path,a.role);if(current.sha256!==a.sha256||current.bytes!==a.bytes)throw new Error('ARTWORK_ARTIFACT_CHANGED');}}
async function processorFingerprint(anime) {
  const dir=new URL('./',import.meta.url);
  const names=anime?['index.mjs','blink-contour.mjs','png.mjs']:[...(await readdir(dir)).filter(n=>n.endsWith('.py')),'index.mjs','blink-contour.mjs','local-repair.mjs','materialize.mjs','layer-labels.mjs','png.mjs','runninghub-layered.mjs'].sort();
  return sha256(JSON.stringify(await Promise.all(names.map(async n=>[n,sha256(await readFile(new URL(n,dir)))]))));
}
async function preserveFailedAssembly(root,previous) {
  const stage='artwork/stage.json',digest=sha256(await readFile(await safePath(root,stage)));
  const paths=new Set([stage,...previous.artifacts.map(a=>a.path).filter(p=>p.startsWith('artwork/'))]);
  for(const rel of paths) {
    const from=await safePath(root,rel),to=await safePath(root,'artwork/repair-history/'+digest+'/'+rel.slice(8),{mkdirParents:true});
    try{await link(from,to);}catch(e){if(e.code!=='EEXIST'||sha256(await readFile(from))!==sha256(await readFile(to)))throw e;}
  }
  return digest;
}
async function checkpoint(ctx,event){await ctx.checkpoint?.(event);}
export async function buildArtwork(input,ctx) {
  const bundle=inherited(input,ctx);if(!ctx.taskRoot)throw new Error('ARTWORK_TASK_ROOT_REQUIRED');await mkdir(ctx.taskRoot,{recursive:true});await safePath(ctx.taskRoot,'artwork/stage.json',{mkdirParents:true});
  const previous=await readJson(ctx.taskRoot,'artwork/stage.json');
  const finish=async(status,code,note,persist=previous?.status!=='completed')=>{bundle.status=status;if(code)bundle.unresolved.push({code,stage:'artwork',retryable:false,message:note});if(persist)await writeJson(ctx.taskRoot,'artwork/stage.json',bundle);return bundle;};
  if(input.schemaVersion!==1||input.stage!=='intake'||!['artifacts','checks','warnings','unresolved'].every(k=>Array.isArray(input[k])))return finish('blocked','INPUT_INVALID','Expected a contract 1.0 intake InputBundle.');
  if(input.status!=='completed')return finish('blocked','INPUT_NOT_READY','Input stage is not completed.');
  if(input.unresolved.length||input.checks.some(c=>c.status==='failed'||c.status==='blocked'))return finish('blocked','INPUT_QUALITY_UNRESOLVED','Intake still contains failed/blocked checks or unresolved requirements; no image was submitted.');
  if(input.rights?.allowDerivatives!==true)return finish('blocked','RIGHTS_UNRESOLVED','Image modification rights have not been granted.');
  const sourcePath=await safePath(ctx.taskRoot,input.sourceImage?.path),bytes=await readFile(sourcePath),sourceSha256=input.sourceImage.sha256||input.inputSha256;if(sha256(bytes)!==sourceSha256)throw new Error('ARTWORK_SOURCE_HASH_MISMATCH');
  await validateArtifacts(ctx.taskRoot,bundle.artifacts);
  const source={...input.sourceImage,bytes,sha256:sourceSha256};assertDimensions(source.width,source.height);
  if(!['image/png','image/jpeg'].includes(source.mimeType))return finish('blocked','INPUT_INVALID','Only validated PNG/JPEG input is supported.');
  if(source.mimeType==='image/png'){const image=decodePng(bytes);if(image.width!==source.width||image.height!==source.height)throw new Error('ARTWORK_SOURCE_DIMENSIONS_MISMATCH');}
  if(ctx.signal?.aborted)throw ctx.signal.reason||new Error('ARTWORK_CANCELLED');
  const backend=ctx.artworkBackend;if(!backend?.id||!backend.version||!backend.modelVersion||typeof backend.submit!=='function'||typeof backend.query!=='function')return finish('blocked','BACKEND_UNAVAILABLE','No worker-callable artwork backend was injected.');
  const recipe=artworkRecipe(input.brief,backend.id===LOCAL_ARTWORK_ID?backend.productionProfile:undefined),cacheKey=sha256(JSON.stringify(stable({inputSha256:input.inputSha256,sourceSha256,descriptionSha256:input.descriptionSha256,brief:input.brief,rights:input.rights,recipe,backend:{id:backend.id,version:backend.version,modelVersion:backend.modelVersion,recipe:backend.recipe||null}}))),operationKey=sha256(`${input.taskId}:${input.candidateId}:${input.revision}:${cacheKey}`);
  const operationPath=ctx.artworkOperationPath??'artwork/operation.json';
  const old=await readJson(ctx.taskRoot,operationPath);if(old&&old.cacheKey!==cacheKey)return finish('blocked','CANDIDATE_IMMUTABLE','Backend, source or recipe changed; use a new candidate revision/taskRoot.',false);
  const anime=backend.id===LOCAL_ARTWORK_ID&&backend.modelVersion==='anime-source-pixels-1';
  if(backend.id==='runninghub-standard-flash'||anime||backend.id===LOCAL_ARTWORK_ID&&backend.modelVersion==='flat-portrait-1')
    bundle.processorSha256=await processorFingerprint(anime);
  const localCriteria=anime?[]:localRepairCriteria(previous);
  const repair=previous?.status==='blocked'&&previous.artworkManifestPath&&old?.status==='completed'&&
    bundle.processorSha256&&(previous.processorSha256!==bundle.processorSha256||localCriteria.length);
  if(repair){
    if(['taskId','candidateId','revision','inputSha256','descriptionSha256'].some(k=>input[k]!==previous[k]))throw new Error('ARTWORK_IDENTITY_MISMATCH');
    await validateArtifacts(ctx.taskRoot,previous.artifacts);
    bundle.priorAssemblySha256=await preserveFailedAssembly(ctx.taskRoot,previous);
    if(localCriteria.length)bundle.localMaterialRepair={criteria:localCriteria,reviewPath:previous.visualReview.path,providerJobId:old.jobId};
    else if(previous.localMaterialRepair)bundle.localMaterialRepair=previous.localMaterialRepair;
  }
  if(previous?.status==='completed'||!repair&&previous?.status==='blocked'&&(previous.visualReview||previous.unresolved?.some(i=>i.code==='ARTWORK_VISUAL_REVIEW_REQUIRED'||i.code==='ARTWORK_QUALITY_FAILED'&&backend.id===LOCAL_ARTWORK_ID&&old?.status==='completed'||['ARTWORK_QUALITY_FAILED','ARTWORK_LOCAL_REPAIR_UNCHANGED'].includes(i.code)&&bundle.processorSha256&&previous.processorSha256===bundle.processorSha256&&old?.status==='completed'))) {
    if(!old||previous.taskId!==input.taskId||previous.candidateId!==input.candidateId||previous.revision!==input.revision||previous.inputSha256!==input.inputSha256||previous.descriptionSha256!==input.descriptionSha256)throw new Error('ARTWORK_IDENTITY_MISMATCH');
    await validateArtifacts(ctx.taskRoot,previous.artifacts);return previous;
  }
  let operation=old||{schemaVersion:1,operationKey,cacheKey,status:'submitting',backend:{id:backend.id,version:backend.version,modelVersion:backend.modelVersion},inputSha256:input.inputSha256,descriptionSha256:input.descriptionSha256};let response;
  if(old){
    await checkpoint(ctx,{stage:'artwork',operationKey,cacheKey,jobId:old.jobId,status:'recovering'});
    try {response=old.jobId?await backend.query(old.jobId,{signal:ctx.signal}):typeof backend.recover==='function'?await backend.recover({operationKey,signal:ctx.signal}):{status:'blocked',code:'EXTERNAL_RESULT_UNKNOWN'};}catch(e){if(ctx.signal?.aborted)throw e;return finish('awaiting_external_result','EXTERNAL_RESULT_UNKNOWN','Existing backend job could not be queried; it was not resubmitted.');}
  }else{
    let fd;try{fd=await open(await safePath(ctx.taskRoot,operationPath),'wx',0o600);await fd.writeFile(JSON.stringify(operation,null,2)+'\n');}catch(e){if(e.code==='EEXIST')return finish('blocked','ARTWORK_OPERATION_BUSY','Another worker created the operation receipt; resume after it yields.',false);throw e;}finally{await fd?.close();}
    await checkpoint(ctx,{stage:'artwork',operationKey,cacheKey,status:'submitting'});
    try{response=await backend.submit({operationKey,cacheKey,source,inputSha256:input.inputSha256,brief:input.brief,recipe,rights:input.rights,signal:ctx.signal});}catch(e){if(ctx.signal?.aborted)throw e;return finish('awaiting_external_result','EXTERNAL_RESULT_UNKNOWN','Submission response is unknown. Resume query/recover with the existing operationKey.');}
  }
  if(!response||!['running','completed','failed','blocked'].includes(response.status))return finish('awaiting_external_result','EXTERNAL_RESULT_UNKNOWN','Backend returned an unrecognized response; do not resubmit.');
  operation={...operation,status:response.status,...(response.jobId?{jobId:response.jobId}:{}),...(response.code?{code:response.code}:{})};await writeJson(ctx.taskRoot,operationPath,operation);await checkpoint(ctx,{stage:'artwork',operationKey,cacheKey,status:response.status,jobId:response.jobId});
  if(response.status==='running')return finish('awaiting_external_result','ARTWORK_PENDING','Backend accepted the job; pixels are not completed.');
  if(response.code==='EXTERNAL_RESULT_UNKNOWN')return finish('awaiting_external_result','EXTERNAL_RESULT_UNKNOWN',response.note||'Submission receipt is unknown. Recover the original operation; do not resubmit.');
  if(response.status!=='completed')return finish(response.status==='failed'?'failed':'blocked',response.code||'BACKEND_UNAVAILABLE',response.note||'Backend did not produce usable artwork.');
  if(ctx.signal?.aborted)throw ctx.signal.reason||new Error('ARTWORK_CANCELLED');
  let waveIssue;
  if(backend.id==='runninghub-standard-flash') {
    let wave,processed;
    const materialize=(wave,classificationSheet=false)=>materializeFlash(response.result,{sourcePath,brief:input.brief,taskRoot:ctx.taskRoot,signal:ctx.signal,wave,classificationSheet,repairCriteria:bundle.localMaterialRepair?.criteria});
    if(ctx.artworkLabelVision&&needsLayerLabels(response.result.parts)) {
      try{processed=await materialize(undefined,true);}catch(e){if(ctx.signal?.aborted)throw e;return finish('blocked','ARTWORK_PROCESSING_FAILED','Could not register the numbered Flash layers.');}
      const vision=bundle.localMaterialRepair&&ctx.artworkLabelVision?{recoverDescription:ctx.artworkLabelVision.recoverDescription,describeImage:()=>{throw new Error('LOCAL_REPAIR_CACHE_ONLY');}}:ctx.artworkLabelVision;
      const identified=await labelFlashLayers(response.result,processed,{input,taskRoot:ctx.taskRoot,vision,signal:ctx.signal});
      if(identified?.code)return finish(identified.code==='ARTWORK_LABEL_RESULT_UNKNOWN'?'awaiting_external_result':'blocked',identified.code,'同版分层标注未完成，请保留原图集和视觉回执，从同一任务继续。');
      if(identified){response.result=identified.raw;processed=null;bundle.artifacts.push(identified.sheet);}
    }
    if(response.result.parts.some(p=>p.providerLabel==='gesture:wave:raised')) {
      try{processed=await materialize();}catch(e){if(ctx.signal?.aborted)throw e;return finish('blocked','ARTWORK_PROCESSING_FAILED','Could not verify the supplied gesture against its source shoulder.');}
    }
    if(ctx.waveAuthorization?.codexWaveEdit&&recipe.required.includes('gesture:wave:raised')&&
      !processed?.parts.some(p=>matchesMaterial(p,'gesture:wave:raised'))) {
      wave=await obtainWaveArtwork(input,{taskRoot:ctx.taskRoot,authorization:bundle.localMaterialRepair?undefined:ctx.waveAuthorization});
      if(wave.status==='awaiting_external_result')return finish(wave.status,wave.code,'The original image edit remains active or unreconciled. Recover its durable receipt.');
      if(wave.status!=='completed') {
        waveIssue={code:wave.code,message:({
          CODEX_WAVE_QUOTA_EXHAUSTED:'当前 ChatGPT 套餐额度已用完，挥手补绘尚未提交。额度恢复后继续本候选。',
          CODEX_WAVE_PAID_FALLBACK_UNVERIFIED:'无法确认此账号在套餐额度不足时会停止扣费，挥手补绘尚未提交。',
          CODEX_CHATGPT_LOGIN_REQUIRED:'挥手补绘需要本机使用 ChatGPT 登录 Codex。',
          CODEX_WAVE_INCLUDED_QUOTA_UNKNOWN:'尚未取得当前套餐可用额度，未提交挥手补绘。'
        })[wave.code]??'本候选缺少可用挥手补绘，保留本次任务回执。'};
        bundle.warnings.push(waveIssue.message);
      }
    }
    try {response.result=wave?.status==='completed'?await materialize(wave):processed??await materialize();}
    catch(e){if(ctx.signal?.aborted)throw e;return finish('blocked','ARTWORK_PROCESSING_FAILED','Local layer registration could not finish. The original remote result and cached pixels are retained.');}
  }
  let inspected;try{inspected=checkResult(response.result,source,recipe);}catch(e){return finish('blocked','ARTWORK_QUALITY_FAILED',e.message);}
  const {parts,checks,missing}=inspected,result=response.result;bundle.checks.push(...checks);bundle.warnings.push('Generative hidden content is inferred. Structural checks do not prove identity, visual quality, rigging compatibility or user approval.');
  const layers=[],manifestParts=[];
  for(const p of parts){if(ctx.signal?.aborted)throw ctx.signal.reason||new Error('ARTWORK_CANCELLED');const rel=`artwork/parts/${p.id}.png`;await writeBound(ctx.taskRoot,rel,p.png);bundle.artifacts.push(await artifact(ctx.taskRoot,rel,'artwork_part'));
    const layer={id:p.id,name:p.name,image:{path:`parts/${p.id}.png`,width:p.image.width,height:p.image.height},rect:p.rect,tags:p.tags,...(p.group?{group:p.group}:{}),...(p.variant?{variant:p.variant}:{}),...(p.rigging?{rigging:p.rigging}:{}),visible:p.visible!==false,opacity:p.opacity??1,reference:p.reference===true};layers.push(layer);
    manifestParts.push({id:p.id,layoutLayerId:p.id,name:p.name,path:rel,sha256:sha256(p.png),pixelSha256:p.pixelSha256,rect:p.rect,image:{width:p.image.width,height:p.image.height},tags:p.tags,side:p.tags.includes('left')?'left':p.tags.includes('right')?'right':'unspecified',group:p.group||null,origin:p.origin,inferredRegions:p.inferredRegions||[],occlusion:p.occlusion||{status:'not_documented'},parameters:p.parameters||[],landmarks:p.landmarks||null,...(p.rigging?{rigging:p.rigging}:{}),reference:p.reference===true,variant:p.variant||null,trim:{originalAlphaBounds:p.bounds}});
  }
  const referenceExt=source.mimeType==='image/jpeg'?'jpg':'png',referenceRel=`artwork/reference.${referenceExt}`;await writeBound(ctx.taskRoot,referenceRel,bytes);bundle.artifacts.push(await artifact(ctx.taskRoot,referenceRel,'artwork_reference'));
  const scale=Math.min(result.canvas.width/source.width,result.canvas.height/source.height);
  const localCrop=backend.id===LOCAL_ARTWORK_ID&&result.quality?.sourceCanvasMapping?.verified===true?result.quality.sourceCanvasMapping.crop:null;
  const placement=result.quality?.sourceCanvasMapping?.placement;
  const referenceRect=localCrop?{left:(placement?.left??0)-localCrop.left,top:(placement?.top??0)-localCrop.top,width:source.width,height:source.height}
    :{left:(result.canvas.width-source.width*scale)/2,top:(result.canvas.height-source.height*scale)/2,width:source.width*scale,height:source.height*scale};
  layers.unshift({id:'source-reference',name:'Source image (reference only)',image:{path:`reference.${referenceExt}`,width:source.width,height:source.height},rect:referenceRect,reference:true,visible:false});
  const layout={format:'psd2live-layout',version:1,name:`artwork-${input.candidateId}`,canvas:result.canvas,groups:[...new Set(parts.map(p=>p.group).filter(Boolean))].map(path=>({path,visible:true,opacity:1})),layers};
  const compositeParts=parts.filter(p=>!p.reference).map(p=>({image:p.image,rect:p.rect,visible:p.visible,opacity:p.opacity})),image=composite(result.canvas,compositeParts);
  const movableFringe=p=>p.tags.includes('hair')&&!p.tags.includes('root')&&(p.tags.includes('front')||p.tags.includes('fringe'));
  const previews=[['composite',image],['without-front-hair',composite(result.canvas,parts.filter(p=>!p.reference&&!movableFringe(p)).map(p=>({image:p.image,rect:p.rect,visible:p.visible,opacity:p.opacity})))]];
  const materialPreview=(name,visible)=>{
    const layers=parts.filter(p=>!p.reference).map(p=>({image:p.image,rect:p.rect,opacity:p.opacity,visible:visible(p)??(p.visible!==false)}));
    previews.push([name,composite(result.canvas,layers)]);
  };
  if(recipe.productionProfile?.continuousWave) {
    const arm=parts.find(p=>matchesMaterial(p,'gesture:wave:continuous'));
    if(arm)previews.push(['continuous-arm-source',composite(result.canvas,
      parts.filter(p=>p===arm||p.tags.includes('palm-rest-variant')||p.tags.includes('split-forearm')))]);
  }
  if(parts.some(p=>matchesMaterial(p,'gesture:wave:raised')))
    materialPreview('raised-hand',p=>p.tags.includes('wave')?p.tags.includes('raised'):p.tags.includes('waist')&&p.tags.includes('underlay')?true:undefined);
  if(parts.some(p=>matchesMaterial(p,'appearance:chest_bow')))
    materialPreview('removed-chest-bow',p=>p.tags.includes('chest_bow')?p.tags.includes('underlay'):undefined);
  if(parts.some(p=>matchesMaterial(p,'mouth:open')))
    materialPreview('open-mouth',p=>p.tags.includes('mouth')&&p.tags.includes('open')?true:p.tags.includes('mouth')&&p.tags.includes('closed')?false:undefined);
  if(recipe.productionProfile&&parts.some(p=>matchesMaterial(p,'mouth:closed')))
    materialPreview('closed-mouth',p=>p.tags.includes('mouth')&&p.tags.includes('closed')?true:p.tags.includes('mouth')&&p.tags.includes('open')?false:undefined);
  // Preserve the true eyelash, iris and sclera rasters. At the half-close
  // position the upper lashes move down and the aperture clips the hidden iris.
  const apertures=new Map(['left','right'].map(side=>[side,parts.find(p=>matchesMaterial(p,'eye:white:'+side))?.rect]));
  if([...apertures].every(([side,r])=>r&&['eye:iris:','eye:lash:upper:','eye:closed:'].every(tag=>parts.some(p=>matchesMaterial(p,tag+side))))) {
    const half=halfBlinkMaterials(parts.filter(p=>!p.reference),{noLowerLash:recipe.productionProfile?.noLowerLash,portrait:anime});
    previews.push(['half-blink',composite(result.canvas,half)]);
  }
  let comparison=null;
  if(source.mimeType==='image/png'){
    const aligned=composite(result.canvas,[{image:decodePng(bytes),rect:layers[0].rect}]),difference={...result.canvas,data:Buffer.alloc(image.data.length)};let total=0;
    for(let i=0;i<image.data.length;i+=4){let error=0;for(let c=0;c<3;c++){const a=image.data[i+c]*image.data[i+3]/255+255-image.data[i+3],b=aligned.data[i+c]*aligned.data[i+3]/255+255-aligned.data[i+3];error+=Math.abs(a-b);}error/=3;total+=error;difference.data[i]=Math.round(error);difference.data[i+3]=255;}
    previews.push(['source-aligned',aligned],['difference',difference]);comparison={method:localCrop?'verified original pixel crop; RGB difference on white':'nearest-neighbor center-contain; RGB difference on white',meanAbsoluteRgbDifference:total/(image.width*image.height),mappingVerified:Boolean(localCrop),note:'Diagnostic only; this is not an identity score or acceptance.'};
  }
  const face=parts.find(p=>p.tags.includes('face')&&!p.tags.includes('detail'));
  const states=new Map(previews);
  if(face&&['source-aligned','without-front-hair','half-blink','open-mouth'].every(k=>states.has(k))) {
    const r=face.rect, pad=Math.ceil(Math.max(r.width,r.height)*.4);
    const left=Math.max(0,Math.floor(r.left)-pad),top=Math.max(0,Math.floor(r.top)-pad);
    const width=Math.min(image.width,Math.ceil(r.left+r.width)+pad)-left,height=Math.min(image.height,Math.ceil(r.top+r.height)+pad)-top;
    if(width>0&&height>0) {
      const dx=Math.max(1,Math.round(r.width*.05));
      const shift=composite(result.canvas,parts.filter(p=>!p.reference).map(p=>{
        if(!movableFringe(p))return p;
        if(!recipe.productionProfile)return {...p,rect:{...p.rect,left:p.rect.left+dx}};
        const {width,height,data}=p.image, pixels=Buffer.alloc(data.length);
        for(let y=0;y<height;y++){
          const t=Math.min(1,Math.max(0,(y/height-.15)/.65)),off=Math.round(dx*t*t*(3-2*t)*width/p.rect.width);
          if(off<width)data.copy(pixels,(y*width+off)*4,y*width*4,((y+1)*width-off)*4);
        }
        return {...p,image:{...p.image,data:pixels}};
      }));
      const k=Math.min(384/Math.max(width,height),3),w=Math.max(1,Math.round(width*k)),h=Math.max(1,Math.round(height*k));
      const cells=[states.get('source-aligned'),image,states.get('without-front-hair'),states.get('half-blink'),states.get('open-mouth'),shift];
      previews.push(['face-material-comparison',composite({width:w*3,height:h*2},cells.map((im,i)=>({image:cropPng(im,{left,top,width,height}),rect:{left:i%3*w,top:Math.floor(i/3)*h,width:w,height:h}})))]);
    }
  }
  for(const [name,pixels]of previews){const rel=`artwork/${name}.png`;await writeBound(ctx.taskRoot,rel,encodePng(pixels));bundle.artifacts.push(await artifact(ctx.taskRoot,rel,`artwork_${name.replaceAll('-','_')}`));}
  if(face){const r=face.rect,left=Math.max(0,Math.floor(r.left)),top=Math.max(0,Math.floor(r.top)),width=Math.min(image.width-left,Math.ceil(r.width)),height=Math.min(image.height-top,Math.ceil(r.height));if(width>0&&height>0){await writeBound(ctx.taskRoot,'artwork/face-closeup.png',encodePng(cropPng(image,{left,top,width,height})));bundle.artifacts.push(await artifact(ctx.taskRoot,'artwork/face-closeup.png','artwork_face_closeup'));}}
  bundle.layoutPath='artwork/layout.json';bundle.artworkManifestPath='artwork/artwork-manifest.json';await writeJson(ctx.taskRoot,bundle.layoutPath,layout);bundle.artifacts.push(await artifact(ctx.taskRoot,bundle.layoutPath,'artwork_layout'));
  const blocked=checks.some(c=>c.status==='failed'||c.layer==='visual'&&c.status!=='passed');bundle.status=blocked?'blocked':'completed';
  const manifest={schemaVersion:1,...Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,bundle[k]])),sourceSha256,status:bundle.status,backend:operation.backend,operationKey,cacheKey,jobId:operation.jobId||null,recipe,canvas:result.canvas,coordinateSystem:recipe.coordinateSystem,sourceMapping:result.quality?.sourceCanvasMapping?.method==='source-pixels'?result.quality.sourceCanvasMapping:{method:'center-contain-reference-only',verified:false,note:'Do not infer production mapping from this reference placement.'},layoutPath:bundle.layoutPath,parts:manifestParts,missingSemantics:missing,checks,previews:{materialStates:Object.fromEntries(previews.filter(([name])=>['raised-hand','continuous-arm-source','removed-chest-bow','open-mouth','closed-mouth','half-blink'].includes(name)).map(([name])=>[name,`artwork/${name}.png`])),composite:'artwork/composite.png',occlusionDiagnostic:'artwork/without-front-hair.png',...(comparison?{sourceAligned:'artwork/source-aligned.png',difference:'artwork/difference.png',comparison}:{}),note:'Static material diagnostics, not Live2D motion or tracking evidence.'},providerQuality:result.quality||null};
  if(bundle.revision>1&&backend.id===LOCAL_ARTWORK_ID) {
    bundle.artworkFingerprint=sha256(JSON.stringify({layoutSha256:bundle.artifacts.at(-1).sha256,
      parts:manifestParts.map(({id,sha256,rect})=>({id,sha256,rect}))}));
    manifest.artworkFingerprint=bundle.artworkFingerprint;
  }
  await writeJson(ctx.taskRoot,bundle.artworkManifestPath,manifest);bundle.artifacts.push(await artifact(ctx.taskRoot,bundle.artworkManifestPath,'artwork_manifest'));
  await ctx.progress?.({stage:'artwork',status:bundle.status,note:blocked?'Real candidate parts preserved; detailed material or visual review is still blocked.':'Artwork checks completed; engine import and user acceptance remain separate.'});
  const visualOnly=blocked&&manifest.sourceMapping.verified===true&&manifest.sourceSha256===bundle.sourceImage.sha256&&!checks.some(c=>c.status==='failed')&&checks.some(c=>c.layer==='visual'&&c.status==='not_run');
  if(visualOnly&&repair&&bundle.localMaterialRepair) {
    const observed=bundle.localMaterialRepair.criteria.flatMap(c=>c==='half-blink'?['artwork/half-blink.png']:['artwork/without-front-hair.png','artwork/face-material-comparison.png']);
    if(observed.every(p=>previous.artifacts.find(a=>a.path===p)?.sha256===bundle.artifacts.find(a=>a.path===p)?.sha256))
      return finish('blocked','ARTWORK_LOCAL_REPAIR_UNCHANGED','局部返修没有改变该缺陷的观察图，保留原审查，不重复判读或付费生成。');
  }
  if(blocked&&waveIssue)return finish('blocked',waveIssue.code,waveIssue.message);
  return finish(bundle.status,visualOnly?'ARTWORK_VISUAL_REVIEW_REQUIRED':blocked?'ARTWORK_QUALITY_FAILED':null,
    visualOnly?'Same-version material previews are ready for visual review.':blocked?'Required fine parts or quality checks failed. Retain the original pixels for diagnosis.':null);
}

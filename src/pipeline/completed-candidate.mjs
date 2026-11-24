import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify,isDeepStrictEqual} from 'node:util';
import {artifact,digest,json,regular,relativePath} from '../packaging/files.mjs';
import {inspectModel} from '../packaging/model.mjs';
import {verifyPackageArchive} from '../packaging/index.mjs';
import {verifyCoverage,verifyRequestedControls} from '../packaging/controls.mjs';
import {rigCriteriaFor,rigReviewEvidenceGroups} from '../rigging/review.mjs';
import {inspectGif} from '../rigging/geometry.mjs';
import {previewCriteria} from '../dynamics/preview.mjs';
import {ffmpeg} from '../preview.mjs';
import {candidateLineage} from './g1-preview.mjs';
import {singleImageSources} from './delivery.mjs';
import {fail} from '../rpc.mjs';

const exec=promisify(execFile),keys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
const pointerPath='completed-candidate-current.json',cap=64*1024*1024;
const invalid=message=>fail('COMPLETED_CANDIDATE_INVALID',message);
const changed=()=>fail('COMPLETED_CANDIDATE_CHANGED','完成候选的冻结来源已变化，不能刷新哈希掩盖旧修改');
const snapshot=value=>Object.fromEntries(['parents','artifacts','reviews','stages','checks'].map(k=>[k,value[k]]));
function location(job,revision) {
  if(job.kind!=='single_image'||!Number.isSafeInteger(job.revision)||!Number.isSafeInteger(revision)||revision<=job.revision||
    !['inputSha256','descriptionSha256'].every(k=>/^[a-f0-9]{64}$/.test(job.source?.[k]??'')))invalid('需显式选择同一单图任务的派生完成版本');
  const base=`revisions/r${String(revision).padStart(4,'0')}`;
  return {base,relative:base+'/completed-candidate/stage.json'};
}
function sameIdentity(value,expected,fields=keys) {
  if(fields.some(k=>value?.[k]!==expected[k]))fail('COMPLETED_CANDIDATE_IDENTITY_MISMATCH','完成候选、阶段或审查不属于同一任务/输入/版本');
}
async function verify(root,a) {
  if(!/^[a-f0-9]{64}$/.test(a?.sha256??'')||!Number.isSafeInteger(a.bytes)||a.bytes<=0)invalid('缺少真实来源哈希和字节数');
  const actual=await digest(await regular(root,a.path));
  if(actual.sha256!==a.sha256||actual.bytes!==a.bytes)changed();
}
async function absent(root,relative) {
  try {await fs.lstat(path.join(root,relative));fail('COMPLETED_CANDIDATE_BUSY','候选仍有制作或审查锁');}
  catch(e){if(e.code!=='ENOENT')throw e;}
}
// Only fixed engine-journal entries use this bound; ordinary manifests retain 16 MiB.
async function journal(root,relative,expected,nested=false) {
  const file=await regular(root,relative),chunks=[];let bytes=0;
  for await(const chunk of createReadStream(file,{flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,end:cap})) {
    bytes+=chunk.length;if(bytes>cap)invalid('工程检查点超过64 MiB');chunks.push(chunk);
  }
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{invalid('工程检查点JSON无效');}
  sameIdentity(nested?value.identity:value,expected);
  if(value.pending||value.failed||value.failure||value.error||['failed','blocked','running','awaiting_external_result'].includes(value.status))
    invalid('工程检查点仍有失败或未完成操作');
  return value;
}
function required(stage,relative) {
  relativePath(relative);
  const a=stage.artifacts.find(a=>a.path===relative);if(!a||a.bytes<=0)invalid('关键产物未登记：'+relative);return a;
}
function passed(stage,name,layer) {
  if(!stage.checks.some(c=>c.name===name&&c.layer===layer&&c.status==='passed'))invalid('缺少实际通过检查：'+name);
}
async function stage(root,name,expected) {
  const value=await json(root,name+'/stage.json');sameIdentity(value,expected);
  if(value.schemaVersion!==1||value.stage!==name||value.status!=='completed'||value.pending||value.failed||
    !Array.isArray(value.unresolved)||value.unresolved.length||!Array.isArray(value.checks)||!value.checks.length||
    value.checks.some(c=>['failed','blocked','pending','awaiting_external_result'].includes(c.status))||
    !Array.isArray(value.artifacts)||!value.artifacts.length)invalid('同版 '+name+' 尚未完成或仍有未解决事项');
  const seen=new Set();
  for(const a of value.artifacts) {
    relativePath(a.path);const folded=a.path.toLocaleLowerCase('en-US');if(seen.has(folded))invalid('阶段产物路径重复');seen.add(folded);
    for(const k of keys)if(a[k]!==undefined&&a[k]!==expected[k])invalid('产物显式身份不符');
    await verify(root,a);
  }
  return value;
}
async function originalRequirements(job) {
  const input=await json(job.output,'intake/stage.json');
  sameIdentity(input,{taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision??null,...job.source});
  const brief=input.brief;
  if(input.schemaVersion!==1||input.stage!=='intake'||input.status!=='completed'||input.pending||input.failed||
    !Array.isArray(input.artifacts)||!input.artifacts.length||input.unresolved?.length||
    brief?.inputSha256!==job.source.inputSha256||brief.descriptionSha256!==job.source.descriptionSha256||
    typeof brief.originalDescription!=='string'||createHash('sha256').update(brief.originalDescription).digest('hex')!==job.source.descriptionSha256||
    !['expressions','actions','clothingVariants'].every(k=>Array.isArray(brief.intent?.[k])))invalid('缺少与原任务图片、原文绑定的完整接入简报');
  for(const a of input.artifacts)await verify(job.output,a);
  if(!input.artifacts.some(a=>a.role==='private_original_image'&&a.sha256===job.source.inputSha256))invalid('原始图片未绑定接入来源');
  return {brief,artifacts:[await artifact(job.output,'intake/stage.json','completed-original-intake'),...input.artifacts]};
}
function fullScope(value,brief,requireBrief=true) {
  for(const scope of [value.productionScope,value.brief?.productionScope])if(scope&&
    (String(scope.gate).toUpperCase()==='G1'||scope.deferred!==undefined&&(!Array.isArray(scope.deferred)||scope.deferred.length)))
    invalid('G1或仍有生产延期的版本不能登记为完整候选');
  if(requireBrief&&(value.brief?.inputSha256!==brief.inputSha256||value.brief?.descriptionSha256!==brief.descriptionSha256||
    value.brief?.originalDescription!==brief.originalDescription||!isDeepStrictEqual(value.brief?.intent,brief.intent)))
    invalid('派生阶段缩减或更改了原任务的完整要求');
}
function observations(review,criteria,duration) {
  if(!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(review?.id??'')||!['model','human'].includes(review.reviewer?.kind)||
    typeof review.reviewer.name!=='string'||!review.reviewer.name.trim()||!review.recordedAt||review.watchedContinuously!==true||
    !isDeepStrictEqual(review.range,[0,duration])||!Number.isFinite(duration)||duration<=0||!Array.isArray(review.observations)||
    review.observations.length!==criteria.length||new Set(review.observations.map(o=>o.criterion)).size!==criteria.length||
    review.observations.some(o=>!criteria.includes(o.criterion)||o.status!=='passed'||!Number.isFinite(o.from)||!Number.isFinite(o.to)||
      o.from<0||o.to<=o.from||o.to>duration||typeof o.note!=='string'||o.note.trim().length<8))invalid('缺少当前完整连续观察的实际通过记录');
}
async function reviewed(root,current,history,check,expected) {
  const last=history?.at(-1);
  if(!Array.isArray(history)||!last||last.status!=='passed')invalid('最新实际审查尚未通过');
  let previous;
  for(const row of history) {
    if(typeof row.path!=='string'||!row.path.startsWith(current.stage+'/reviews/')||!row.path.endsWith('/review.json'))invalid('审查记录路径无效');
    required(current,row.path);const record=await json(root,row.path);
    sameIdentity(record.candidate,expected,current.stage==='rigging'?keys:keys.slice(0,4));
    if(!isDeepStrictEqual(record.reviewer,row.reviewer)||!['model','human'].includes(record.reviewer?.kind)||
      !Array.isArray(record.observations)||!record.observations.length||
      record.observations.some(o=>!['passed','failed'].includes(o.status))||
      row.status!==(record.observations.some(o=>o.status==='failed')?'failed':'passed'))invalid('审查历史与实际观察结论不符');
    if(previous?.status==='failed'&&(record.supersedesReviewPath!==previous.path||
      typeof record.reassessmentReason!=='string'||record.reassessmentReason.trim().length<12||
      previous.reviewer.kind==='human'&&record.reviewer.kind!=='human'))invalid('旧失败未显式复核或真人否决被模型覆盖');
    previous=row;
  }
  passed(current,check,'visual');
  if(current.checks.find(c=>c.name===check).reviewPath!==last.path)invalid('当前视觉检查没有引用最新审查');
  const a=required(current,last.path),record=await json(root,last.path);
  sameIdentity(record.candidate,expected,current.stage==='rigging'?keys:keys.slice(0,4));
  if(!isDeepStrictEqual(record.reviewer,last.reviewer))invalid('审查来源与阶段记录不符');
  return {record,descriptor:{stage:current.stage,status:last.status,reviewer:record.reviewer,artifact:a}};
}
async function rigReview(root,rig,expected,brief) {
  for(const name of ['rigging_input_integrity','rigging_rest_topology','rigging_save_reopen','rigging_export_integrity'])passed(rig,name,'automated');
  for(const key of ['modelPath','projectPath','psdPath','parameterMapPath'])required(rig,rig[key]);
  const map=await json(root,rig.parameterMapPath);sameIdentity(map,expected);
  const state=await journal(root,'rigging/state.json',expected,true);
  if(!rig.engineProjectId||!rig.engineRevision||map.projectId!==rig.engineProjectId||map.state!==rig.engineRevision||
    state.projectId!==rig.engineProjectId||state.state!==rig.engineRevision)invalid('绑定工程、参数表和检查点不一致');
  const {record,descriptor}=await reviewed(root,rig,rig.rigReviews,'rigging_visual_review',expected);
  if(record.engineProjectId!==rig.engineProjectId||record.engineRevision!==rig.engineRevision)invalid('绑定审查属于旧工程状态');
  const animations=rig.artifacts.filter(a=>a.path.startsWith('rigging/preview/')&&a.path.endsWith('.gif'));
  if(animations.length!==1||record.animation?.path!==animations[0].path||record.animation.sha256!==animations[0].sha256)invalid('审查动画已失效');
  const info=inspectGif(await fs.readFile(await regular(root,animations[0].path)));
  if(info.frames<2||record.animation.durationSeconds!==info.durationSeconds)invalid('审查动画范围与实际帧不符');
  const criteria=rigCriteriaFor(brief),groups=rigReviewEvidenceGroups(map.poseSets,animations[0].path);
  observations(record,criteria,info.durationSeconds);
  const poses=Object.values(map.poseSets??{}).flatMap(group=>Object.values(group));
  const paths=[rig.projectPath,rig.psdPath,rig.modelPath,rig.parameterMapPath,...poses,...poses.map(p=>p.replace(/\.png$/,'.json')),animations[0].path];
  if(!Array.isArray(record.evidence)||record.evidence.length!==paths.length||new Set(record.evidence.map(a=>a.path)).size!==paths.length||
    paths.some(p=>!record.evidence.some(e=>e.path===p&&e.sha256===required(rig,p).sha256)))invalid('绑定审查没有绑定全部当前证据');
  for(const o of record.observations)if(!Array.isArray(o.evidencePaths)||groups[o.criterion].some(p=>!o.evidencePaths.includes(p))||
    o.evidencePaths.some(p=>!paths.includes(p)))invalid('绑定观察缺少必需的姿态/连续证据');
  return descriptor;
}
async function dynamicsReview(root,dynamics,rig,expected,brief) {
  for(const name of ['dynamics.export-and-reopen','dynamics.preview-capture'])passed(dynamics,name,'automated');
  for(const key of ['modelPath','projectPath','psdPath','parameterMapPath','dynamicsManifestPath'])required(dynamics,dynamics[key]);
  const manifest=await json(root,dynamics.dynamicsManifestPath);sameIdentity(manifest,expected);
  if(manifest.exportStatus!=='exported'||manifest.parentProject?.path!==rig.projectPath||
    manifest.parentProject.sha256!==required(rig,rig.projectPath).sha256)invalid('动态阶段没有绑定当前绑定工程');
  const p=manifest.preview;
  if(dynamics.previewCapture?.status!=='captured'||p?.kind!=='parameter-animation'||
    !Array.isArray(p.requiredCriteria)||!previewCriteria.every(c=>p.requiredCriteria.includes(c)))invalid('没有同版完整动态采集');
  const criteria=[...brief.intent.actions.filter(a=>!['idle','breath','reset'].includes(a.id)).map(a=>'additional-motion:dyn_'+a.id),
    ...brief.intent.clothingVariants.map(a=>'appearance-toggle-restore:dyn_appearance_'+a.id)];
  if(!criteria.every(c=>p.requiredCriteria.includes(c)))invalid('动态连续审查未覆盖原要求的独立动作和外观摘戴复位');
  for(const file of [p.videoPath,p.coverPath,p.captureReportPath])required(dynamics,file);
  for(const [key,file] of [['videoSha256',p.videoPath],['modelSha256',dynamics.modelPath],['projectSha256',dynamics.projectPath]])
    if(p[key]!==required(dynamics,file).sha256)invalid('动态审查/预览源哈希已失效');
  await journal(root,'dynamics/engine-journal.json',expected);
  const capture=await journal(root,'dynamics/preview/engine-journal.json',expected);
  const report=await json(root,p.captureReportPath);
  if(capture.status!=='captured'||report.decoded!==true||report.originalCandidateReopened!==true||
    ['frameCount','fps','duration'].some(k=>p[k]!==report[k])||!Number.isSafeInteger(p.frameCount)||p.frameCount<=0||
    !Number.isFinite(p.fps)||p.fps<=0||Math.abs(p.frameCount/p.fps-p.duration)>.001)invalid('采集回执或实际视频范围不符');
  for(const [key,value] of Object.entries({projectPath:dynamics.projectPath,projectSha256:p.projectSha256,modelPath:dynamics.modelPath,modelSha256:p.modelSha256}))
    if(capture.source?.[key]!==value||report[key]!==value)invalid('动态采集回执不属于本版工程和模型');
  const {record,descriptor}=await reviewed(root,dynamics,manifest.reviews,'dynamics.visual',expected);
  observations(record,p.requiredCriteria,p.duration);
  for(const k of ['videoSha256','modelSha256','projectSha256'])if(record[k]!==p[k])invalid('最新动态审查属于旧预览');
  const decoded=await exec(ffmpeg,['-hide_banner','-nostdin','-v','error','-i',await regular(root,p.videoPath),'-map','0:v:0',
    '-fps_mode','passthrough','-progress','pipe:1','-nostats','-f','null','-'],{maxBuffer:1024*1024});
  if(Number([...decoded.stdout.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1])!==p.frameCount)invalid('实际视频帧数与已审查范围不符');
  return {descriptor,preview:p};
}
const sameBytes=(a,b)=>a?.sha256===b?.sha256&&a?.bytes===b?.bytes;
async function verifyPackagedPreview(root,packaging,dynamics,reviewed,preview,content) {
  if(preview?.hdContract===1&&packaging.hdPreviewContract===1) {
    const proofPath=content+'/'+preview.provenancePath;
    required(packaging,proofPath);
    const proof=await json(root,proofPath);
    sameIdentity(proof,dynamics);
    const fromRender=role=>{
      const items=packaging.artifacts.filter(a=>a.role==='hd-preview-'+role);
      if(items.length!==1)invalid('高清预览缺少唯一的登记来源：'+role);
      return items[0];
    };
    const source=fromRender('provenance'),render=await json(root,source.path),request=render.sourceRequest;
    sameIdentity(render,dynamics);sameIdentity(request,dynamics);
    if(!sameBytes(proof.originalProvenance,source)||request.modelPath!==dynamics.modelPath||
      request.dynamicsManifestPath!==dynamics.dynamicsManifestPath||request.trajectoryPath!==reviewed.trajectoryPath||
      !sameBytes(render.trajectory,required(dynamics,reviewed.trajectoryPath))||
      !sameBytes(request.sources?.find(a=>a.path===dynamics.dynamicsManifestPath),required(dynamics,dynamics.dynamicsManifestPath))||
      proof.modelSha256!==reviewed.modelSha256||proof.projectSha256!==reviewed.projectSha256)
      invalid('高清预览没有绑定当前已审查动态轨迹、工程与模型');
    for(const [key,role] of [['videoPath','video'],['coverPath','cover'],['fullBodyPath','full-body'],['facePath','face']])
      if(!sameBytes(fromRender(role),required(packaging,content+'/'+preview[key])))invalid('高清预览与登记渲染文件不符');
    return;
  }
  if(preview?.hdContract!==undefined||packaging.hdPreviewContract!==undefined)invalid('高清预览契约不一致');
  for(const key of ['videoPath','coverPath'])if(!sameBytes(required(dynamics,reviewed[key]),required(packaging,content+'/'+preview?.[key])))
    invalid('完整包不是最新同版动态预览的原字节');
}
async function collect(job,revision) {
  const {base}=location(job,revision),root=path.join(job.output,base);
  if(await fs.realpath(job.output)!==job.output||await fs.realpath(root)!==root)invalid('候选根目录不能是链接');
  for(const name of ['rigging/.build.lock','dynamics/.build.lock','dynamics/.review.lock','packaging/.build.lock'])await absent(root,name);
  const ancestry=await candidateLineage(job,revision,{allowBlockedOriginal:true}),expected=ancestry.identity,original=await originalRequirements(job);
  const artwork=await json(root,'artwork/stage.json');fullScope(artwork,original.brief);
  fullScope(await json(root,'artwork/artwork-manifest.json'),original.brief,false);
  const rig=await stage(root,'rigging',expected),dynamics=await stage(root,'dynamics',expected),packaging=await stage(root,'packaging',expected);
  for(const value of [rig,dynamics,packaging])fullScope(value,original.brief);
  const controls=await verifyRequestedControls(root,{...dynamics,brief:original.brief},await json(root,dynamics.parameterMapPath),
    await json(root,dynamics.dynamicsManifestPath),await inspectModel(root,dynamics.modelPath));
  const reviews=[await rigReview(root,rig,expected,original.brief)],dynamic=await dynamicsReview(root,dynamics,rig,expected,original.brief);reviews.push(dynamic.descriptor);
  const maps=new Map(),add=async a=>{
    const old=maps.get(a.path);if(old&&(old.sha256!==a.sha256||old.bytes!==a.bytes))invalid('不同阶段登记了不同源字节');
    await verify(job.output,a);if(!old)maps.set(a.path,a);
  };
  for(const a of [...original.artifacts,...ancestry.artifacts])await add(a);
  for(const parent of ancestry.parents) {
    for(const key of ['artworkStage','artworkManifest','reviewedArtworkManifest','rigStage','engineJournal'])if(parent[key])await add(parent[key]);
    const parentBase=parent.revision===job.revision?'':`revisions/r${String(parent.revision).padStart(4,'0')}/`;
    for(const key of ['artworkStage','rigStage'])if(parent[key]) {
      for(const a of (await json(job.output,parent[key].path)).artifacts)await add({...a,path:parentBase+a.path});
    }
  }
  const stages=[];
  for(const value of [rig,dynamics,packaging]) {
    stages.push(await artifact(job.output,base+'/'+value.stage+'/stage.json','completed-stage'));
    for(const a of value.artifacts)await add({...a,path:base+'/'+a.path});
  }
  for(const a of stages)await add(a);
  for(const relative of ['rigging/state.json','dynamics/engine-journal.json','dynamics/preview/engine-journal.json'])await add(await artifact(job.output,base+'/'+relative,'completed-engine-journal'));
  for(const value of [rig,dynamics]) {
    const model=await inspectModel(root,value.modelPath);for(const file of model.files)required(value,file);
  }
  const packageManifest=await json(root,packaging.packageManifestPath);sameIdentity(packageManifest,expected);
  required(packaging,packaging.packageManifestPath);
  if(!isDeepStrictEqual(packageManifest.requirementCoverage?.requested,controls.requested))invalid('完整包没有保留原任务逐项需求');
  verifyCoverage(controls.requested,packageManifest.expressions,packageManifest.motions);
  const content=path.posix.dirname(packaging.packageManifestPath),model=await inspectModel(root,dynamics.modelPath);
  await verifyPackagedPreview(root,packaging,dynamics,dynamic.preview,packageManifest.preview,content);
  for(const [source,copy] of [...model.files.map(file=>[file,content+'/model/'+path.posix.relative(model.directory,file)]),
    [dynamics.projectPath,packaging.projectPath],[dynamics.psdPath,packaging.psdPath]]) {
    const a=required(dynamics,source),b=required(packaging,copy);if(a.sha256!==b.sha256||a.bytes!==b.bytes)invalid('完整包不是最新同版动态产物的原字节');
  }
  if(packaging.modelPath!==content+'/'+packageManifest.modelPath||packaging.projectPath!==content+'/'+packageManifest.projectPath||
    packaging.psdPath!==content+'/'+packageManifest.psdPath)invalid('包内模型/工程/PSD入口不一致');
  const derived={...job,revision,parentRevision:expected.parentRevision,artifacts:{packagePath:packaging.packagePath}};
  const published=await singleImageSources(derived,root,cap,{verifyArchive:async(file,a,dest,options)=>{
    await verifyPackageArchive(file,a,dest,options);
    const m=await json(dest,'manifest.json');
    if(a.role==='complete-package') {
      const actual=await artifact(dest,'manifest.json');if(actual.sha256!==required(packaging,packaging.packageManifestPath).sha256)invalid('完整ZIP清单与登记源不同');
    } else {
      const full=packaging.deliveryFiles.find(a=>a.role==='complete-package');
      if(m.companionFullPackage?.sha256!==full?.sha256||m.companionFullPackage?.bytes!==full?.bytes)invalid('分包未绑定同一完整包');
      for(const row of m.files)if(/^(model|editable|preview)\//.test(row.path)) {
        const original=packageManifest.files.find(a=>a.path===row.path);
        if(!original||row.sha256!==original.sha256||row.bytes!==original.bytes)invalid('分包不属于同版完整包');
      }
    }
  }});
  for(const a of packaging.deliveryFiles) {required(packaging,a.path);await add({...a,path:base+'/'+a.path});}
  return {...expected,parents:ancestry.parents,artifacts:[...maps.values()].sort((a,b)=>a.path.localeCompare(b.path)),
    stages,reviews:reviews.map(r=>({...r,artifact:{...r.artifact,path:base+'/'+r.artifact.path}})),
    checks:[rig,dynamics,packaging].flatMap(s=>s.checks.map(c=>({...c,stage:s.stage}))),...published};
}
async function readSelection(job) {
  try{await fs.lstat(path.join(job.output,pointerPath));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const pointer=await json(job.output,pointerPath),where=location(job,pointer.revision);
  if(pointer.schemaVersion!==1||pointer.stage!=='completed-candidate-pointer'||pointer.manifest?.path!==where.relative)invalid('完成候选指针无效，不能回退其他版本');
  await verify(job.output,pointer.manifest);
  const bundle=await json(job.output,where.relative);sameIdentity(pointer,bundle);
  if(bundle.schemaVersion!==1||bundle.stage!=='completed-candidate'||bundle.status!=='completed')invalid('未登记完成候选');
  return {pointer,bundle,manifest:pointer.manifest};
}
async function frozen(job,bundle) {
  if(!Array.isArray(bundle.artifacts))invalid('缺少冻结的候选来源');
  for(const a of bundle.artifacts)await verify(job.output,a);
  const current=await collect(job,bundle.revision);sameIdentity(bundle,current);
  if(!isDeepStrictEqual(snapshot(bundle),snapshot(current)))changed();
  return current;
}

// Local registration only: no worker/editor/media-store calls and no parent-job mutation.
export async function registerCompletedCandidate(job,{revision}={}) {
  const where=location(job,revision),root=job.output;
  if(await fs.realpath(root)!==root)invalid('任务根目录不能是链接');
  const file=path.join(root,pointerPath),lock=file+'.lock',tmp=file+'.'+randomUUID()+'.tmp';let handle;
  try{handle=await fs.open(lock,'wx');}catch(e){if(e.code==='EEXIST')fail('COMPLETED_CANDIDATE_BUSY','完成候选正在登记');throw e;}
  try {
    const old=await readSelection(job);if(old&&old.bundle.revision>revision)invalid('完成候选不能回退覆盖');
    const current=await collect(job,revision),dir=path.dirname(path.join(root,where.relative));
    let bundle;
    try{await fs.lstat(path.join(root,where.relative));bundle=await json(root,where.relative);
      if(bundle.schemaVersion!==1||bundle.stage!=='completed-candidate'||bundle.status!=='completed')invalid('已有无效登记，保留原记录');
      sameIdentity(bundle,current);for(const a of bundle.artifacts)await verify(root,a);
      if(!isDeepStrictEqual(snapshot(bundle),snapshot(current)))changed();
    }catch(e){if(e.code!=='ENOENT')throw e;}
    if(!bundle) {
      bundle={schemaVersion:1,stage:'completed-candidate',status:'completed',...Object.fromEntries(keys.map(k=>[k,current[k]])),
        ...snapshot(current),registeredAt:new Date().toISOString(),notice:current.notice};
      await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir)invalid('登记目录不能是链接');
      const temp=path.join(dir,'stage-'+randomUUID()+'.tmp');
      try{await fs.writeFile(temp,JSON.stringify(bundle,null,2)+'\n',{flag:'wx'});await fs.link(temp,path.join(root,where.relative));}
      finally{await fs.rm(temp,{force:true});}
    }
    const manifest=await artifact(root,where.relative,'completed-candidate-manifest');
    if(old&&old.manifest.path===manifest.path&&old.manifest.sha256===manifest.sha256)return bundle;
    let previousPointer;
    if(old) {
      const previous=await artifact(root,pointerPath,'completed-previous-pointer'),history='completed-candidate-history';
      await fs.mkdir(path.join(root,history),{recursive:true});if(await fs.realpath(path.join(root,history))!==path.join(root,history))invalid('恢复目录不能是链接');
      previousPointer={...previous,path:history+'/pointer-'+previous.sha256+'.json'};
      try{await fs.copyFile(file,path.join(root,previousPointer.path),fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
      await verify(root,previousPointer);await verify(root,previous);
    }
    for(const a of bundle.artifacts)await verify(root,a);
    await fs.writeFile(tmp,JSON.stringify({schemaVersion:1,stage:'completed-candidate-pointer',...Object.fromEntries(keys.map(k=>[k,bundle[k]])),
      manifest,...(previousPointer?{previousPointer}:{}),registeredAt:new Date().toISOString()},null,2)+'\n',{flag:'wx'});
    await fs.rename(tmp,file);return bundle;
  } finally {await fs.rm(tmp,{force:true});await handle.close();await fs.unlink(lock);}
}
export async function completedCandidateSources(job) {
  const selected=await readSelection(job);if(!selected)return null;
  const current=await frozen(job,selected.bundle);
  const assertUnchanged=async()=>{
    const now=await readSelection(job);
    if(!now||now.manifest.path!==selected.manifest.path||now.manifest.sha256!==selected.manifest.sha256)changed();
    const root=path.join(job.output,location(job,selected.bundle.revision).base);
    for(const file of ['rigging/.build.lock','dynamics/.build.lock','dynamics/.review.lock','packaging/.build.lock'])await absent(root,file);
    for(const parent of selected.bundle.parents) {
      const base=parent.revision===job.revision?'':`revisions/r${String(parent.revision).padStart(4,'0')}/`;
      await absent(job.output,base+'rigging/.build.lock');
    }
    for(const a of selected.bundle.artifacts)await verify(job.output,a);
  };
  return {...selected,sources:current.sources,archive:current.archive,notice:selected.bundle.notice,assertUnchanged};
}

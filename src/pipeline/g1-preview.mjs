import path from 'node:path';
import * as fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {artifact,digest,json,regular,relativePath} from '../packaging/files.mjs';
import {inspectModel} from '../packaging/model.mjs';
import {ffmpeg} from '../preview.mjs';
import {fail} from '../rpc.mjs';

const exec=promisify(execFile),keys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
const pointerPath='g1-preview-current.json';
export function g1Location(job,revision=job.revision+1) {
  if(!Number.isInteger(job.revision)||!Number.isInteger(revision)||revision<=job.revision)
    fail('PREVIEW_IDENTITY_MISMATCH','G1必须显式选择本任务的派生版本');
  return {revision,relative:`revisions/r${String(revision).padStart(4,'0')}/g1-preview/stage.json`};
}
function binding(job,revision=job.revision+1,parentRevision=revision===job.revision?job.parentRevision??null:job.revision) {
  return {taskId:job.id,candidateId:job.candidateId,revision,parentRevision,
    inputSha256:job.source.inputSha256,descriptionSha256:job.source.descriptionSha256};
}
function revisionBase(job,revision) {return revision===job.revision?'':`revisions/r${String(revision).padStart(4,'0')}`;}
function prefix(base) {return base?base+'/':'';}
async function revisionBinding(job,revision) {
  const stage=await json(path.join(job.output,revisionBase(job,revision)),'artwork/stage.json'),parent=stage.parentRevision;
  if(revision===job.revision?parent!==(job.parentRevision??null):
    !Number.isInteger(parent)||parent<job.revision||parent>=revision)
    fail('PREVIEW_IDENTITY_MISMATCH','G1父版必须是本任务内已登记的更早版本');
  const expected=binding(job,revision,parent);sameIdentity(stage,expected);return expected;
}
async function selectedBinding(job,revision) {
  // Preserve the original r2 registration contract; later repairs must have an
  // explicit Artwork stage and may branch from any recorded earlier revision.
  return revision===job.revision+1?binding(job,revision):revisionBinding(job,revision);
}
function sameIdentity(value,expected) {
  if(keys.some(k=>value?.[k]!==expected[k]))fail('PREVIEW_IDENTITY_MISMATCH','G1预览不属于本任务的派生版本');
}
async function verifyArtifact(root,a) {
  if(!a?.path)fail('PREVIEW_INVALID','G1缺少产物登记');
  const actual=await digest(await regular(root,a.path));
  if(actual.bytes!==a.bytes||actual.sha256!==a.sha256)fail('PREVIEW_CHANGED','G1源文件已变化，需要重新渲染并登记');
}

// Engine journals contain operation history; generic manifest JSON stays at
// 16 MiB. Only these fixed G1 journal reads permit up to 64 MiB, even on growth.
async function readJournal(root,relative) {
  const file=await regular(root,relative),limit=64*1024*1024;
  if((await fs.stat(file)).size>limit)fail('PREVIEW_INVALID','G1工程检查点超过64 MiB读取上限');
  const chunks=[];let bytes=0;
  for await(const chunk of createReadStream(file,{flags:fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW,end:limit})) {
    bytes+=chunk.length;
    if(bytes>limit)fail('PREVIEW_INVALID','G1工程检查点超过64 MiB读取上限');
    chunks.push(chunk);
  }
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));}
  catch {fail('PREVIEW_INVALID','G1工程检查点JSON无效');}
}

// buildRig paths are relative to the revision root. Its journal is intentionally
// excluded from rig.artifacts, so include it separately when it exists.
async function rigSources(root,base,expected) {
  const revisionRoot=path.join(root,base),rig=await json(revisionRoot,'rigging/stage.json');
  try{await fs.lstat(path.join(revisionRoot,'rigging/.build.lock'));fail('PREVIEW_BUSY','G1工程仍在制作或审查中');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  sameIdentity(rig,expected);
  if(rig.schemaVersion!==1||rig.stage!=='rigging'||!['blocked','completed'].includes(rig.status)||rig.pending||
    !rig.engineProjectId||!rig.engineRevision||!Array.isArray(rig.artifacts)||!rig.artifacts.length)
    fail('PREVIEW_INVALID','G1需要已导出的真实绑定阶段及工程状态');
  const paths=new Set(),artifacts=[];
  for(const a of rig.artifacts) {
    relativePath(a.path);
    if(paths.has(a.path))fail('PREVIEW_INVALID','G1绑定来源存在重复路径');
    paths.add(a.path);await verifyArtifact(revisionRoot,a);
    artifacts.push({...a,path:prefix(base)+a.path,role:'g1-rig-dependency'});
  }
  for(const key of ['projectPath','psdPath','modelPath','parameterMapPath'])if(!paths.has(rig[key])||
    !(rig.artifacts.find(a=>a.path===rig[key]).bytes>0))
    fail('PREVIEW_INVALID','G1缺少真实工程产物登记：'+key);
  const map=await json(revisionRoot,rig.parameterMapPath);sameIdentity(map,expected);
  if(map.projectId!==rig.engineProjectId||map.state!==rig.engineRevision)
    fail('PREVIEW_IDENTITY_MISMATCH','G1参数表不属于本工程状态');
  const journalPath=prefix(base)+'rigging/state.json';
  let hasJournal=false;
  try{await fs.lstat(path.join(root,journalPath));hasJournal=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(hasJournal) {
    const journal=await readJournal(root,journalPath);sameIdentity(journal.identity,expected);
    if(journal.projectId!==rig.engineProjectId||journal.state!==rig.engineRevision)
      fail('PREVIEW_IDENTITY_MISMATCH','G1检查点不属于本工程状态');
    if(journal.pending||journal.failed)fail('PREVIEW_INVALID','G1工程仍有未完成或失败操作');
    if(!paths.has('rigging/state.json'))artifacts.push(await artifact(root,journalPath,'g1-engine-state'));
  }
  const model=await inspectModel(revisionRoot,rig.modelPath);
  if(model.files.some(file=>!paths.has(file)))fail('PREVIEW_INVALID','G1模型资源未全部登记在真实工程产物中');
  return {rig,artifacts,model};
}

// Ancestors are provenance, not preview candidates. A failed pre-export stage
// is valid history; freeze its actual bytes without inventing export fields.
async function ancestorRigSources(root,base,expected,allowAbsent=false) {
  const revisionRoot=path.join(root,base),p=prefix(base);
  try{await fs.lstat(path.join(revisionRoot,'rigging/.build.lock'));fail('PREVIEW_BUSY','G1父版工程仍在制作或审查中');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  if(allowAbsent) {
    try{await fs.lstat(path.join(revisionRoot,'rigging/stage.json'));}
    catch(e) {
      if(e.code!=='ENOENT')throw e;
      try{await fs.lstat(path.join(revisionRoot,'rigging/state.json'));}
      catch(error){if(error.code==='ENOENT')return {};throw error;}
      fail('PREVIEW_INVALID','拆层阻断的父版存在未登记绑定状态');
    }
  }
  const rig=await json(revisionRoot,'rigging/stage.json');
  sameIdentity(rig,expected);
  if(rig.schemaVersion!==1||rig.stage!=='rigging'||!['blocked','completed','failed'].includes(rig.status)||!Array.isArray(rig.artifacts))
    fail('PREVIEW_INVALID','G1父版需要真实的绑定阶段历史');
  const paths=new Set();
  for(const a of rig.artifacts) {
    relativePath(a.path);
    if(paths.has(a.path))fail('PREVIEW_INVALID','G1父版绑定来源存在重复路径');
    paths.add(a.path);await verifyArtifact(revisionRoot,a);
  }
  const journalPath=p+'rigging/state.json';let hasJournal=false,engineJournal;
  try{await fs.lstat(path.join(root,journalPath));hasJournal=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  if(hasJournal) {
    const journal=await readJournal(root,journalPath);sameIdentity(journal.identity,expected);
    if((rig.engineProjectId!==undefined&&journal.projectId!==rig.engineProjectId)||
      (rig.engineRevision!==undefined&&journal.state!==rig.engineRevision))
      fail('PREVIEW_IDENTITY_MISMATCH','G1父版检查点与其登记工程状态不一致');
    engineJournal=await artifact(root,journalPath,'g1-engine-state');
  }
  return {rigStage:await artifact(root,p+'rigging/stage.json','g1-parent-rig-stage'),...(engineJournal?{engineJournal}:{})};
}

// Legacy r1 has no artwork fingerprint. Its exact stage/manifest bytes still
// freeze the recorded sources; derived HD artwork additionally recomputes it.
async function artworkSources(root,base,expected,requireFingerprint,allowBlockedAncestor=false) {
  const revisionRoot=path.join(root,base),p=prefix(base),stage=await json(revisionRoot,'artwork/stage.json');
  const manifest=await json(revisionRoot,'artwork/artwork-manifest.json');
  sameIdentity(stage,expected);sameIdentity(manifest,expected);
  const blockedAncestor=allowBlockedAncestor&&stage.status==='blocked'&&manifest.status==='blocked'&&
    stage.unresolved?.some(row=>row.stage==='artwork'&&row.code==='ARTWORK_QUALITY_FAILED');
  if(stage.schemaVersion!==1||stage.stage!=='artwork'||(!blockedAncestor&&stage.status!=='completed')||stage.pending||stage.failed||
    !Array.isArray(stage.artifacts)||!stage.artifacts.length||!Array.isArray(manifest.parts)||!manifest.parts.length)
    fail('PREVIEW_INVALID','G1需要已完成并登记真实源文件的Artwork阶段');
  const artifacts=[];
  for(const a of stage.artifacts){await verifyArtifact(revisionRoot,a);artifacts.push({...a,path:p+a.path,role:'g1-artwork-dependency'});}
  const sourcePath=value=>{relativePath(value);return value.startsWith('artwork/')?value:'artwork/'+value;};
  const layoutPath=sourcePath(manifest.layoutPath),layout=await artifact(revisionRoot,layoutPath,'g1-artwork-dependency');
  if(stage.layoutPath!==layoutPath)fail('PREVIEW_IDENTITY_MISMATCH','Artwork布局不属于本阶段');
  artifacts.push({...layout,path:p+layoutPath});
  for(const part of manifest.parts) {
    const a=await artifact(revisionRoot,sourcePath(part.path),'g1-artwork-dependency');
    if(a.sha256!==part.sha256)fail('PREVIEW_CHANGED','Artwork分层像素已变化');
    artifacts.push({...a,path:p+a.path});
  }
  if(requireFingerprint||manifest.artworkFingerprint||stage.artworkFingerprint) {
    const fingerprint=createHash('sha256').update(JSON.stringify({layoutSha256:layout.sha256,
      parts:manifest.parts.map(({id,sha256,rect})=>({id,sha256,rect}))})).digest('hex');
    if(fingerprint!==manifest.artworkFingerprint||fingerprint!==stage.artworkFingerprint)
      fail('PREVIEW_CHANGED','Artwork指纹与实际布局或分层像素不一致');
  }
  const descriptor={revision:expected.revision,parentRevision:expected.parentRevision,
    artworkStage:await artifact(root,p+'artwork/stage.json','g1-parent-artwork-stage'),
    artworkManifest:await artifact(root,p+'artwork/artwork-manifest.json','g1-parent-artwork-manifest'),
    ...(manifest.artworkFingerprint?{artworkFingerprint:manifest.artworkFingerprint}:{})};
  relativePath(stage.artworkManifestPath);
  if(stage.artworkManifestPath!=='artwork/artwork-manifest.json') {
    sameIdentity(await json(revisionRoot,stage.artworkManifestPath),expected);
    descriptor.reviewedArtworkManifest=await artifact(root,p+stage.artworkManifestPath,'g1-parent-reviewed-artwork');
  }
  artifacts.push({...descriptor.artworkStage,role:'g1-artwork-stage'},
    {...descriptor.artworkManifest,role:'g1-artwork-dependency'});
  return {stage,manifest,descriptor,artifacts,blockedAncestor};
}

async function lineage(job,revision,{allowBlockedOriginal=false}={}) {
  const parents=[];let child,selected,identity,r=revision;
  for(;;) {
    const expected=await revisionBinding(job,r),base=revisionBase(job,r),
      current=await artworkSources(job.output,base,expected,r>job.revision,allowBlockedOriginal&&r===job.revision&&r<revision);
    if(!selected){selected=current;identity=expected;}
    if(child&&r>job.revision) {
      for(const value of [child.stage,child.manifest]) {
        if(value.parentArtworkFingerprint!==current.manifest.artworkFingerprint)
          fail('PREVIEW_CHANGED','Artwork父版指纹已失效');
        for(const [key,a] of [['parentArtworkStage',current.descriptor.artworkStage],['parentArtworkManifest',current.descriptor.artworkManifest]]) {
          const link=value[key],relative=path.posix.relative(revisionBase(job,child.descriptor.revision),a.path);
          if(link?.path!==relative)fail('PREVIEW_IDENTITY_MISMATCH','Artwork父版来源路径无效');
          await verifyArtifact(job.output,{...link,path:a.path});
        }
      }
    }
    if(r<revision) {
      parents.push({...current.descriptor,...await ancestorRigSources(job.output,base,expected,current.blockedAncestor)});
    }
    if(r===job.revision)break;
    child=current;r=expected.parentRevision;
  }
  return {parents,artifacts:selected.artifacts,identity};
}
// Read-only provenance shared by complete-candidate registration. No selection,
// stage promotion or media publication occurs here.
export {lineage as candidateLineage};
async function verifyParents(job,bundle) {
  const current=await lineage(job,bundle.revision);
  sameIdentity(bundle,current.identity);
  if(JSON.stringify(current.parents)!==JSON.stringify(bundle.parents))fail('PREVIEW_CHANGED','G1父版阶段或来源哈希已变化');
  if(current.artifacts.some(a=>!bundle.artifacts.some(b=>a.path===b.path&&a.sha256===b.sha256&&a.bytes===b.bytes)))
    fail('PREVIEW_CHANGED','G1本版Artwork来源哈希已变化');
}

async function readPointer(job) {
  try{await fs.lstat(path.join(job.output,pointerPath));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const pointer=await json(job.output,pointerPath),location=g1Location(job,pointer.revision);
  sameIdentity(pointer,await selectedBinding(job,location.revision));
  if(pointer.schemaVersion!==1||pointer.stage!=='g1-preview-pointer'||pointer.manifest?.path!==location.relative)
    fail('PREVIEW_IDENTITY_MISMATCH','G1当前指针无效，不能回退选择其他版本');
  await verifyArtifact(job.output,pointer.manifest);
  return pointer;
}

async function registerBundle(root,relative,bundle) {
  const file=path.join(root,relative),dir=path.dirname(file),lock=file+'.lock',tmp=file+'.'+randomUUID()+'.tmp';
  if(await fs.realpath(dir)!==dir)fail('PREVIEW_INVALID','G1登记目录不能是链接');
  let handle;
  try{handle=await fs.open(lock,'wx');}catch(e){if(e.code==='EEXIST')fail('PREVIEW_BUSY','G1登记正在更新');throw e;}
  try {
    let previous;
    try{await fs.lstat(file);previous=await artifact(root,relative,'g1-previous-manifest');}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous) {
      const old=await json(root,relative);sameIdentity(old,bundle);
      if(bundle.parents&&JSON.stringify(old.parents)!==JSON.stringify(bundle.parents))
        fail('PREVIEW_CHANGED','G1已冻结的父版来源变化，不能通过重新登记刷新');
      for(const a of old.artifacts??[])if(['g1-video','g1-cover','g1-full-body','g1-face'].includes(a.role))await verifyArtifact(root,a);
      const history=path.posix.dirname(relative)+'/history';await fs.mkdir(path.join(root,history),{recursive:true});
      if(await fs.realpath(path.join(root,history))!==path.join(root,history))fail('PREVIEW_INVALID','G1恢复目录不能是链接');
      const backup=history+'/stage-'+previous.sha256+'.json';
      try{await fs.copyFile(file,path.join(root,backup),fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
      await verifyArtifact(root,{...previous,path:backup});
      bundle.previousManifest={...previous,path:backup};
      await verifyArtifact(root,previous);
    }
    for(const a of bundle.artifacts)await verifyArtifact(root,a);
    await fs.writeFile(tmp,JSON.stringify(bundle,null,2)+'\n',{flag:'wx'});
    await fs.rename(tmp,file);
  } finally {await fs.rm(tmp,{force:true});await handle.close();await fs.unlink(lock);}
}

async function registerSelection(job,relative,bundle) {
  const root=job.output,file=path.join(root,pointerPath),lock=file+'.lock',tmp=file+'.'+randomUUID()+'.tmp';
  let handle;
  try{handle=await fs.open(lock,'wx');}catch(e){if(e.code==='EEXIST')fail('PREVIEW_BUSY','G1当前版本正在更新');throw e;}
  try {
    const old=await readPointer(job);
    if(old&&old.revision>bundle.revision)fail('PREVIEW_IDENTITY_MISMATCH','G1不能回退覆盖已选择的返修版');
    let previousPointer;
    if(old) {
      const prior=await artifact(root,pointerPath,'g1-previous-pointer'),history='g1-preview-history';
      await fs.mkdir(path.join(root,history),{recursive:true});
      if(await fs.realpath(path.join(root,history))!==path.join(root,history))fail('PREVIEW_INVALID','G1指针恢复目录不能是链接');
      const backup=history+'/pointer-'+prior.sha256+'.json';
      try{await fs.copyFile(file,path.join(root,backup),fs.constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
      previousPointer={...prior,path:backup};await verifyArtifact(root,previousPointer);await verifyArtifact(root,prior);
    }
    if(bundle.parents)await verifyParents(job,bundle);
    await registerBundle(root,relative,bundle);
    const pointer={schemaVersion:1,stage:'g1-preview-pointer',...binding(job,bundle.revision,bundle.parentRevision),
      manifest:await artifact(root,relative,'g1-preview-manifest'),...(previousPointer?{previousPointer}:{}),updatedAt:new Date().toISOString()};
    await fs.writeFile(tmp,JSON.stringify(pointer,null,2)+'\n',{flag:'wx'});await fs.rename(tmp,file);
  } finally {await fs.rm(tmp,{force:true});await handle.close();await fs.unlink(lock);}
}

// Stage preview publication is deliberately independent of final-package acceptance.
export async function createG1PreviewBundle(job,{revision=job.revision+1,renderDirectory}={}) {
  if(job.kind!=='single_image')fail('PREVIEW_INVALID','仅支持本项目单图候选的G1预览');
  const location=g1Location(job,revision),root=job.output,base=path.posix.dirname(path.posix.dirname(location.relative));
  const old=await readPointer(job);
  if(old&&old.revision>revision)fail('PREVIEW_IDENTITY_MISMATCH','G1不能回退覆盖已选择的返修版');
  const ancestry=revision>job.revision+1?await lineage(job,revision):null;
  const expected=ancestry?.identity??binding(job,revision),artworkPath=base+'/artwork/artwork-manifest.json',rigPath=base+'/rigging/stage.json';
  const artwork=await json(root,artworkPath),{rig,artifacts:rigArtifacts,model}=await rigSources(root,base,expected);
  sameIdentity(artwork,expected);
  const renderDir=renderDirectory??base+'/g1-preview/render';relativePath(renderDir);
  if(!renderDir.startsWith(base+'/g1-preview/'))fail('PREVIEW_IDENTITY_MISMATCH','G1渲染必须属于同一派生版本');
  const provenance=await json(root,renderDir+'/render-provenance.json');
  for(const k of ['taskId','candidateId','revision','inputSha256'])if(provenance[k]!==expected[k])fail('PREVIEW_IDENTITY_MISMATCH','渲染来源不属于本版素材');
  const artworkDigest=await digest(await regular(root,artworkPath));
  if(provenance.artworkManifest?.sha256!==artworkDigest.sha256||provenance.artworkManifest?.bytes!==artworkDigest.bytes)
    fail('PREVIEW_CHANGED','渲染使用的素材版本已经变化');
  const modelPath=base+'/'+rig.modelPath,modelDir=path.posix.dirname(modelPath);
  if(provenance.entry!==path.join(root,modelPath)||provenance.modelFiles?.length!==model.files.length)
    fail('PREVIEW_IDENTITY_MISMATCH','预览未使用本版完整MOC资源');
  const modelArtifacts=[];
  for(const relative of model.files){
    const file=base+'/'+relative,a=await artifact(root,file,'g1-model-source'),rendered=provenance.modelFiles.find(f=>f.file===path.posix.relative(modelDir,file));
    if(!rendered||rendered.sha256!==a.sha256||rendered.bytes!==a.bytes)fail('PREVIEW_CHANGED','预览MOC或图集与工程不一致');
    modelArtifacts.push(a);
  }
  if(provenance.width!==1920||provenance.height!==1080||provenance.fps!==30||provenance.frameCount<240||
    provenance.frameCount!==Math.ceil(provenance.seconds*30))fail('PREVIEW_INVALID','G1必须是至少8秒的真实1080P/30fps渲染');
  const sampled=provenance.samples?.map(s=>s.parameters)??[];
  const span=id=>Math.max(...sampled.map(p=>p[id]))-Math.min(...sampled.map(p=>p[id]));
  if(!(span('ParamAngleX')>=10&&span('ParamMouthOpenY')>=.4&&span('ParamEyeLOpen')>=.8))
    fail('PREVIEW_INVALID','G1缺少可读回的转头、眨眼与张嘴变化');
  const videoPath=renderDir+'/Hachi-G1-1080p30.mp4',video=await artifact(root,videoPath,'g1-video');
  if(provenance.video?.sha256!==video.sha256||provenance.video?.bytes!==video.bytes)fail('PREVIEW_CHANGED','视频与渲染回执不一致');
  const decoded=await exec(ffmpeg,['-hide_banner','-i',await regular(root,videoPath),'-map','0:v:0','-f','null','-'],{maxBuffer:2*1024*1024});
  if(!/Video: h264[^\n]*1920x1080[^\n]*30 fps/.test(decoded.stderr))fail('PREVIEW_INVALID','视频实际编码不满足1080P/30fps');
  const artifacts=[await artifact(root,artworkPath,'g1-artwork-source'),await artifact(root,rigPath,'g1-rig-source'),
    await artifact(root,renderDir+'/render-provenance.json','g1-render-source'),...modelArtifacts,
    ...rigArtifacts.filter(a=>a.path!==artworkPath&&!modelArtifacts.some(m=>m.path===a.path)),video,
    await artifact(root,renderDir+'/pose-0000.png','g1-cover'),await artifact(root,renderDir+'/full-body.png','g1-full-body'),
    await artifact(root,renderDir+'/face.png','g1-face')];
  for(const a of ancestry?.artifacts??[])if(!artifacts.some(b=>a.path===b.path))artifacts.push(a);
  const bundle={schemaVersion:1,stage:'g1-preview',status:'pending_user_review',...expected,engineProjectId:rig.engineProjectId,engineRevision:rig.engineRevision,
    ...(ancestry?{parents:ancestry.parents}:{}),createdAt:new Date().toISOString(),artifacts,checks:{modelRender:'decoded',video:'1080p30',nativePlayback:'not_run',
      desktopImport:'not_run',cameraTracking:'not_run',userAcceptance:'pending'},
    notice:'G1制作预览：同版模型的转头、眨眼和口型回放，无音轨；完整表情、挥手、胸结摘戴、真人跟随和用户认可尚未完成。'};
  await registerSelection(job,location.relative,bundle);return bundle;
}

export async function g1PreviewSources(job) {
  if(job.kind!=='single_image'||!Number.isInteger(job.revision))fail('PREVIEW_INVALID','仅支持本项目单图候选的G1预览');
  const pointer=await readPointer(job),{revision,relative}=g1Location(job,pointer?.revision??job.revision+1),bundle=await json(job.output,relative);
  const expected=await selectedBinding(job,revision);sameIdentity(bundle,expected);
  if(bundle.schemaVersion!==1||bundle.stage!=='g1-preview'||bundle.status!=='pending_user_review'||!Array.isArray(bundle.artifacts))
    fail('PREVIEW_INVALID','G1预览登记无效');
  const base=path.posix.dirname(path.posix.dirname(relative))+'/';
  for(const a of bundle.artifacts){
    if(typeof a.path!=='string'||!a.path.startsWith(base))fail('PREVIEW_IDENTITY_MISMATCH','G1资源必须属于同一派生版本');
    await verifyArtifact(job.output,a);
  }
  if(revision>job.revision+1)await verifyParents(job,bundle);
  const {rig,artifacts:rigArtifacts,model}=await rigSources(job.output,base.slice(0,-1),expected);
  if(bundle.engineProjectId!==rig.engineProjectId||bundle.engineRevision!==rig.engineRevision||
    rigArtifacts.some(a=>!bundle.artifacts.some(b=>a.path===b.path&&a.sha256===b.sha256&&a.bytes===b.bytes))||
    model.files.some(file=>!bundle.artifacts.some(a=>a.role==='g1-model-source'&&a.path===base+file)))
    fail('PREVIEW_INVALID','G1缺少同版工程的完整来源哈希闭包，请重新登记');
  const roles=['g1-video','g1-cover','g1-full-body','g1-face'];
  if([...roles,'g1-artwork-source','g1-rig-source','g1-render-source'].some(role=>bundle.artifacts.filter(a=>a.role===role).length!==1)||
    bundle.artifacts.filter(a=>a.role==='g1-model-source').length<2)fail('PREVIEW_INVALID','G1媒体或模型来源不完整');
  const sources=await Promise.all(roles.map(async role=>{
    const a=bundle.artifacts.find(a=>a.role===role);
    return {file:await regular(job.output,a.path),artifact:a,mime:role==='g1-video'?'video/mp4':'image/png',
      name:role==='g1-video'?'Hachi-G1-1080p30.mp4':role==='g1-cover'?'Hachi-G1-预览.png':role==='g1-full-body'?'Hachi-G1-全身.png':'Hachi-G1-脸部.png'};
  }));
  const manifest=await artifact(job.output,relative,'g1-preview-manifest');
  if(pointer&&(manifest.sha256!==pointer.manifest.sha256||manifest.bytes!==pointer.manifest.bytes))
    fail('PREVIEW_CHANGED','G1当前指针指向的登记在核验期间发生变化');
  return {bundle,sources,manifest};
}

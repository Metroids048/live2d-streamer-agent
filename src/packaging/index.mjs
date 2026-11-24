import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {artifact, digest, inventory, json, regular, relativePath, reject, writeJson} from './files.mjs';
import {archive} from './archive.mjs';
import {verifyCoverage, verifyRequestedControls} from './controls.mjs';
import {inspectModel} from './model.mjs';
import {inspectLeafCapability, defaultLeafInputMap} from '../runtime/leaf/index.mjs';
import {planDelivery, LOCAL_ATTACHMENT_MAX_BYTES} from './distribution.mjs';
import {packageSourcePsd,verifySourcePsd} from './source-psd.mjs';
import {finalPreviewReviewGate,verifyFinalPreviewReceipt} from './final-preview-review.mjs';
import {isEditableVolume,makeEditableVolumes} from './editable-volumes.mjs';

export {planDelivery} from './distribution.mjs';
const identityKeys = ['taskId', 'candidateId', 'revision', 'parentRevision', 'inputSha256', 'descriptionSha256'];
const identity = bundle => Object.fromEntries(identityKeys.map(key => [key, bundle[key]]));
const validRevision = value => typeof value === 'string' && value.length > 0 || Number.isSafeInteger(value) && value > 0;
const check = (name, layer, status, note) => ({name: `packaging.${name}`, layer, status, ...(note ? {note} : {})});
const sameIdentity = (a, b) => identityKeys.every(key => a[key] === b[key]);
const publicChecks = checks => checks.map(({name, layer, status}) => ({name, layer, status}));
const sameDigest = (a,b) => a?.sha256===b?.sha256&&a?.bytes===b?.bytes;
const validDigest = value => /^[a-f0-9]{64}$/.test(value?.sha256)&&Number.isSafeInteger(value?.bytes)&&value.bytes>0;

function publicProvenancePaths(value) {
  if(typeof value==='string'&&(/^(?:\/|[A-Za-z]:[\\/]|file:\/\/|\\\\)/.test(value)))
    reject('REFERENCE_INVALID','高清预览移交记录不能包含本机绝对路径');
  if(value&&typeof value==='object')for(const child of Object.values(value))publicProvenancePaths(child);
}

async function verifyHdSource(root,manifest,files,model,proof) {
  const linked=proof.sourceProvenance;
  if(!validDigest(linked)||!files.has(linked.path)||!sameDigest(linked,files.get(linked.path))||
    !validDigest(proof.originalProvenance)||proof.sourcePathPolicy!=='entry-remapped-to-package-model')
    reject('REFERENCE_INVALID','高清渲染来源必须登记为包内文件，并保留本地原件摘要');
  const source=await json(root,linked.path),request=source.sourceRequest,preview=manifest.preview;
  publicProvenancePaths(source);
  if(source.schemaVersion!==2||!sameIdentity(source,manifest)||source.kind!=='parameter_playback'||
    request?.schemaVersion!==1||!sameIdentity(request,manifest)||request.kind!=='parameter_playback'||source.entry!==manifest.modelPath||
    ['width','height','fps','frameCount'].some(k=>source[k]!==preview[k]||request[k]!==preview[k])||
    JSON.stringify(source.phases)!==JSON.stringify(preview.phases)||JSON.stringify(request.phases)!==JSON.stringify(preview.phases)||
    JSON.stringify(source.phaseFrames)!==JSON.stringify(request.phaseFrames)||JSON.stringify(source.phaseFrames)!==JSON.stringify(proof.phaseFrames)||
    JSON.stringify(source.physics)!==JSON.stringify(proof.physics))reject('REFERENCE_INVALID','包内高清渲染来源身份、规格或阶段不符');
  const requestBytes=Buffer.from(JSON.stringify(request,null,2)+'\n');
  if(!sameDigest(source.request,{sha256:createHash('sha256').update(requestBytes).digest('hex'),bytes:requestBytes.length}))
    reject('REFERENCE_INVALID','高清渲染源请求摘要不符');
  const records=rows=>{
    if(!Array.isArray(rows))reject('REFERENCE_INVALID','高清渲染来源清单缺失');
    const result=new Map();
    for(const row of rows) {
      relativePath(row.path);
      if(result.has(row.path)||!validDigest(row))reject('REFERENCE_INVALID','高清渲染来源摘要缺失或重复');
      result.set(row.path,row);
    }
    return result;
  };
  const sources=records(request.sources),requestedModel=records(request.modelFiles);
  for(const name of [request.modelPath,request.artworkManifestPath,request.dynamicsManifestPath,request.trajectoryPath,'dynamics/recipe.json',request.physics?.path]) {
    relativePath(name);if(!sources.has(name))reject('REFERENCE_INVALID','高清渲染缺少已登记来源');
  }
  if(!sameDigest(source.trajectory,sources.get(request.trajectoryPath))||!sameDigest(source.artworkManifest,sources.get(request.artworkManifestPath)))
    reject('REFERENCE_INVALID','高清渲染轨迹或Artwork摘要不符');
  relativePath(request.rendererScript?.path);
  if(!validDigest(request.rendererScript)||!model||!Array.isArray(source.modelFiles)||
    source.modelFiles.length!==model.files.length||requestedModel.size!==model.files.length)
    reject('REFERENCE_INVALID','高清渲染未绑定全部模型资源或渲染脚本');
  const seen=new Set(),sourceDirectory=path.posix.dirname(request.modelPath);
  for(const row of source.modelFiles) {
    relativePath(row.file);
    const original=path.posix.join(sourceDirectory,row.file),packaged=path.posix.join(model.directory,row.file);
    if(seen.has(packaged)||!model.files.includes(packaged)||!sameDigest(row,files.get(packaged))||
      !sameDigest(row,requestedModel.get(original))||!sameDigest(row,sources.get(original)))
      reject('REFERENCE_INVALID','高清渲染模型资源与包内字节不符');
    seen.add(packaged);
  }
  if(path.posix.relative(sourceDirectory,request.physics.path)!==path.posix.relative(model.directory,model.physics)||
    !request.physics.groups?.length||!request.physics.outputs?.length||
    JSON.stringify(source.physics?.groups)!==JSON.stringify(request.physics.groups)||
    JSON.stringify(source.physics?.outputs?.map(o=>o.parameter))!==JSON.stringify(request.physics.outputs))
    reject('REFERENCE_INVALID','高清渲染物理来源不符');
  for(const key of ['videoPath','coverPath','fullBodyPath','facePath']) {
    const output=proof.outputs[key],rendered=key==='videoPath'?source.video:source.stills?.find(s=>s.file===output.sourceFile);
    if(rendered?.file!==output.sourceFile||!sameDigest(rendered,output))reject('REFERENCE_INVALID','高清渲染输出与包内附件不符');
  }
}

async function verifyArtifacts(root, artifacts) {
  if (!Array.isArray(artifacts)) reject('REFERENCE_INVALID', '上游缺少产物清单');
  const found = new Map(), folded = new Set();
  for (const item of artifacts) {
    relativePath(item.path);
    const key = item.path.normalize('NFC').toLocaleLowerCase('en-US');
    if (found.has(item.path) || folded.has(key)) reject('REFERENCE_INVALID', '产物路径重复或大小写冲突');
    const actual = await artifact(root, item.path, item.role);
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) ||
        actual.sha256 !== item.sha256 || actual.bytes !== item.bytes) reject('REFERENCE_INVALID', `产物哈希或体积不符：${item.path}`);
    found.set(item.path, item); folded.add(key);
  }
  return found;
}

function publicRights(rights) {
  if (!rights || rights.allowDerivatives !== true || typeof rights.allowRedistribution !== 'boolean') reject('RIGHTS_UNRESOLVED', '缺少制作授权及再分发限制声明');
  const text = value => typeof value === 'string' && !/[\x00-\x1f]/u.test(value) &&
    !value.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(value) ? value.slice(0, 2000) : '未提供可公开说明';
  return {source: text(rights.source), license: text(rights.license), attribution: text(rights.attribution),
    allowDerivatives: true, allowRedistribution: rights.allowRedistribution, userDeclared: rights.userDeclared === true,
    legalVerification: 'not_run', backendOutputTerms: 'not_verified',
    scope: '用户声明不等于独立法律核验；不为整包统一授予CC0。运行库和生成后台条款各自适用。'};
}

function publicMap(map) {
  const parameters = Array.isArray(map.parameters) ? map.parameters : [];
  return {schemaVersion: 1, kind: 'informational-parameter-map', nativeLeafProfile: false,
    sourceSchemaRecognized: Array.isArray(map.parameters),
    parameters: parameters.map(p => {
      if (typeof p.id !== 'string' || !p.id || p.id.length > 256) reject('REFERENCE_INVALID', '参数映射缺少实际ID');
      const text = value => typeof value === 'string' ? value.slice(0, 256) : null;
      const number = value => Number.isFinite(value) ? value : null;
      return {id: p.id, semantic: text(p.semantic), min: number(p.min), max: number(p.max),
        default: number(p.default), unit: text(p.unit), available: typeof p.available === 'boolean' ? p.available : null,
        leafDefaultInput: Object.hasOwn(defaultLeafInputMap, p.id) ? defaultLeafInputMap[p.id] : null};
    })};
}

async function verifyPreview(root, preview) {
  const video = await regular(root, preview.videoPath), cover = await regular(root, preview.coverPath);
  const read = async file => {
    const handle = await fs.open(file, 'r');
    try {const header = Buffer.alloc(12); await handle.read(header, 0, 12, 0); return header;}
    finally {await handle.close();}
  };
  if ((await read(video)).subarray(4, 8).toString() !== 'ftyp') reject('REFERENCE_INVALID', '制作预览不是可识别的MP4容器');
  const header = await read(cover);
  if (!header.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && header.subarray(0, 3).toString('hex') !== 'ffd8ff') reject('REFERENCE_INVALID', '封面不是PNG/JPEG');
}

/** Reverify an extracted, movable package. Pass identity from a trusted Bundle. */
export async function verifyPackage(directory, expectedIdentity) {
  const root = await fs.realpath(directory), manifest = await json(root, 'manifest.json');
  if (manifest.schemaVersion !== 1 || manifest.stage !== 'packaging' ||
      expectedIdentity && !sameIdentity(manifest, expectedIdentity)) reject('REFERENCE_INVALID', '包身份或格式不符');
  if (!['full', 'runtime', 'editable-assets'].includes(manifest.variant) ||
      manifest.variant !== 'editable-assets' && typeof manifest.modelPath !== 'string' ||
      manifest.variant !== 'runtime' && (typeof manifest.projectPath !== 'string' || typeof manifest.psdPath !== 'string')) reject('REFERENCE_INVALID', '包类型与必需入口不符');
  const files = await verifyArtifacts(root, manifest.files);
  const actual = await inventory(root);
  if (actual.length !== files.size + 1 || actual.some(f => f.path !== 'manifest.json' && !files.has(f.path))) reject('REFERENCE_INVALID', '解压包包含未登记文件或缺少文件');
  let model = null, editableProject = null, psd = null, sourcePsd = null;
  if (manifest.modelPath) {
    model = await inspectModel(root, manifest.modelPath);
    for (const file of model.files) if (!files.has(file)) reject('REFERENCE_INVALID', '包清单缺少运行引用');
    if (manifest.requirementCoverage?.indexedControls !== 'passed' || !model.display || !model.physics)
      reject('REFERENCE_INVALID','此包缺少本版的需求与控制校验或显示资源');
    verifyCoverage(manifest.requirementCoverage.requested, manifest.expressions, manifest.motions);
    for (const [key, type] of [['expressions','expression'],['motions','motion']]) {
      const rows=manifest[key], indexed=model[key], extra=manifest.additionalIndexedControls?.[key] ?? [];
      if (!Array.isArray(extra) || rows.length+extra.length!==indexed.length ||
          new Set([...rows,...extra].map(r=>r.leafId)).size!==indexed.length)
        reject('REFERENCE_INVALID','包内索引与实际入口数量不符');
      for (const row of extra) {
        const actual = indexed.find(r=>r.leafId===row.leafId);
        if (!actual || Object.keys(actual).some(k=>actual[k]!==row[k])) reject('REFERENCE_INVALID','附加入口与实际索引不符');
      }
      for (const row of rows) {
        const actual=indexed.find(r=>r.leafId===row.leafId && r.file===row.file);
        const label=type==='expression'?actual?.name:actual?.group+' · '+(actual?.index+1);
        if (!actual || label!==row.name || row.leafActionId!==type+':'+row.leafId) reject('REFERENCE_INVALID','包内 Leaf 名称、动作号与实际模型文件不符');
      }
    }
  }
  if (manifest.projectPath) editableProject = await archive({action: 'project', file: await regular(root, manifest.projectPath)});
  if (manifest.psdPath) psd = await archive({action: 'psd', file: await regular(root, manifest.psdPath)});
  // Historical 1.1 packages retain their original contract; every new editable package requires the source PSD.
  if(manifest.variant!=='runtime'&&(['1.2.0','1.2.1'].includes(manifest.producer?.packaging)||manifest.sourcePsdContract!==undefined))sourcePsd=await verifySourcePsd(root,manifest,files);
  if(manifest.producer?.packaging==='1.2.1'&&manifest.variant!=='editable-assets'&&!manifest.preview?.finalReviewPath)
    reject('REFERENCE_INVALID','当前生产包缺少最终 MP4 视觉验收');
  if(manifest.preview?.finalReviewPath) {
    const reviewPath=manifest.preview.finalReviewPath,video=files.get(manifest.preview.videoPath);
    if(!files.has(reviewPath)||!video||!verifyFinalPreviewReceipt(await json(root,reviewPath),manifest,video,
      manifest.preview.frameCount/manifest.preview.fps))reject('REFERENCE_INVALID','包内最终预览没有通过同版视觉验收');
  }
  if(manifest.preview?.hdContract===1) {
    const preview=manifest.preview;
    if(preview.width!==1920||preview.height!==1080||preview.fps!==30||!Number.isSafeInteger(preview.frameCount)||preview.frameCount<2||
      !Array.isArray(preview.phases)||!preview.phases.length)reject('REFERENCE_INVALID','高清预览规格或完整阶段缺失');
    for(const key of ['videoPath','coverPath','fullBodyPath','facePath','provenancePath'])if(!files.has(preview[key]))reject('REFERENCE_INVALID','高清预览附件未登记');
    const proof=await json(root,preview.provenancePath);
    if(proof.schemaVersion!==1||!sameIdentity(proof,manifest)||proof.kind!=='parameter_playback'||
      ['width','height','fps','frameCount'].some(k=>proof[k]!==preview[k])||JSON.stringify(proof.phases)!==JSON.stringify(preview.phases)||
      proof.modelSha256!==preview.modelSha256||proof.projectSha256!==preview.projectSha256||
      ['videoPath','coverPath','fullBodyPath','facePath'].some(k=>proof.outputs?.[k]?.path!==preview[k]||
        proof.outputs[k].sha256!==files.get(preview[k]).sha256||proof.outputs[k].bytes!==files.get(preview[k]).bytes))
      reject('REFERENCE_INVALID','高清预览来源与包内字节不符');
    if(model&&files.get(manifest.modelPath).sha256!==proof.modelSha256||manifest.projectPath&&files.get(manifest.projectPath).sha256!==proof.projectSha256)
      reject('REFERENCE_INVALID','高清预览绑定了不同工程或模型');
    await verifyHdSource(root,manifest,files,model,proof);
  }
  return {identity: identity(manifest), variant: manifest.variant, files: files.size,
    hashes: 'passed', references: model ? 'passed' : 'not_applicable', editableProject, psd, sourcePsd,
    nativeReopen: 'not_run', runtime: 'not_run', visual: 'not_run'};
}

/** Verifies the trusted outer hash BEFORE extraction; never trusts a modified manifest alone. */
export async function verifyPackageArchive(file, expected, destination, {identity: expectedIdentity, signal} = {}) {
  signal?.throwIfAborted();
  if (!expected || !/^[a-f0-9]{64}$/.test(expected.sha256)) reject('REFERENCE_INVALID', '下载复验需要可信ZIP哈希');
  const actual = await digest(file);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) reject('REFERENCE_INVALID', 'ZIP哈希或体积不符');
  const target = path.resolve(destination), parent = path.dirname(target);
  if (await fs.realpath(parent) !== parent) reject('REFERENCE_INVALID', '解压目标父目录不得是符号链接');
  await fs.mkdir(target);
  try {
    const listing = await archive({action: 'list', file}, signal);
    await archive({action: 'extract', file, root: target, files: listing.files, existingEmpty: true}, signal);
    return await verifyPackage(target, expectedIdentity);
  } catch (error) {
    await fs.rm(target, {recursive: true, force: true});
    throw error;
  }
}

/** Offline stage only. No editor/runtime IPC, source-image publishing, or media-store writes. */
export async function buildPackage(dynamics, ctx) {
  if (dynamics?.schemaVersion !== 1 || dynamics.stage !== 'dynamics') reject('INPUT_INVALID', '需要04的DynamicsBundle v1');
  for (const key of ['taskId', 'candidateId', 'revision']) if (!ctx?.[key] || ctx[key] !== dynamics[key]) reject('REFERENCE_INVALID', '打包任务与上游身份不符');
  if (ctx.parentRevision !== dynamics.parentRevision) reject('REFERENCE_INVALID', '打包父版本不符');
  if (!['taskId', 'candidateId', 'inputSha256', 'descriptionSha256'].every(key => typeof dynamics[key] === 'string' && dynamics[key].length > 0) ||
      !validRevision(dynamics.revision) || !(dynamics.parentRevision === null || validRevision(dynamics.parentRevision)) ||
      !/^[a-f0-9]{64}$/.test(dynamics.inputSha256) || !/^[a-f0-9]{64}$/.test(dynamics.descriptionSha256)) reject('REFERENCE_INVALID', '上游身份或来源哈希不完整');
  ctx.signal?.throwIfAborted();
  const root = path.resolve(ctx.taskRoot);
  if ((await fs.lstat(root)).isSymbolicLink() || await fs.realpath(root) !== root) reject('REFERENCE_INVALID', '任务根目录必须是无符号链接的真实目录');
  const destination = path.join(root, 'packaging');
  async function loadPublished() {
    const previous = await json(root, 'packaging/stage.json');
    if (!sameIdentity(previous, dynamics)) reject('EXTERNAL_RESULT_UNKNOWN', '已有另一候选打包记录，禁止覆盖');
    if (previous.status === 'completed') {
      await verifyArtifacts(root, previous.artifacts);
      await verifyPackage(path.join(destination, 'content'), identity(previous));
      if(previous.sourcePsdContract!==1||!previous.sourcePsdPath)reject('REFERENCE_INVALID','历史打包记录缺少高清源PSD；保留旧包，不覆盖重建');
      const manifest=await json(destination,'content/manifest.json');
      if(ctx.buildHdPreview&&manifest.preview?.hdContract!==1)reject('REFERENCE_INVALID','历史打包缺少完整高清预览；保留旧包，不覆盖重建');
      if(previous.finalPreviewReview?.status==='passed'&&!manifest.preview?.finalReviewPath)
        reject('REFERENCE_INVALID','打包记录缺少包内同版成片验收');
      for(const [key,role] of [['sourcePsdPath','source_psd'],['sourcePsdReadbackPath','source_psd_readback'],['sourcePsdProvenancePath','source_psd_provenance']])
        if(previous[key]!=='packaging/content/'+manifest[key]||previous.artifacts.filter(a=>a.role===role&&a.path===previous[key]).length!==1)
          reject('REFERENCE_INVALID','高清源PSD阶段入口与包内产物不符');
    }
    return previous;
  }
  try {await fs.lstat(destination);return await loadPublished();}
  catch(error){if(error.code!=='ENOENT')throw error;}
  // A killed local ZIP worker must never leave a half-published final directory.
  const scope=createHash('sha256').update(JSON.stringify(identity(dynamics))).digest('hex');
  const prefix='.packaging-'+scope+'-';
  for(const entry of await fs.readdir(root,{withFileTypes:true})){
    if(!entry.isDirectory()||!entry.name.startsWith(prefix))continue;
    const match=/^(\d+)-[a-zA-Z0-9]{6}$/.exec(entry.name.slice(prefix.length));
    if(!match)continue;
    try{process.kill(Number(match[1]),0);}catch(e){
      if(e.code==='ESRCH')await fs.rm(path.join(root,entry.name),{recursive:true,force:true});
    }
  }
  const directory=await fs.mkdtemp(path.join(root,prefix+process.pid+'-'));
  async function packagedArtifact(relative,role){
    return {...await artifact(directory,relative,role),path:'packaging/'+relative};
  }
  const bundle = {...dynamics, ...identity(dynamics), stage: 'packaging', status: 'blocked',
    artifacts: [...(dynamics.artifacts ?? [])], checks: [...(dynamics.checks ?? [])],
    warnings: [...(dynamics.warnings ?? [])], unresolved: [...(dynamics.unresolved ?? [])], deliveryFiles: []};
  const finish = async () => {
    await writeJson(path.join(directory,'stage.json'), bundle);
    try {await fs.rename(directory,destination);}
    catch(e){
      await fs.rm(directory,{recursive:true,force:true});
      if(e.code==='EEXIST'||e.code==='ENOTEMPTY')return loadPublished();
      throw e;
    }
    await ctx.checkpoint?.({stage: 'packaging', status: bundle.status, bundle}); return bundle;
  };
  if (dynamics.status !== 'completed') {
    bundle.unresolved.push({code: 'DYNAMICS_NOT_READY', message: '04尚未交付完成候选；不复制旧模型替代'});
    return finish();
  }
  try {
    if (dynamics.engineVersion !== '3.6.7') reject('REFERENCE_INVALID', '当前打包规范仅核过固定PSD2Live 3.6.7');
    const items = await verifyArtifacts(root, dynamics.artifacts);
    for (const item of dynamics.artifacts) for (const key of ['taskId', 'candidateId', 'revision']) {
      if (item[key] !== undefined && item[key] !== dynamics[key]) reject('REFERENCE_INVALID', '产物显式身份属于另一候选');
    }
    const required = name => {
      relativePath(name);
      if (!items.has(name)) reject('REFERENCE_INVALID', `关键产物未绑定哈希：${name}`);
      return items.get(name);
    };
    for (const key of ['modelPath', 'projectPath', 'psdPath', 'parameterMapPath', 'dynamicsManifestPath']) required(dynamics[key]);
    if (!dynamics.projectPath.endsWith('.psd2live') || !dynamics.psdPath.endsWith('.psd')) reject('REFERENCE_INVALID', '需要真实原生工程及分层PSD');
    const manifest04 = await json(root, dynamics.dynamicsManifestPath);
    if (!sameIdentity(manifest04, dynamics)) reject('REFERENCE_INVALID', '动态清单身份不符');
    const preview = manifest04.preview;
    if (!preview || preview.kind !== 'parameter-animation') reject('REFERENCE_INVALID', '缺少本候选制作预览及同版绑定，交回04补齐');
    required(preview.videoPath); required(preview.coverPath);
    if (preview.modelSha256 !== items.get(dynamics.modelPath).sha256 ||
        preview.projectSha256 !== items.get(dynamics.projectPath).sha256) reject('REFERENCE_INVALID', '预览绑定了不同模型或工程');
    await verifyPreview(root, preview);
    const model = await inspectModel(root, dynamics.modelPath);
    for (const file of model.files) required(file);
    const actualMap = await json(root, dynamics.parameterMapPath);
    const {expressions, motions, requested, additionalIndexedControls} = await verifyRequestedControls(root,dynamics,actualMap,manifest04,model);
    const underModel = file => `model/${path.posix.relative(model.directory, file)}`;
    for (const control of [...expressions,...motions,...additionalIndexedControls.expressions,...additionalIndexedControls.motions]) control.file = underModel(control.file);
    if(ctx.requireFinalPreviewReview&&!ctx.buildHdPreview)
      reject('FINAL_PREVIEW_REVIEW_INVALID','生产打包缺少最终高清渲染入口');
    let selectedPreview=preview,hd=null,finalReview;
    if(ctx.buildHdPreview) {
      hd=await ctx.buildHdPreview({taskRoot:root,dynamics,manifest:manifest04,signal:ctx.signal});
      if(hd?.schemaVersion!==1||!sameIdentity(hd,dynamics)||hd.kind!=='parameter_playback'||
        hd.width!==1920||hd.height!==1080||hd.fps!==30||!Number.isSafeInteger(hd.frameCount)||hd.frameCount<2||
        !Array.isArray(hd.phases)||!hd.phases.length)reject('REFERENCE_INVALID','高清预览规格或候选身份不符');
      const hdItems=await verifyArtifacts(root,hd.artifacts);
      for(const key of ['videoPath','coverPath','fullBodyPath','facePath','provenancePath'])if(!hdItems.has(hd[key]))reject('REFERENCE_INVALID','高清预览缺少登记附件');
      for(const [name,item] of hdItems) {
        if(items.has(name))reject('REFERENCE_INVALID','高清预览与上游产物路径冲突');
        items.set(name,item);bundle.artifacts.push(item);
      }
      if(ctx.requireFinalPreviewReview) {
        finalReview=await finalPreviewReviewGate(root,dynamics,hd);
        if(finalReview.status!=='passed') {
          const issue=finalReview.status==='failed'
            ?{code:'FINAL_PREVIEW_REVIEW_FAILED',message:'最终成片视觉验收未通过，保留同版 MP4 和失败观察，等待修订。'}
            :{code:'FINAL_PREVIEW_REVIEW_REQUIRED',message:'最终 MP4 已就绪，等待在原速看完整段并记录同版视觉验收。'};
          bundle.finalPreviewReview=finalReview;
          bundle.unresolved.push(issue);
          await fs.rm(directory,{recursive:true,force:true});
          return bundle;
        }
      }
      selectedPreview={...preview,videoPath:hd.videoPath,coverPath:hd.coverPath};
      await verifyPreview(root,selectedPreview);
    }
    const editable = await archive({action: 'project', file: await regular(root, dynamics.projectPath)}, ctx.signal);
    const psd = await archive({action: 'psd', file: await regular(root, dynamics.psdPath)}, ctx.signal);
    if (dynamics.projectId && editable.projectId !== dynamics.projectId) reject('REFERENCE_INVALID', '原生工程projectId与候选不符');
    const rights = publicRights(dynamics.rights), parameterMap = publicMap(actualMap);
    const capability = await inspectLeafCapability({signal: ctx.signal});
    const limits = capability.importLimits;
    const modelBytes = model.files.reduce((sum, file) => sum + items.get(file).bytes, 0);
    const largestFileBytes = Math.max(...model.files.map(file => items.get(file).bytes));
    const importBudget = {scope: 'extracted-model-directory-only', entries: model.files.length, totalBytes: modelBytes,
      largestFileBytes, limits, status: !limits ? 'not_run' :
        model.files.length <= limits.entries && modelBytes <= limits.totalBytes && largestFileBytes <= limits.fileBytes ? 'passed' : 'blocked'};
    if (importBudget.status === 'blocked') reject('LEAF_IMPORT_TOO_LARGE','完整模型超出 VTubeLeaf 1.3.1 解压后导入限制，拆分附件不能解决');
    const content = path.join(directory, 'content'); await fs.mkdir(content);
    const copy = async (source, dest) => {
      ctx.signal?.throwIfAborted(); relativePath(dest);
      await fs.mkdir(path.dirname(path.join(content, dest)), {recursive: true});
      await fs.copyFile(await regular(root, source), path.join(content, dest), fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
      const copied = await artifact(content, dest, 'package-member');
      if (copied.sha256 !== items.get(source).sha256 || copied.bytes !== items.get(source).bytes) reject('REFERENCE_INVALID', '复制过程中源产物发生变化');
    };
    for (const file of model.files) await copy(file, underModel(file));
    const projectPath = `editable/${path.posix.basename(dynamics.projectPath)}`, psdPath = `editable/${path.posix.basename(dynamics.psdPath)}`;
    await copy(dynamics.projectPath, projectPath); await copy(dynamics.psdPath, psdPath);
    const sourcePsd=await packageSourcePsd(root,dynamics,items,content,ctx);
    const videoPath = `preview/${path.posix.basename(selectedPreview.videoPath)}`, coverPath = `preview/${path.posix.basename(selectedPreview.coverPath)}`;
    if (videoPath === coverPath) reject('REFERENCE_INVALID', '视频与封面包内名称冲突');
    await copy(selectedPreview.videoPath, videoPath); await copy(selectedPreview.coverPath, coverPath);
    let hdMetadata={};
    if(hd) {
      const fullBodyPath='preview/full-body.png',facePath='preview/face.png',provenancePath='preview/provenance.json',renderProvenancePath='preview/render-provenance.json';
      if(new Set([videoPath,coverPath,fullBodyPath,facePath,provenancePath,renderProvenancePath]).size!==6)reject('REFERENCE_INVALID','高清预览包内名称冲突');
      await copy(hd.fullBodyPath,fullBodyPath);await copy(hd.facePath,facePath);
      hdMetadata={hdContract:1,width:hd.width,height:hd.height,fps:hd.fps,frameCount:hd.frameCount,phases:hd.phases,fullBodyPath,facePath,provenancePath};
      if(finalReview) {
        const receipt=await json(root,finalReview.receiptPath);
        if(!verifyFinalPreviewReceipt(receipt,dynamics,items.get(hd.videoPath),hd.frameCount/hd.fps))
          reject('FINAL_PREVIEW_REVIEW_FAILED','最终成片视觉验收未通过');
        hdMetadata.finalReviewPath='preview/final-review.json';
        await writeJson(path.join(content,hdMetadata.finalReviewPath),receipt);
        bundle.finalPreviewReview=finalReview;
      }
      const outputs={};for(const [key,relative] of Object.entries({videoPath,coverPath,fullBodyPath,facePath}))outputs[key]={...await artifact(content,relative,'hd-preview-output'),sourceFile:path.posix.basename(hd[key])};
      const originalBytes=await fs.readFile(await regular(root,hd.provenancePath)),original=JSON.parse(originalBytes);
      const originalProvenance={sha256:createHash('sha256').update(originalBytes).digest('hex'),bytes:originalBytes.length};
      if(!sameDigest(originalProvenance,items.get(hd.provenancePath))||original.entry!==path.join(root,dynamics.modelPath))
        reject('REFERENCE_INVALID','高清渲染原件摘要或本机模型入口不符');
      // Keep the private original unchanged; only its absolute entry is remapped for a movable public copy.
      const portable={...original,entry:underModel(dynamics.modelPath)};publicProvenancePaths(portable);
      await writeJson(path.join(content,renderProvenancePath),portable);
      await writeJson(path.join(content,provenancePath),{schemaVersion:1,...identity(dynamics),kind:'parameter_playback',
        width:hd.width,height:hd.height,fps:hd.fps,frameCount:hd.frameCount,phases:hd.phases,
        modelSha256:preview.modelSha256,projectSha256:preview.projectSha256,outputs,
        sourceProvenance:await artifact(content,renderProvenancePath,'hd-preview-render-source'),originalProvenance,
        sourcePathPolicy:'entry-remapped-to-package-model',renderer:original.renderer,engineAssets:original.engineAssets,
        physics:original.physics,phaseFrames:original.phaseFrames,scope:'真实模型参数与物理回放；真人跟随、专业人审和用户认可待验'});
    }
    await fs.mkdir(path.join(content, 'profiles'));
    await writeJson(path.join(content, 'profiles/parameter-map.json'), parameterMap);
    await writeJson(path.join(content, 'profiles/leaf-capability.json'), capability);
    const checks = [...publicChecks(bundle.checks), check('source-hashes-and-closure', 'automated', 'passed'),
      check('native-archive-inventory', 'automated', 'passed', '不是原生重开'),
      check('layered-psd-structure', 'automated', 'passed', '不是图层美术核验'),
      check('source-psd-fidelity','automated','passed','同版源Layout最高像素密度输出，真实逐层读回；低分源只放大，无新增细节'),
      ...(finalReview?[check('final-preview','visual','passed','原速完整成片及逐项观察，绑定视频字节')]:[]),
      check('leaf-import-budget', 'automated', importBudget.status, '仅按源码预算核模型目录，不证明实际加载'),
      ...['visual', 'runtime', 'human', 'user_acceptance'].map(layer => check(layer, layer, 'not_run'))];
    const publicManifest = {schemaVersion: 1, ...identity(dynamics), stage: 'packaging', variant: 'full',
      producer: {packaging: finalReview?'1.2.1':'1.2.0', engineVersion: dynamics.engineVersion, projectId: editable.projectId,
        engineRevision: dynamics.engineRevision ?? null, dynamicsRecipeVersion: manifest04.recipeVersion ?? null},
      modelPath: underModel(dynamics.modelPath), projectPath, psdPath,...sourcePsd,
      preview: {kind: 'parameter-animation', label: '制作预览，非真人跟随', videoPath, coverPath,
        modelSha256: preview.modelSha256, projectSha256: preview.projectSha256,...hdMetadata},
      rights, parameterMap: 'profiles/parameter-map.json', expressions, motions, additionalIndexedControls,
      requirementCoverage: {source: '03参数表和04实际索引；不包含私有用户原文',
        requested, indexedControls: 'passed', mappingKnown: parameterMap.sourceSchemaRecognized, physicalDeformation: 'not_verified', liveTracking: 'not_run'},
      runtimeCompatibility: {runtime: 'VTubeLeaf', reviewedVersion: '1.3.1', candidateLoaded: 'not_run',
        publicControlApi: 'unsupported', baselineRestore: 'unsupported', inputMapping: parameterMap.parameters, importBudget,
        expressions, motions, nativeProfileProvided: false},
      checks, sourceInspection: {editable, psd}, nativePublished: 'not_run', downloadVerified: 'not_run'};
    const controlsGuide = [
      'VTubeLeaf 1.3.1：在导入模型面板选择下载的完整 ZIP（分包交付时选 runtime.zip）。导入会切换当前模型。如使用已解压的目录，入口为 '+publicManifest.modelPath+'，请保留同目录的贴图和其他引用文件。以下控制名来自这个入口。',
      '在表情或快捷键面板按名称操作；“动作号”是软件内的注册项，不是预设键盘按键。记录开始前已开启的项。',
      ...expressions.map(e => e.exclusiveGroup==='emotion' ?
        '表情「'+e.name+'」（动作号 '+e.leafActionId+'）：点一下开启，再点一次只关闭这一项。换情绪时先关闭本次开启的上一个情绪；原有外观开关保持。' :
        '外观「'+e.name+'」（动作号 '+e.leafActionId+'）：开启以切换外观，再点同一项恢复；保留当前情绪。不要点“清空全部表情”。'),
      ...motions.map(m => '动作「'+m.name+'」（动作号 '+m.leafActionId+'）：'+(m.loop?'待机循环。':'选择播放一次，约 '+m.duration+' 秒。'+(m.id==='dyn_wave'?'本次手势在末帧收回；不要选择保持末帧或循环。':''))),
      '恢复：只关闭本次开启的表情和外观；此前已开的保持原状态。播放中的一次性动作可让它播完，或仅停止该动作；不动说话、眨眼和头部跟踪。软件没有供 Agent 远程代为恢复的公开 API。',
    ].join('\n\n');
    const sourceGuide='高清可编辑源 PSD：'+sourcePsd.sourcePsdPath+'，保留原图层像素与布局；低分辨率身体只放大，无新增细节。独立图层及布局：'+sourcePsd.sourceLayoutPath+'，请连同相邻图层目录一起移动。原生工程 PSD：'+psdPath+'，保留引擎导出语义。源PSD普通栅格层，无智能对象；源像素/坐标读回记录在 '+sourcePsd.sourcePsdReadbackPath+'。';
    await fs.writeFile(path.join(content, '使用说明.md'), '# 使用说明\n\n'+controlsGuide+'\n\n制作预览：'+videoPath+'（制作参数动画，非真人跟随）。\n\n工程：'+projectPath+'。'+sourceGuide+'运行包源码能力、文件校验不能代替本机加载和真人连续验证。profiles 内的 JSON 是说明，并非 Leaf 可导入的设置。嘴开合默认用 mouthOpen，MouthForm 默认用 mouthSmile。\n', {flag:'wx'});
    await fs.writeFile(path.join(content, '来源与许可.md'), `# 来源与许可\n\n源图SHA256：${dynamics.inputSha256}\n描述SHA256：${dynamics.descriptionSha256}\n\n用户声明来源：${rights.source}\n许可：${rights.license}\n署名：${rights.attribution}\n允许修改：是；允许再分发：${rights.allowRedistribution ? '是（用户声明）' : '否，仅限声明允许的使用范围'}。声明未做独立法律核验。\n\n后台输出条款未独立核实；PSD2Live、Cubism和运行器各自条款继续适用。本包不统一标注为CC0，不包含参考包资产、原始用户图片或完整请求。\n`, {flag: 'wx'});
    await fs.writeFile(path.join(content, '验证说明.md'), '# 验证说明\n\n自动检查只覆盖文件哈希、model3引用、原生工程归档依赖、分层PSD结构和干净解压。它不能判断人物还原、组合修形、美术质感、物理观感、可播放性或真人延迟。\n\n下载后先用可信PackageBundle中的ZIP哈希和字节数调用verifyPackageArchive，再按manifest.json检查内容。manifest不递归包含自身哈希。最终ZIP的哈希必须来自可信交付记录。发布返回成功、附件卡片可见、实际下载通过分别由00记录。\n', {flag: 'wx'});
    const sourceRoles=new Map([[sourcePsd.sourcePsdPath,'source_psd'],[sourcePsd.sourcePsdReadbackPath,'source_psd_readback'],[sourcePsd.sourcePsdProvenancePath,'source_psd_provenance']]);
    const withSourceRoles=files=>files.map(f=>sourceRoles.has(f.path)?{...f,role:sourceRoles.get(f.path)}:f);
    publicManifest.files = withSourceRoles(await inventory(content));
    await writeJson(path.join(content, 'manifest.json'), publicManifest);
    await verifyPackage(content, identity(dynamics));
    const fullPath = 'packaging/full.zip';
    const fullFile=path.join(directory,'full.zip');
    await archive({action: 'make', root: content, file: fullFile, files: ['manifest.json', ...publicManifest.files.map(f => f.path)]}, ctx.signal);
    const full = await packagedArtifact('full.zip', 'complete-package');
    const clean = path.join(directory, 'verified');
    const verification = await verifyPackageArchive(fullFile, full, clean, {identity: identity(dynamics), signal: ctx.signal});
    if(ctx.reopenEditable) {
      verification.reopenEvidence=await ctx.reopenEditable(clean,await json(clean,'manifest.json'),{signal:ctx.signal});
      verification.nativeReopen=verification.reopenEvidence.status;
      if(verification.nativeReopen!=='passed')reject('CLEAN_REOPEN_FAILED','包内工程未通过空目录重开验证');
      bundle.checks.push(check('native-clean-reopen','automated','passed','包内工程已由制作引擎重开，重新导出的几何和贴图与包内文件一致'));
    }
    await writeJson(path.join(directory, 'verification.json'), verification);
    bundle.deliveryFiles = [full, await packagedArtifact('content/'+coverPath, 'preview-cover'), await packagedArtifact('content/'+videoPath, 'preview-video')];
    // Keep the runtime package standalone. Split only an oversized editable ZIP.
    const distributionLimits = {localMaxBytes:ctx.localAttachmentMaxBytes ?? LOCAL_ATTACHMENT_MAX_BYTES,
      serviceMaxBytes:ctx.serviceMaxBytes ?? null};
    const attachmentBudget = planDelivery([],distributionLimits);
    const limit = Math.min(attachmentBudget.localMaxBytes,attachmentBudget.serviceMaxBytes ?? Infinity);
    if (full.bytes > limit) {
      for (const variant of ['runtime', 'editable-assets']) {
        const subset = path.join(directory, variant); await fs.mkdir(subset);
        const selected = publicManifest.files.filter(f => variant === 'runtime' ? !f.path.startsWith('editable/') : f.path.startsWith('editable/') || !f.path.includes('/'));
        for (const f of selected) {
          await fs.mkdir(path.dirname(path.join(subset, f.path)), {recursive: true});
          await fs.copyFile(path.join(content, f.path), path.join(subset, f.path), fs.constants.COPYFILE_EXCL|fs.constants.COPYFILE_FICLONE);
        }
        const variantNote = variant === 'runtime' ? '这是可独立导入的运行包，model/和制作预览已包含。可编辑工程/PSD在editable-assets.zip或full.zip中。' : '这是可编辑素材包，包含自包含原生工程和分层PSD；运行模型与制作预览在runtime.zip或full.zip中。';
        await fs.writeFile(path.join(subset, '使用说明.md'), '# '+variant+'\n\n'+variantNote+'\n\n'+(variant === 'runtime' ? controlsGuide : '工程：'+projectPath+'。'+sourceGuide)+'\n\n请核对 manifest 中的任务、版本和来源哈希。本候选实际运行、真人跟随及用户认可待验证。\n');
        const m = {...publicManifest, variant, files: withSourceRoles(await inventory(subset))};
        if (variant === 'runtime') {delete m.projectPath; delete m.psdPath;for(const key of Object.keys(sourcePsd))delete m[key];}
        else {delete m.modelPath; delete m.parameterMap; delete m.preview;}
        m.companionFullPackage = {file: 'full.zip', sha256: full.sha256, bytes: full.bytes};
        await writeJson(path.join(subset, 'manifest.json'), m);
        const relative = variant+'.zip',variantFile=path.join(directory,relative);
        await archive({action: 'make', root: subset, file: variantFile, files: ['manifest.json', ...m.files.map(f => f.path)]}, ctx.signal);
        const part = await packagedArtifact(relative, variant === 'runtime' ? 'runtime-package' : 'editable-package');
        await verifyPackageArchive(variantFile, part, path.join(directory, `${variant}-verified`), {identity: identity(dynamics), signal: ctx.signal});
        bundle.deliveryFiles.push(part);
      }
      const editable=bundle.deliveryFiles.find(a=>a.role==='editable-package');
      if(editable.bytes>limit&&bundle.deliveryFiles.every(a=>['complete-package','editable-package'].includes(a.role)||a.bytes<=limit)) {
        const volumes=await makeEditableVolumes(directory,editable,limit,ctx.signal);
        bundle.deliveryFiles.push(...volumes.map(v=>({...v,path:'packaging/'+v.path})));
      }
    }
    bundle.status = 'completed';
    bundle.packagePath = fullPath; bundle.packageManifestPath = 'packaging/content/manifest.json';
    bundle.modelPath = `packaging/content/${publicManifest.modelPath}`;
    bundle.projectPath = `packaging/content/${projectPath}`; bundle.psdPath = `packaging/content/${psdPath}`;
    bundle.sourcePsdContract=sourcePsd.sourcePsdContract;
    if(hd)bundle.hdPreviewContract=1;
    for(const key of ['sourcePsdPath','sourcePsdReadbackPath','sourcePsdProvenancePath'])bundle[key]='packaging/content/'+sourcePsd[key];
    bundle.runtimeCompatibility = publicManifest.runtimeCompatibility;
    bundle.distribution = planDelivery(bundle.deliveryFiles,distributionLimits);
    const eligible=role=>bundle.distribution.files.some(f=>f.role===role && f.status!=='blocked');
    const volumes=bundle.distribution.files.filter(f=>isEditableVolume(f.role));
    const hasEditable=eligible('editable-package')||volumes.length>0&&volumes.every(f=>f.status!=='blocked');
    if (!(eligible('complete-package') || eligible('runtime-package') && hasEditable) || !eligible('preview-video') || !eligible('preview-cover')) {
      bundle.status = 'blocked'; bundle.distribution.nativeDelivery='blocked';
      bundle.unresolved.push({code:'DELIVERY_TOO_LARGE',message:'已保留完整质量的包，但同版运行、编辑或预览附件仍超限；不能声称聊天可下载。'});
    }
    bundle.checks.push(...checks.filter(c => c.name.startsWith('packaging.')), check('clean-extraction', 'automated', 'passed'));
    bundle.warnings.push('仅打包阶段完成：原生加载、真人跟随、用户认可及原生附件下载未通过。');
    if (!parameterMap.sourceSchemaRecognized) bundle.warnings.push('03参数表格式尚未识别；实际输入映射待00适配。');
    for (const file of await inventory(directory)) if (!bundle.artifacts.some(a => a.path === `packaging/${file.path}`)) bundle.artifacts.push({...file, path: `packaging/${file.path}`});
    for(const [key,role] of [['sourcePsdPath','source_psd'],['sourcePsdReadbackPath','source_psd_readback'],['sourcePsdProvenancePath','source_psd_provenance']])bundle.artifacts.find(a=>a.path===bundle[key]).role=role;
    await ctx.progress?.({stage: 'packaging', step: 'clean-extraction-verified'});
  } catch (error) {
    bundle.status = 'failed';
    bundle.deliveryFiles = [];
    bundle.unresolved.push({code: error.code ?? 'PACKAGING_FAILED', message: error.message});
    bundle.checks.push(check('integrity', 'automated', 'failed'));
  }
  return finish();
}

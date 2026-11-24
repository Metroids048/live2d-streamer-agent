import * as fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {BRIEF_SCHEMA,ORIGINAL_BRIEF_SCHEMA,BRIEF_INSTRUCTIONS,validateBrief,finalizeBrief} from './brief.mjs';

export {BRIEF_SCHEMA,BRIEF_INSTRUCTIONS,validateBrief};
export const INTAKE_VERSION='1.0.0';
export const INPUT_LIMITS=Object.freeze({maxBytes:16*1024*1024,maxSide:8192,maxPixels:16_000_000});
const exec=promisify(execFile),decoder=fileURLToPath(new URL('./decode.py',import.meta.url));
const sha=b=>createHash('sha256').update(b).digest('hex');
const json=b=>JSON.stringify(b,null,2)+'\n';
const inside=(root,p)=>p!==root&&p.startsWith(root+path.sep);
const check=(name,layer,status,note)=>({name,layer,status,...(note?{note}:{})});

class IntakeError extends Error {
  constructor(code,message,status='needs_input') {super(message);this.code=code;this.status=status;}
}
const reject=(...args)=>{throw new IntakeError(...args);};
function canonical(value) {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value&&typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
function validateContext(ctx) {
  for(const key of ['taskId','candidateId']) if(typeof ctx?.[key]!=='string'||!ctx[key].length||ctx[key].length>128) throw new TypeError(`ctx.${key} is required`);
  if(!['string','number'].includes(typeof ctx.revision)||!String(ctx.revision).length) throw new TypeError('ctx.revision is required');
  if(typeof ctx.taskRoot!=='string'||!path.isAbsolute(ctx.taskRoot)) throw new TypeError('ctx.taskRoot must be absolute');
}
function validateRequest(request) {
  if(!request||typeof request!=='object'||Array.isArray(request)) reject('INPUT_INVALID','需要一张当前会话图片附件和自然语言描述。');
  if(Array.isArray(request.imageRef)) reject('IMAGE_SELECTION_REQUIRED','收到多张图片，请明确本次制作使用哪一张。');
  if(!request.imageRef) reject('IMAGE_REQUIRED','请附上一张角色图片；无需提供 PSD 或手拆图。');
  if(typeof request.imageRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(request.imageRef)) reject('IMAGE_REFERENCE_INVALID','图片必须来自当前会话附件，不能使用正文路径或 URL。');
  if(Object.keys(request).some(k=>!['imageRef','description','rights'].includes(k))) reject('INPUT_INVALID','单图制作只接受图片附件、自然描述与来源授权；不能混入 material_id 或操作命令字段。');
  if(typeof request.description!=='string'||!request.description.trim()||request.description.length>20000) reject('DESCRIPTION_REQUIRED','请用一段自然语言说明想制作的角色和效果，长度不超过 20000 字符。');
}
function validateRights(rights) {
  if(!rights||typeof rights!=='object'||Array.isArray(rights)) reject('RIGHTS_UNRESOLVED','请说明图片来源，并声明允许制作、修改和用于本次直播用途。');
  if(Object.keys(rights).some(k=>!['source','license','allowDerivatives','allowRedistribution','attribution','userDeclared'].includes(k))) reject('RIGHTS_UNRESOLVED','授权记录含不支持的字段，请保留来源、许可及修改/再分发声明。');
  if(typeof rights.source!=='string'||!rights.source.trim()||rights.source.length>4000||typeof rights.license!=='string'||!rights.license.trim()||rights.license.length>4000) reject('RIGHTS_UNRESOLVED','请保留图片实际来源和许可/本人授权说明。');
  if(rights.allowDerivatives!==true) reject('RIGHTS_UNRESOLVED','本次制作需要允许修改和补绘，现有声明尚未允许。');
  if(typeof rights.allowRedistribution!=='boolean') reject('RIGHTS_UNRESOLVED','请明确是否允许再分发；不允许公开再分发也可以制作本人使用的私有包。');
  if(rights.userDeclared!==undefined&&rights.userDeclared!==true) reject('RIGHTS_UNRESOLVED','授权声明尚未确认，不能代替用户确认权限。');
  if(rights.attribution!==undefined&&(typeof rights.attribution!=='string'||rights.attribution.length>4000)) reject('RIGHTS_UNRESOLVED','署名要求必须是文本。');
  return {...rights,userDeclared:true,verification:'user_declared',publicRedistributionAllowed:rights.allowRedistribution};
}
async function readControlled(root,file,maxBytes=INPUT_LIMITS.maxBytes) {
  if(typeof file!=='string'||!file.length) reject('IMAGE_REFERENCE_INVALID','附件读取器未返回有效文件。');
  if(!path.isAbsolute(file)&&file.split(/[\\/]/).some(s=>s==='..')) reject('IMAGE_REFERENCE_INVALID','附件路径不得越过任务目录。');
  const resolved=path.resolve(root,file);
  if(!inside(root,resolved)) reject('IMAGE_REFERENCE_INVALID','附件必须先由受控读取器复制到本任务目录。');
  const real=await fs.realpath(resolved);
  if(real!==resolved||!inside(root,real)) reject('IMAGE_REFERENCE_INVALID','附件包含链接或不属于本任务。');
  const handle=await fs.open(real,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile()||stat.size===0) reject('IMAGE_INVALID','图片文件为空或不是普通文件。');
    if(stat.size>maxBytes) reject('IMAGE_TOO_LARGE',`图片超过 ${maxBytes} 字节；请提供体积合适的原图，系统不会擅自裁剪。`);
    const bytes=await handle.readFile();
    if(bytes.length!==stat.size||bytes.length>maxBytes) reject('IMAGE_CHANGED','读取期间图片内容发生变化。');
    return {bytes,file:real};
  } finally {await handle.close();}
}
async function ownDirectory(root) {
  const dir=path.join(root,'intake');
  try {await fs.mkdir(dir,{mode:0o700});} catch(e) {if(e.code!=='EEXIST') throw e;}
  if(await fs.realpath(dir)!==dir||!(await fs.lstat(dir)).isDirectory()) reject('OUTPUT_INVALID','intake 输出目录包含链接。','blocked');
  return dir;
}
async function readJson(root,file) {
  try {return JSON.parse((await readControlled(root,file,2*1024*1024)).bytes.toString('utf8'));}
  catch(e) {if(e.code==='ENOENT') return null;throw e;}
}
async function writeImmutable(root,file,bytes) {
  const target=path.join(root,'intake',file);
  try {await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});}
  catch(e) {
    if(e.code!=='EEXIST') throw e;
    if(!bytes.equals((await readControlled(root,target,Math.max(bytes.length,1))).bytes)) reject('REVISION_CONFLICT','同一修订已有不同输入或产物，请使用新的 taskRoot/revision，保留父版。','blocked');
  }
  return {role:'',path:`intake/${file}`,sha256:sha(bytes),bytes:bytes.length};
}
async function writeState(root,name,value) {
  const file=path.join(root,'intake',name),tmp=file+'.'+randomUUID()+'.tmp';
  // Refuse a pre-existing symlink instead of following it during replacement.
  try {await readControlled(root,file,2*1024*1024);} catch(e) {if(e.code!=='ENOENT') throw e;}
  try {await fs.writeFile(tmp,json(value),{flag:'wx',mode:0o600});await fs.rename(tmp,file);}
  finally {await fs.rm(tmp,{force:true});}
}
async function artifact(root,role,file) {
  const {bytes}=await readControlled(root,file,128*1024*1024);
  return {role,path:path.relative(root,file).split(path.sep).join('/'),sha256:sha(bytes),bytes:bytes.length};
}
function sniff(bytes) {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return {extension:'png',mimeType:'image/png'};
  if(bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff) return {extension:'jpg',mimeType:'image/jpeg'};
  reject('IMAGE_FORMAT_UNSUPPORTED','实际文件不是支持的 PNG/JPEG 图片。');
}
async function decode(root,source,signal) {
  const temp=path.join(root,'intake','normalized-'+randomUUID()+'.png');
  try {
    let result;
    try {result=await exec('/usr/bin/python3',[decoder,source,temp],{timeout:30000,maxBuffer:65536,signal});}
    catch(e) {
      if(e.name==='AbortError') reject('CANCELLED','图片处理已取消。','blocked');
      reject('DECODER_UNAVAILABLE','无法运行本机图片解码器；需要 /usr/bin/python3 与已安装的 Pillow。','blocked');
    }
    const info=JSON.parse(result.stdout);
    if(info.error) {
      const messages={
        DECODER_UNAVAILABLE:'本机 Pillow 不可用，尚未进行真实图片解码。',
        IMAGE_DIMENSIONS_EXCEEDED:'源图超过 PSD2Live 画布限制（单边 8192、总计 1600 万像素）；需明确调整尺寸，系统未裁剪。',
        IMAGE_BIT_DEPTH_UNSUPPORTED:'暂不支持该图片位深，请提供 8 位 PNG/JPEG。',
        CMYK_PROFILE_REQUIRED:'CMYK 图片缺少色彩配置，无法可靠转换；请提供带配置的图片或 sRGB 图。',
        ANIMATED_IMAGE_UNSUPPORTED:'请提供一张静态角色图，不能将动画首帧默认为本次输入。',
      };
      reject(info.error,messages[info.error]??'图片无法完整解码或规范化，请提供可读的 PNG/JPEG 原图。',info.error==='DECODER_UNAVAILABLE'?'blocked':'needs_input');
    }
    const bytes=(await readControlled(root,temp,128*1024*1024)).bytes;
    const normalized=await writeImmutable(root,'normalized.png',bytes);normalized.role='normalized_source_image';
    return {info,normalized};
  } finally {await fs.rm(temp,{force:true});}
}

/**
 * Contract 1.0. ctx.resolveImage(ref,{taskRoot,taskId,candidateId,revision,signal})
 * must bind the current session, COPY bytes under taskRoot, then return {path,...}.
 * ctx.describeImage receives the frozen request plus outputSchema/instructions/
 * operationKey. Its return value is exactly BRIEF_SCHEMA. It must not resubmit
 * after an uncertain error; the module persists such operations for 00 recovery.
 * ctx.recoverDescription({...sameRequest,operation}) only queries that original
 * call: return its BRIEF_SCHEMA response, or null/undefined while unavailable.
 */
export async function prepareInput(request,ctx) {
  validateContext(ctx);
  const bundle={schemaVersion:1,taskId:ctx.taskId,candidateId:ctx.candidateId,revision:ctx.revision,parentRevision:ctx.parentRevision??null,
    inputSha256:null,descriptionSha256:null,stage:'intake',status:'failed',artifacts:[],checks:[],warnings:[],unresolved:[],sourceImage:null,brief:null,rights:null};
  let root,lock,lockFile,canPersist=false;
  const persist=async()=>{if(canPersist) await writeState(root,'stage.json',bundle);return bundle;};
  try {
    validateRequest(request);
    bundle.descriptionSha256=sha(request.description);
    bundle.rights=validateRights(request.rights);
    ctx.signal?.throwIfAborted();
    root=await fs.realpath(ctx.taskRoot);
    if(ctx.root) {
      const project=await fs.realpath(ctx.root);
      if(!inside(project,root)) reject('TASK_ROOT_INVALID','任务输出目录必须属于本项目。','blocked');
    }
    if(root!==path.resolve(ctx.taskRoot)) reject('TASK_ROOT_INVALID','任务根目录不能经过链接。','blocked');
    await ownDirectory(root);
    lockFile=path.join(root,'intake','.lock');
    try {lock=await fs.open(lockFile,'wx',0o600);await lock.writeFile(String(process.pid));}
    catch(e) {if(e.code==='EEXIST') reject('INTAKE_BUSY','该修订正在处理，或上次中断遗留锁；先核实原任务，不重复接单。','blocked');throw e;}
    if(typeof ctx.resolveImage!=='function') reject('ATTACHMENT_RESOLVER_UNAVAILABLE','原生附件读取器未接入，不能从正文读取任意本地图片。','blocked');
    let resolved;
    try {resolved=await ctx.resolveImage(request.imageRef,{taskRoot:root,taskId:ctx.taskId,candidateId:ctx.candidateId,revision:ctx.revision,parentRevision:ctx.parentRevision??null,signal:ctx.signal});}
    catch(e) {
      if(e.code==='EEXIST') reject('ATTACHMENT_RESOLVER_CONFLICT','附件读取器遇到已有任务文件；请由 00 核对同哈希复用，保留原输入，不要要求用户重传。','blocked');
      reject(e.code==='SESSION_MISMATCH'?'SESSION_MISMATCH':'IMAGE_REFERENCE_INVALID','附件不属于当前会话/任务，已失效或尚未复制到任务目录。');
    }
    const source=await readControlled(root,resolved?.path);
    if(['reference_only','restricted_reference'].includes(resolved.source)) reject('RIGHTS_UNRESOLVED','该图片被登记为受限参考，不能作为本次补绘制作的生产源图。');
    const format=sniff(source.bytes);
    bundle.inputSha256=sha(source.bytes);
    if(resolved.sha256&&resolved.sha256!==bundle.inputSha256) reject('IMAGE_CHANGED','附件哈希与受控读取器登记值不符。');
    if(resolved.mimeType&&resolved.mimeType!==format.mimeType) reject('IMAGE_MIME_MISMATCH','附件 MIME 与实际图片格式不一致。');
    bundle.checks.push(check('attachment_containment_and_hash','automated','passed','会话归属由注入读取器负责；本模块已复核任务目录、链接与实际字节。'));
    const requestKey=sha(canonical({version:INTAKE_VERSION,taskId:ctx.taskId,candidateId:ctx.candidateId,revision:ctx.revision,parentRevision:ctx.parentRevision??null,inputSha256:bundle.inputSha256,description:request.description,rights:bundle.rights}));
    const previous=await readJson(root,'intake/request-key.json');
    if(previous&&previous.requestKey!==requestKey) reject('REVISION_CONFLICT','源图、描述、授权或候选身份已改变，请创建新修订并保留父版。','blocked');
    canPersist=true;
    await writeImmutable(root,'request-key.json',Buffer.from(json({requestKey})));
    await writeImmutable(root,'private-request.json',Buffer.from(canonical({description:request.description,rights:bundle.rights,inputSha256:bundle.inputSha256,descriptionSha256:bundle.descriptionSha256})+'\n'));
    const original=await writeImmutable(root,'source.'+format.extension,source.bytes);original.role='private_original_image';
    bundle.artifacts.push(original);
    const extension=path.extname(source.file).toLowerCase();
    if(extension&&!(['.png'].includes(extension)&&format.extension==='png'||['.jpg','.jpeg'].includes(extension)&&format.extension==='jpg')) bundle.warnings.push('源文件扩展名与解码格式不同，已按真实字节识别并保留原始哈希。');
    let normalizedInfo=await readJson(root,'intake/normalization.json'),normalized;
    if(normalizedInfo) {
      normalized=await artifact(root,'normalized_source_image',path.join(root,'intake/normalized.png'));
      if(normalized.sha256!==normalizedInfo.normalizedSha256||normalizedInfo.inputSha256!==bundle.inputSha256) reject('CACHE_CHANGED','已规范化图像被修改，不能复用旧视觉判断。','blocked');
    } else {
      const decoded=await decode(root,path.join(root,original.path),ctx.signal);
      normalized=decoded.normalized;
      normalizedInfo={...decoded.info,inputSha256:bundle.inputSha256,normalizedSha256:normalized.sha256};
      await writeImmutable(root,'normalization.json',Buffer.from(json(normalizedInfo)));
    }
    bundle.artifacts.push(normalized);
    bundle.sourceImage={path:normalized.path,mimeType:'image/png',width:normalizedInfo.width,height:normalizedInfo.height,orientation:1,hasAlpha:normalizedInfo.hasAlpha,sha256:normalized.sha256,pixelSha256:normalizedInfo.pixelSha256};
    bundle.imageNormalization=normalizedInfo;
    bundle.checks.push(check('full_image_decode_and_normalize','automated','passed',`${normalizedInfo.decoder.name} ${normalizedInfo.decoder.version}; EXIF/ICC规范化，不裁剪、不缩放。`));
    bundle.checks.push(check('rights_declaration','automated','passed','仅校验用户声明字段，不代表平台已核验版权；公开再分发权限单独保留。'));
    const provenance={schemaVersion:1,inputSha256:bundle.inputSha256,normalizedSha256:normalized.sha256,pixelSha256:normalizedInfo.pixelSha256,descriptionSha256:bundle.descriptionSha256,
      image:{mimeType:'image/png',width:normalizedInfo.width,height:normalizedInfo.height,orientation:1,hasAlpha:normalizedInfo.hasAlpha},rights:bundle.rights,conversions:normalizedInfo.conversions};
    const provenanceArtifact=await writeImmutable(root,'public-provenance.json',Buffer.from(canonical(provenance)+'\n'));provenanceArtifact.role='input_provenance';bundle.artifacts.push(provenanceArtifact);
    if(ctx.normalizeOnly) {
      bundle.status='normalized';
      bundle.checks.push(check('structured_vision_response','visual','not_run','已保留图片及原话，尚未建立结构化制作简报。'));
      return await persist();
    }
    let response=await readJson(root,'intake/vision-response.json');
    let operation=await readJson(root,'intake/analysis-operation.json');
    if(!response) {
      const keyFor=schema=>'intake-vision-'+sha(requestKey+':'+normalized.sha256+':'+canonical(schema));
      const outputSchema=operation?.operationKey===keyFor(ORIGINAL_BRIEF_SCHEMA)?ORIGINAL_BRIEF_SCHEMA:BRIEF_SCHEMA;
      const operationKey=keyFor(outputSchema);
      const pending={operationKey,status:'submitted',inputSha256:bundle.inputSha256,descriptionSha256:bundle.descriptionSha256,normalizedSha256:normalized.sha256};
      if(operation&&['operationKey','inputSha256','descriptionSha256','normalizedSha256'].some(k=>operation[k]!==pending[k])) reject('CACHE_CHANGED','原视觉调用记录与当前图片/原文不匹配，不能查询或复用。','blocked');
      const visualRequest={schemaVersion:1,image:{path:path.join(root,normalized.path),mimeType:'image/png',width:normalizedInfo.width,height:normalizedInfo.height,sha256:normalized.sha256},
        description:request.description,descriptionSha256:bundle.descriptionSha256,inputSha256:bundle.inputSha256,taskId:ctx.taskId,candidateId:ctx.candidateId,revision:ctx.revision,signal:ctx.signal,
        operationKey,outputSchema,instructions:BRIEF_INSTRUCTIONS};
      const revalidate=operation?.status==='invalid'&&operation.validationErrors?.length===1&&
        operation.validationErrors[0]==='brief: image preservation has no matching observation';
      if(operation&&(['submitted','unknown'].includes(operation.status)||revalidate)) {
        bundle.operation=operation;
        if(typeof ctx.recoverDescription==='function') {
          try {response=await ctx.recoverDescription({...visualRequest,operation:{...operation}});}
          catch {response=null;}
        }
        if(response===null||response===undefined) {
          if(revalidate)reject('BRIEF_INVALID','未取得可重新校验的原视觉回执。','blocked');
          reject('EXTERNAL_RESULT_UNKNOWN','此前视觉调用尚无可恢复结果，请按原 operationKey 继续查询，不能盲目重交。','awaiting_external_result');
        }
      } else {
        if(operation?.status==='invalid') reject('BRIEF_INVALID','此前视觉返回未通过严格校验；需修正后台后使用新修订，不重复评分。','blocked');
        if(operation&&operation.status!=='not_submitted') reject('CACHE_CHANGED','视觉调用已有终态或记录不完整，但响应文件缺失；不能重新提交。','blocked');
        if(typeof ctx.describeImage!=='function') reject('BACKEND_UNAVAILABLE','尚未接入 Codex 结构化视觉后台，无法确认人物外观和实际画面范围。','blocked');
        await writeState(root,'analysis-operation.json',pending);
        await ctx.checkpoint?.({stage:'intake',operation:pending});
        await ctx.progress?.({stage:'intake',message:'图片已真实解码，正在整理图中人物和用户制作需求。'});
        try {response=await ctx.describeImage(visualRequest);}
        catch(e) {
          const unavailable=e.code==='BACKEND_UNAVAILABLE';
          const state={...pending,status:unavailable?'not_submitted':'unknown'};
          await writeState(root,'analysis-operation.json',state);bundle.operation=state;
          reject(unavailable?'BACKEND_UNAVAILABLE':'EXTERNAL_RESULT_UNKNOWN',unavailable?'Codex 视觉后台尚不可用，未发起分析。':'视觉调用中断且结果未知，需查询原 operationKey 后恢复，未自动重试。',unavailable?'blocked':'awaiting_external_result');
        }
      }
      const errors=validateBrief(response,request.description,bundle.inputSha256,bundle.descriptionSha256);
      if(errors.length) {
        const invalid={...pending,status:'invalid',validationErrors:errors};
        await writeState(root,'analysis-operation.json',invalid);
        if(bundle.operation) bundle.operation=invalid;
        bundle.validationErrors=errors;
        reject('BRIEF_INVALID','视觉返回与原文/图片不一致、缺字段或越过支持范围；不能将其当作已理解需求。','blocked');
      }
      await writeImmutable(root,'vision-response.json',Buffer.from(json(response)));
      operation={...pending,status:'completed'};
      await writeState(root,'analysis-operation.json',operation);
    }
    const errors=validateBrief(response,request.description,bundle.inputSha256,bundle.descriptionSha256);
    if(errors.length) reject('BRIEF_INVALID','已保存视觉简报与当前输入不符，不能复用。','blocked');
    if(operation?.status==='completed') bundle.operation={...operation};
    const finalized=finalizeBrief(response,{streamerPresets:/常用动作和表情/u.test(request.description)});
    bundle.brief=finalized.brief;bundle.unresolved.push(...finalized.issues);
    for(const x of bundle.brief.deferredRequirements??[]) bundle.checks.push(check('live2d_delivery_compatibility','runtime','not_run',[x.question,...x.unsupported.map(u=>`${u.request}：${u.reason}`)].join('；')));
    bundle.checks.push(check('structured_vision_response','automated','passed','注入 describeImage 已返回结构与来源绑定有效的简报；不代表艺术质量或人审。'));
    bundle.checks.push(check('character_visual_quality','visual','not_run','制作视觉质量不由输入简报判定。'));
    bundle.checks.push(check('brief_schema_and_source_quotes','automated','passed'));
    for(const layer of ['runtime','human','user_acceptance']) bundle.checks.push(check('downstream_acceptance',layer,'not_run','本模块未执行建模、运行器、真人跟随或用户认可。'));
    bundle.status=bundle.unresolved.length?'needs_input':'completed';
    return await persist();
  } catch(e) {
    const known=e instanceof IntakeError;
    const code=known?e.code:e.name==='AbortError'?'CANCELLED':'INTAKE_INTERNAL';
    const message=known?e.message:code==='CANCELLED'?'输入处理已取消。':'输入处理未完成；请由 00 核查任务文件和本机解码环境。';
    bundle.status=known?e.status:'blocked';bundle.error={code,message,retryable:false};
    bundle.unresolved.push({code,message});
    if(!bundle.checks.some(c=>c.name==='structured_vision_response')) bundle.checks.push(check('structured_vision_response','visual','blocked','未取得并验证可用视觉简报。'));
    if(canPersist) await persist();
    return bundle;
  } finally {
    if(lock) {await lock.close();await fs.rm(lockFile,{force:true});}
  }
}

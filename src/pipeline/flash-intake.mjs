import path from 'node:path';
import {open, mkdir, lstat, realpath, readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {safePath,readJson,writeJson,sha256} from '../artwork/files.mjs';
import {directRequest} from '../artwork/see-through.mjs';

const ORIGIN='https://www.runninghub.cn', PREVIEW='/openapi/v2/price-preview/seedream-v5-flash/layer-decomposition';
const CDN=new Set(['rh-images.xiaoyaoyou.com','rh-images-1252422369.cos.ap-beijing.myqcloud.com','rh-images-switch-1252422369.cos.ap-guangzhou.myqcloud.com']);
const HASH=/^[a-f0-9]{64}$/, MAX_IMAGES=17, MAX_BYTES=8*1024*1024;
const blocked=(code,message,extra={})=>({budgetAuthorized:false,blocked:{code,message,...extra}});

function validUploadUrl(s) {
  if(typeof s!=='string'||s.length>8192||/[\s\\]/.test(s))return false;
  try {const u=new URL(s);return u.protocol==='https:'&&CDN.has(u.hostname)&&!u.port&&!u.hash&&!u.username&&!u.password&&u.pathname!=='/';}
  catch{return false;}
}
function scope(job,input) {
  return {taskId:job.id,candidateId:job.candidateId,revision:job.revision,inputSha256:input.inputSha256,
    uploadedSha256:input.sourceImage.sha256,descriptionSha256:input.descriptionSha256};
}
function layerPrompt(input) {
  let prompt='将这张角色图拆成可用于 Live2D 的透明部件，保留原图的构图、脸型、发型、服装和原画坐标。分离脸底、前后发、双眉、左右眼皮、眼白和虹膜、鼻、上下嘴唇与口腔、颈肩、躯干和配饰；补全被遮挡的皮肤、发束和衣料。';
  if(input.brief?.intent?.actions?.some(a=>a.id==='wave'))prompt+='将打招呼的一侧袖口、手臂和手部与躯干分离，保留放下的原画状态。';
  if(input.brief?.intent?.clothingVariants?.some(a=>a.id==='chest_bow'))prompt+='单独分离胸前蝴蝶结，补全摘下后露出的相邻衣料。';
  return prompt;
}
async function stateDir(root,job,correction) {
  const identity=sha256(JSON.stringify([job.id,job.candidateId,job.revision,...(correction?['public-fetch-1013',correction.failedOperationKey]:[])]));
  let dir=await realpath(root);
  for(const name of ['.local','flash-intake',identity]){
    dir=path.join(dir,name);
    try{await mkdir(dir,{mode:0o700});}catch(e){if(e.code!=='EEXIST')throw e;}
    if(!(await lstat(dir)).isDirectory()||await realpath(dir)!==dir)throw new Error('FLASH_PRIVATE_PATH_INVALID');
  }
  return dir;
}
async function claim(dir,file,value) {
  let fd;
  try{fd=await open(await safePath(dir,file),'wx',0o600);await fd.writeFile(JSON.stringify(value));await fd.sync();return true;}
  catch(e){if(e.code==='EEXIST')return false;throw e;}finally{await fd?.close();}
}
function unitFen(n) {
  const raw=String(n);
  if(typeof n!=='number'||!/^\d{1,6}(?:\.\d{1,2})?$/.test(raw))return null;
  const [yuan,cent='']=raw.split('.');return Number(yuan)*100+Number(cent.padEnd(2,'0'));
}
function quoteId(q) {
  return sha256(JSON.stringify([q.scope,q.paramsSha256,q.responseSha256,q.estimatedPrice,q.currency,q.unit]));
}
export function validateUploadedFlashQuote(q,inputSha256) {
  const p=q?.params;
  if(q?.source!=='task_upload'||q.host!=='www.runninghub.cn'||q.path!==PREVIEW||q.httpStatus!==200||q.errorCode!==''||
     !HASH.test(inputSha256)||q.inputSha256!==inputSha256||q.scope?.inputSha256!==inputSha256||!HASH.test(q.scope?.uploadedSha256)||
     !HASH.test(q.responseSha256)||q.quoteId!==quoteId(q)||unitFen(q.estimatedPrice)===null||q.currency!=='CNY'||q.unit!=='output_image'||
     !p||Object.keys(p).length!==4||!validUploadUrl(p.imageUrl)||typeof p.prompt!=='string'||p.prompt.length>2000||
     p.resolution!=='auto'||p.outputFormat!=='png'||sha256(JSON.stringify(p))!==q.paramsSha256)throw new Error('FLASH_QUOTE_MISMATCH');
  return {body:p,inputSha256,uploadedSha256:q.scope.uploadedSha256,paramsSha256:q.paramsSha256};
}
async function post(request,endpoint,apiKey,body,contentType) {
  const signal=AbortSignal.timeout(45000);
  const res=await request(ORIGIN+endpoint,{method:'POST',signal,timeoutMs:45000,headers:{Authorization:'Bearer '+apiKey,'Content-Type':contentType,'Content-Length':String(body.length)},body});
  let size=0;const chunks=[];
  try{for await(const chunk of res.body){const b=Buffer.from(chunk);size+=b.length;if(size>128*1024)throw new Error('FLASH_RESPONSE_LIMIT');chunks.push(b);}}
  finally{res.body.destroy?.();}
  const bytes=Buffer.concat(chunks);
  if(res.status!==200)throw Object.assign(new Error('FLASH_HTTP_ERROR'),{httpStatus:res.status});
  return {data:JSON.parse(bytes),responseSha256:sha256(bytes)};
}
function summarize(q) {
  const unit=unitFen(q.estimatedPrice),comparable=q.currency==='CNY'&&unit!==null&&q.unit==='output_image';
  return {quoteId:q.quoteId,currency:q.currency,estimatedPrice:q.estimatedPrice,billingUnit:q.unit,
    ...(comparable?{unitFen:unit,maxOutputImages:MAX_IMAGES,estimatedTotalFen:unit*MAX_IMAGES}:{}),providerHardCapVerified:false};
}
function withinPolicy(q,p) {
  return Number.isInteger(q.estimatedTotalFen)&&[
    [p?.maxUnitFen,q.unitFen],[p?.maxEstimatedTotalFen,q.estimatedTotalFen]
  ].every(([limit,value])=>limit===undefined||Number.isSafeInteger(limit)&&limit>=0&&value<=limit);
}
function originalOrUnknown(phase) {
  return blocked('FLASH_'+phase.toUpperCase()+'_RECEIPT_UNKNOWN','原任务的'+(phase==='upload'?'上传':'报价')+'回执未确认。请核对供应商原记录；本任务不会再次提交，也没有提交付费生成。');
}
function accessDenied(id,status) {
  return blocked('FLASH_BACKEND_ACCESS_DENIED','RunningHub 已拒绝本次请求（HTTP '+status+'）。请操作者修正后台凭据或权限，再在本会话发送 /avatarupload '+id+' 继续。已收到的上传或报价会复用。');
}
async function beginPost(dir,phase,identity,consentId,jobId) {
  const denial=await readJson(dir,phase+'-denial.json');
  if(denial&&denial.consentId===consentId)return {stop:accessDenied(jobId,denial.httpStatus)};
  const attempt=(denial?.attempt??0)+1;
  if(!await claim(dir,phase+'-intent-'+attempt+'.json',{identity,attempt}))return {stop:originalOrUnknown(phase)};
  return {attempt};
}
async function postFailure(dir,phase,e,attempt,consentId,id) {
  if(e.httpStatus!==401&&e.httpStatus!==403)return originalOrUnknown(phase);
  // Only a definitive provider denial permits another attempt, after fresh user consent.
  await writeJson(dir,phase+'-denial.json',{httpStatus:e.httpStatus,attempt,consentId});
  return accessDenied(id,e.httpStatus);
}

// A 200 with a different provider schema still has a receipt. Keep the useful
// wire shape in private storage, without echoing credentials or response text.
async function recordResponse(dir,phase,attempt,{data,responseSha256}) {
  const keys=o=>o&&typeof o==='object'?Object.keys(o).filter(k=>/^[a-zA-Z_][a-zA-Z_0-9]{0,48}$/.test(k)).slice(0,40):[];
  const scalar=v=>typeof v==='number'&&Number.isFinite(v)||typeof v==='string'&&/^(?:[0-9.]{1,20}|image|video|file|CNY)$/.test(v)?v:null;
  const f=data?.data;
  let urlHost=null;
  try {const u=new URL(f?.download_url);if(u.protocol==='https:')urlHost=u.hostname;}catch{}
  await writeJson(dir,phase+'-response-'+attempt+'.json',{responseSha256,fields:keys(data),dataFields:keys(f),
    code:scalar(data?.code),errorCode:scalar(data?.errorCode),fileType:scalar(f?.type),fileSize:scalar(f?.size),urlHost,
    estimatedPrice:scalar(data?.estimatedPrice),currency:scalar(data?.currency)});
}

// Claims are written before any network call. Only private receipts contain a CDN URL.
// Never copy a returned flashQuote into a job snapshot or a delivery artifact.
export async function prepareFlashIntake({root,job,input,policy,apiKey,request=directRequest,operation,correction}) {
  if(!input||input.status!=='completed'||input.rights?.allowDerivatives!==true||input.taskId!==job.id||input.candidateId!==job.candidateId||
     input.revision!==job.revision||!HASH.test(input.inputSha256)||!HASH.test(input.descriptionSha256)||!HASH.test(input.sourceImage?.sha256)||
     input.sourceImage.path!=='intake/normalized.png'||input.sourceImage.mimeType!=='image/png')
    return blocked('FLASH_INPUT_MISMATCH','当前任务、修订和已核准的规范化图像不匹配。');
  const dir=await stateDir(root,job,correction),bound=scope(job,input),identity=sha256(JSON.stringify(bound));
  let q=await readJson(dir,'quote.json');
  if(operation&&!q)return blocked('FLASH_ORIGINAL_RECEIPT_REQUIRED','已有拆分作业但缺原报价回执。请沿原作业身份恢复，保留已有作业。');
  if(q&&(q.quoteId!==quoteId(q)||JSON.stringify(q.scope)!==JSON.stringify(bound)||correction&&q.params?.prompt!==correction.original.body.prompt))
    return blocked('FLASH_QUOTE_MISMATCH','保存的报价与当前输入和候选不一致。');
  if(!q) {
    if(policy?.allowUploadForQuote!==true)return blocked('FLASH_UPLOAD_POLICY_REQUIRED','当前后台尚未启用本地图片传图报价。请由操作者启用 RunningHub 传图报价后继续原任务。');
    const consent=correction?{identity,id:correction.failedOperationKey}:await readJson(dir,'consent.json');
    if(consent?.identity!==identity)return blocked('FLASH_UPLOAD_CONSENT_REQUIRED',
      '为此候选取得报价，需要将这张角色图发送给 RunningHub。允许时在本会话单独发送 /avatarupload '+job.id+'。传图授权只含本任务的上传和报价。');
    if(typeof apiKey!=='string'||!apiKey||apiKey.length>1024||/\s/.test(apiKey))return blocked('BACKEND_AUTH_REQUIRED','请由操作者为制作进程提供 RunningHub 凭据，再继续原任务。');
    let upload=await readJson(dir,'upload.json');
    if(!upload) {
      const image=await safePath(job.output,input.sourceImage.path),stat=await lstat(image);
      if(!stat.isFile()||stat.size>MAX_BYTES||stat.size<8)return blocked('FLASH_INPUT_SIZE','这张图超过当前拆分后台的尺寸限制，或已损坏。');
      const bytes=await readFile(image);
      if(sha256(bytes)!==bound.uploadedSha256||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return blocked('FLASH_INPUT_MISMATCH','规范化图片内容已经变化。');
      const start=await beginPost(dir,'upload',identity,consent.id,job.id);if(start.stop)return start.stop;
      const boundary='avatar-'+randomUUID();
      const body=Buffer.concat([Buffer.from('--'+boundary+'\r\nContent-Disposition: form-data; name="file"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n'),bytes,Buffer.from('\r\n--'+boundary+'--\r\n')]);
      try {
        const response=await post(request,'/openapi/v2/media/upload/binary',apiKey,body,'multipart/form-data; boundary='+boundary);
        await recordResponse(dir,'upload',start.attempt,response);
        const f=response.data?.data;
        if(response.data.code!==0||f?.type!=='image'||String(f.size)!==String(bytes.length)||!validUploadUrl(f.download_url))return originalOrUnknown('upload');
        upload={identity,url:f.download_url,responseSha256:response.responseSha256};await writeJson(dir,'upload.json',upload);
      }catch(e){return postFailure(dir,'upload',e,start.attempt,consent.id,job.id);}
    }
    if(upload.identity!==identity||!validUploadUrl(upload.url))return blocked('FLASH_INPUT_MISMATCH','已上传的图片回执不属于当前输入。');
    const params={imageUrl:upload.url,prompt:correction?.original.body.prompt??layerPrompt(input),resolution:'auto',outputFormat:'png'};
    const body=JSON.stringify(params),paramsSha256=sha256(body);
    const start=await beginPost(dir,'price',paramsSha256,consent.id,job.id);if(start.stop)return start.stop;
    try {
      const {data,responseSha256}=await post(request,PREVIEW,apiKey,Buffer.from(body),'application/json');
      await recordResponse(dir,'price',start.attempt,{data,responseSha256});
      if(data.errorCode!==''||typeof data.estimatedPrice!=='number'||!Number.isFinite(data.estimatedPrice)||data.estimatedPrice<0||!/^([A-Z]{3})$/.test(data.currency))return originalOrUnknown('price');
      const rate=typeof data.priceText==='string'&&data.priceText.match(/^每张\s*[¥￥]\s*(\d+(?:\.\d+)?)\s*\/\s*张$/);
      q={source:'task_upload',host:'www.runninghub.cn',path:PREVIEW,scope:bound,inputSha256:bound.inputSha256,params,paramsSha256,
        httpStatus:200,errorCode:'',responseSha256,estimatedPrice:data.estimatedPrice,currency:data.currency,unit:rate&&Number(rate[1])===data.estimatedPrice?'output_image':'unverified'};
      q.quoteId=quoteId(q);await writeJson(dir,'quote.json',q);
    }catch(e){return postFailure(dir,'price',e,start.attempt,consent.id,job.id);}
  }
  const quote=summarize(q);
  if(operation){
    try{validateUploadedFlashQuote(q,input.inputSha256);}catch{return blocked('FLASH_QUOTE_MISMATCH','原作业的报价回执或身份已变化，请按原作业核对。');}
    return {flashQuote:q,budgetAuthorized:false};
  }
  if(policy?.allowUploadForQuote!==true)return blocked('FLASH_UPLOAD_POLICY_REQUIRED','操作者当前停用了本地图片分层后台；原报价已保留。',{quote});
  if(!withinPolicy(quote,policy))return blocked('FLASH_PRICE_OUT_OF_POLICY',
    'RunningHub 返回的估价为 '+q.estimatedPrice+' '+q.currency+(Number.isInteger(quote.estimatedTotalFen)?'／张，最多 '+MAX_IMAGES+' 张估算 ¥'+(quote.estimatedTotalFen/100).toFixed(2):'，计价依据待核实')+'。当前计价单位或金额超出本地策略；请由操作者核查这份报价再继续。',{quote});
  try{validateUploadedFlashQuote(q,input.inputSha256);}catch{return blocked('FLASH_QUOTE_MISMATCH','原报价的内容或绑定已经变化。');}
  if(correction)return {flashQuote:q,budgetAuthorized:true};
  const approved=await readJson(dir,'approval.json');
  if(approved?.identity!==identity||approved?.quoteId!==quote.quoteId)return blocked('FLASH_QUOTE_APPROVAL_REQUIRED',
    'RunningHub 分层报价为每张 ¥'+q.estimatedPrice.toFixed(2)+'，最多 '+MAX_IMAGES+' 张，估算 ¥'+(quote.estimatedTotalFen/100).toFixed(2)+'，供应商没有保证硬封顶。操作者同意本次报价时在原会话发送 /avatarpay '+job.id+' '+q.quoteId+'。',{quote});
  return {flashQuote:q,budgetAuthorized:true};
}

// Called only by native, user-invoked commands, never by model tool arguments.
export async function approveFlashCommand(maker,ctx,kind) {
  const args=String(ctx.args??'').trim().split(/\s+/),[id,quoteIdArg]=args;
  if(!ctx.isAuthorizedSender||!ctx.sessionId||!ctx.sessionKey?.startsWith('agent:live2d-streamer:')||
     !/^[a-f0-9-]{36}$/.test(id)||!(kind==='upload'&&args.length===1||kind==='pay'&&args.length===2&&HASH.test(quoteIdArg)))
    return {text:'请在原制作会话直接发送工具给出的完整授权命令。'};
  // Match the host's scope precedence. A limited gateway client cannot borrow chat-owner status.
  if(kind==='pay'&&!(Array.isArray(ctx.gatewayClientScopes)?ctx.gatewayClientScopes.some(s=>['operator.approvals','operator.admin'].includes(s)):ctx.senderIsOwner===true))
    return {text:'本命令需要当前会话的网关审批权限或聊天所有者身份。'};
  try {
    await maker.making(id,ctx);
    const job=await maker.store.read('make-'+id);
    const allowed=kind==='upload'?['FLASH_UPLOAD_CONSENT_REQUIRED','FLASH_BACKEND_ACCESS_DENIED']:['FLASH_QUOTE_APPROVAL_REQUIRED'];
    if(job.status!=='blocked'||!allowed.includes(job.error?.code))return {text:'当前候选没有待确认的这项授权。请先查询原任务。'};
    const input=await readJson(job.output,'intake/stage.json');
    if(!input||input.taskId!==id||input.candidateId!==job.candidateId||input.revision!==job.revision||input.status!=='completed')
      return {text:'输入版本与授权请求不一致。'};
    const dir=await stateDir(maker.root,job),bound=scope(job,input),identity=sha256(JSON.stringify(bound));
    if(kind==='pay'){
      const q=await readJson(dir,'quote.json');
      if(!q||q.quoteId!==quoteIdArg||q.quoteId!==job.error.quote?.quoteId||JSON.stringify(q.scope)!==JSON.stringify(bound))
        return {text:'报价 ID 与原候选展示的金额不一致。请查对报价。'};
      validateUploadedFlashQuote(q,input.inputSha256);
      await writeJson(dir,'approval.json',{identity,quoteId:quoteIdArg,confirmedAt:new Date().toISOString()});
    }else await writeJson(dir,'consent.json',{identity,id:randomUUID(),provider:'www.runninghub.cn',confirmedAt:new Date().toISOString()});
    const result=await maker.run('make',{resume_job_id:id},ctx);
    return result.ok?{text:'本次授权已记录，继续查询制作任务 '+id+'。',continueAgent:true}:{text:result.message};
  }catch{return {text:'无法核实原会话、任务和报价，请在原制作会话查询该任务。'};}
}

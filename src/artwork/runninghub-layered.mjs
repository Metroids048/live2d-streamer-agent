import { mkdir, realpath, readFile, open, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sha256, safePath, readJson, writeBound } from './files.mjs';
import { decodePng } from './png.mjs';
import { directRequest } from './see-through.mjs';
import { validateUploadedFlashQuote } from '../pipeline/flash-intake.mjs';

export const RUNNINGHUB_LAYERED_APP='2022230387451236353';
export const FLASH_ROUTE='seedream-v5-flash/layer-decomposition';
const BASE='https://www.runninghub.cn', VERSION='runninghub-app-2022230387451236353-unpinned';
const JOB=/^[0-9]{8,32}$/;
const CDN=['rh-images.xiaoyaoyou.com','rh-images-1252422369.cos.ap-beijing.myqcloud.com','rh-images-switch-1252422369.cos.ap-guangzhou.myqcloud.com'];
const error=code=>new Error(code);
const nonempty=value=>value!==undefined&&value!==null&&value!==''&&value!==0&&value!=='0'&&(!(typeof value==='object')||Object.keys(value).length>0);

// The body used for inference must be byte-identical to the priced body. Credentials
// come only from the worker. A registered public source requires no second upload.
export function flashRequestFromQuote(quote,inputSha256) {
  if(quote?.source==='task_upload')return validateUploadedFlashQuote(quote,inputSha256);
  const p=quote?.params;
  if(!p||quote.host!=='www.runninghub.cn'||quote.path!==`/openapi/v2/price-preview/${FLASH_ROUTE}`||
    quote.httpStatus!==200||quote.errorCode!==''||quote.currency!=='CNY'||quote.estimatedPrice!==0.11||
    !/^[a-f0-9]{64}$/.test(inputSha256)||quote.inputSha256!==inputSha256||
    !['imageUrl','prompt','resolution','outputFormat'].every(k=>typeof p[k]==='string')||
    Object.keys(p).length!==4||p.resolution!=='auto'||p.outputFormat!=='png'||p.prompt.length>2000||
    sha256(JSON.stringify(p))!==quote.paramsSha256)throw error('FLASH_QUOTE_MISMATCH');
  const url=new URL(p.imageUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port)throw error('FLASH_INPUT_URL_INVALID');
  return {body:p,inputSha256,paramsSha256:quote.paramsSha256};
}

/** Official CN app A only. No automatic retry, fallback, model upgrade or paid authorization.
 * recover/query never upload or start inference. A confirmed upload with no inference attempt
 * may be continued by an explicit submit of the SAME operation and input.
 */
export function createRunningHubLayeredBackend({stateDir,apiKey,flashQuote,allowUnpinnedModel=false,budgetAuthorized=false,request=directRequest,layers=4,seed='40081411804039',uploadedInput,timeoutMs=45000,pollIntervalMs=5000,maxInputBytes=8*1024*1024,maxJsonBytes=1024*1024,maxFileBytes=16*1024*1024,maxTotalBytes=64*1024*1024,maxTotalPixels=64*1024*1024,now=Date.now}={}){
  if(typeof stateDir!=='string'||!stateDir)throw error('BACKEND_STATE_DIR_REQUIRED');
  if(apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey||apiKey.length>1024||/[\s\u0000-\u001f]/.test(apiKey)))throw error('BACKEND_AUTH_INVALID');
  if(typeof request!=='function'||typeof now!=='function'||!Number.isInteger(layers)||layers<3||layers>8)throw error('BACKEND_RECIPE_INVALID');
  if(typeof seed==='number'){if(!Number.isSafeInteger(seed)||seed<0)throw error('BACKEND_SEED_INVALID');seed=String(seed);}
  if(typeof seed!=='string'||!/^\d{1,20}$/.test(seed)||BigInt(seed)>18446744073709551615n)throw error('BACKEND_SEED_INVALID');
  seed=BigInt(seed).toString();
  if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>120000||!Number.isInteger(pollIntervalMs)||pollIntervalMs<1000||pollIntervalMs>60000||[maxInputBytes,maxJsonBytes,maxFileBytes,maxTotalBytes,maxTotalPixels].some(n=>!Number.isInteger(n)||n<1)||maxInputBytes>8*1024*1024||maxJsonBytes>2*1024*1024||maxFileBytes>16*1024*1024||maxTotalBytes>96*1024*1024||maxTotalPixels>64*1024*1024)throw error('BACKEND_LIMIT_INVALID');
  const flash=flashQuote&&flashRequestFromQuote(flashQuote,flashQuote.inputSha256);
  const backendId=flash?'runninghub-standard-flash':'runninghub-layered-app';
  const modelVersion=flash?'seedream-v5-flash':VERSION;
  const recipe=flash?{model:modelVersion,submitEndpoint:`/openapi/v2/${FLASH_ROUTE}`,paramsSha256:flash.paramsSha256,
    inputSha256:flash.inputSha256,queryEndpoint:'/openapi/v2/query',clientAutomaticRetry:false,providerHardCostCap:'unverified'}:{webappId:RUNNINGHUB_LAYERED_APP,modelRevision:'unpinned',layers,seed,nodeInputs:[['23','image'],['20','value'],['21','seed']],uploadEndpoint:'/openapi/v2/media/upload/binary',submitEndpoint:'/task/openapi/ai-app/run',queryEndpoint:'/openapi/v2/query',clientAutomaticRetry:false,clientFallback:false,providerRetryControl:'unknown',providerHardCostCap:'unverified'};
  const recipeSha256=sha256(JSON.stringify(recipe));
  let rootPromise;const root=()=>rootPromise??=mkdir(stateDir,{recursive:true}).then(()=>realpath(stateDir));
  const filename=key=>`${sha256(key)}.json`,saved=async key=>readJson(await root(),filename(key));
  const stamp=()=>new Date(now()).toISOString();
  // Critical state and exclusive POST intent both reach fsync before transport is called.
  async function durable(name,value,exclusive=false){
    const target=await safePath(await root(),name),temp=exclusive?target:`${target}.${randomUUID()}.tmp`;let fd;
    try{fd=await open(temp,'wx',0o600);await fd.writeFile(JSON.stringify(value,null,2)+'\n');await fd.sync();await fd.close();fd=null;if(!exclusive)await rename(temp,target);}
    finally{await fd?.close();if(!exclusive)await rm(temp,{force:true});}
  }
  const save=state=>durable(filename(state.operationKey),state);
  async function claim(state,phase){
    try{await durable(`${sha256(state.operationKey)}-${phase}.json`,{operationKey:state.operationKey,cacheKey:state.cacheKey,fingerprint:state.fingerprint,source:state.source,recipeSha256,status:'submitting',phase,createdAt:stamp()},true);return true;}
    catch(e){if(e.code==='EEXIST')return false;throw e;}
  }
  function redact(value,depth=0){
    if(depth>5)return '[TRUNCATED]';
    if(typeof value==='string'){
      if(/^[\s]*[\[{]/.test(value)){try{const parsed=JSON.parse(value);if(parsed&&typeof parsed==='object')return JSON.stringify(redact(parsed,depth+1));}catch{}}
      if(apiKey)for(const key of [apiKey,encodeURIComponent(apiKey)])value=value.split(key).join('[REDACTED]');
      return value.replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi,'[REDACTED_DATA_URI]').replace(/(?:https?|wss?):\/\/[^\s"'<>]+/gi,s=>s.split(/[?#]/)[0]+'[URL_QUERY_REMOVED]').replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [REDACTED]').replace(/(?:api.?key|Rh-Comfy-Auth|authorization|token|cookie|secret|password|signature)["']?\s*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi,'[REDACTED_CREDENTIAL]').slice(0,1600);
    }
    if(Array.isArray(value))return value.slice(0,16).map(v=>redact(v,depth+1));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,24).map(([k,v])=>[redact(k,depth+1),/authorization|api.?key|token|cookie|secret|password|signature|Rh-Comfy-Auth|^headers$|^input$|^body$|url/i.test(k)?'[REDACTED]':redact(v,depth+1)]));
    return value;
  }
  const resultOf=s=>({status:['running','completed','failed','blocked'].includes(s.status)?s.status:'blocked',...(s.jobId?{jobId:s.jobId}:{}),code:s.code||(['unknown','upload_submitting','inference_submitting'].includes(s.status)?'EXTERNAL_RESULT_UNKNOWN':['ready','uploaded'].includes(s.status)?'BACKEND_SUBMISSION_NOT_STARTED':undefined),...(s.note?{note:s.note}:{}),...(s.httpStatus?{httpStatus:s.httpStatus}:{}),...(s.errorType?{errorType:s.errorType}:{})});
  async function stop(s,code,note,status='blocked',extra={}){Object.assign(s,{status,code,note:redact(note),...extra});await save(s);return resultOf(s);}
  const gate=()=>!apiKey?{status:'blocked',code:'BACKEND_AUTH_REQUIRED'}:budgetAuthorized!==true?{status:'blocked',code:'BACKEND_BUDGET_NOT_AUTHORIZED'}:!flash&&allowUnpinnedModel!==true?{status:'blocked',code:'BACKEND_MODEL_UNPINNED'}:null;
  async function receive(url,{method='GET',body,contentType='application/json',signal,authenticated=true,limit=maxJsonBytes}={}){
    if(signal?.aborted)throw error('BACKEND_CANCELLED');
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    const timer=setTimeout(()=>controller.abort(error('BACKEND_REQUEST_TIMEOUT')),timeoutMs);let response;
    const abort=()=>response?.body?.destroy?.(error('BACKEND_REQUEST_INTERRUPTED'));combined.addEventListener('abort',abort,{once:true});
    try{
      const headers=authenticated?{Authorization:`Bearer ${apiKey}`}:{ };
      if(body)Object.assign(headers,{'Content-Type':contentType,'Content-Length':String(body.length)});
      response=await request(url,{method,headers,body,signal:combined,timeoutMs});
      const chunks=[];let size=0;
      for await(const chunk of response.body){if(combined.aborted)throw error('BACKEND_REQUEST_INTERRUPTED');const b=Buffer.from(chunk);size+=b.length;if(size>limit)throw error('BACKEND_RESPONSE_TOO_LARGE');chunks.push(b);}
      if(combined.aborted)throw error('BACKEND_REQUEST_INTERRUPTED');
      return {httpStatus:response.status,bytes:Buffer.concat(chunks)};
    }finally{clearTimeout(timer);combined.removeEventListener('abort',abort);response?.body?.destroy?.();}
  }
  function inspect(wire){
    let data;try{data=JSON.parse(wire.bytes.toString('utf8'));}catch{}
    const receipt={httpStatus:wire.httpStatus,bodyBytes:wire.bytes.length,bodySha256:sha256(wire.bytes),receivedAt:stamp()};
    for(const key of ['code','msg','message','status','errorCode','errorMessage','failedReason','promptTips'])if(data?.[key]!==undefined)receipt[key]=redact(data[key]);
    return {data,receipt};
  }
  function validFile(value){return typeof value==='string'&&value.length<512&&/^[A-Za-z0-9_/-]+(?:[.][A-Za-z0-9_-]+)*\.png$/.test(value)&&!value.startsWith('/')&&!value.includes('..')&&!value.includes('//')&&!(apiKey&&value.includes(apiKey));}
  function confirmedUpload(value,source){
    if(!value||!validFile(value.fileName)||value.inputSha256!==source.sha256)throw error('BACKEND_UPLOAD_IDENTITY_MISMATCH');
    return {status:'uploaded',fileName:value.fileName,inputSha256:value.inputSha256,source:'caller_confirmed_original_receipt',receivedAt:stamp()};
  }
  function validIdentity(s){return s?.backendId===backendId&&s.modelVersion===modelVersion&&s.recipeSha256===recipeSha256;}
  async function infer(s,signal){
    const blocked=gate();if(blocked)return blocked;
    if(signal?.aborted)return {status:'blocked',code:'BACKEND_CANCELLED'};
    if(!flash&&(s.upload?.status!=='uploaded'||!validFile(s.upload.fileName)||s.upload.inputSha256!==s.source.sha256))return resultOf(s);
    if(flash) {
      let publicImage;
      try {publicImage=await receive(flash.body.imageUrl,{signal,authenticated:false,limit:maxInputBytes});}
      catch {return stop(s,'FLASH_INPUT_URL_UNAVAILABLE','Original public source could not be verified. No inference submitted.');}
      if(publicImage.httpStatus!==200||sha256(publicImage.bytes)!==(flash.uploadedSha256??flash.inputSha256))
        return stop(s,'FLASH_INPUT_URL_CHANGED','Public source no longer matches the registered attachment. No inference submitted.');
      s.publicSource={sha256:flash.uploadedSha256??flash.inputSha256,bytes:publicImage.bytes.length,verifiedAt:stamp()};
    }
    if(!await claim(s,'inference'))return {...resultOf(s),status:'blocked',code:'EXTERNAL_RESULT_UNKNOWN'};
    const payload=Buffer.from(JSON.stringify(flash?flash.body:{webappId:RUNNINGHUB_LAYERED_APP,apiKey,nodeInfoList:[{nodeId:'23',fieldName:'image',fieldValue:s.upload.fileName},{nodeId:'20',fieldName:'value',fieldValue:String(layers)},{nodeId:'21',fieldName:'seed',fieldValue:seed}]}));
    s.status='inference_submitting';s.inferencePosts=1;delete s.code;delete s.note;await save(s);
    try{
      const call=inspect(await receive(`${BASE}${recipe.submitEndpoint}`,{method:'POST',body:payload,signal}));s.submitReceipt=call.receipt;
      const id=flash?call.data?.taskId:call.data?.data?.taskId;
      if(typeof id==='string'&&JOB.test(id)&&!(apiKey&&id.includes(apiKey))){
        s.jobId=id;s.status='running';s.providerStatus=redact(flash?call.data.status:call.data.data.taskStatus);await save(s);
        try{await durable(`job-${id}.json`,{operationKey:s.operationKey},true);}
        catch(e){if(e.code!=='EEXIST')throw e;if((await readJson(await root(),`job-${id}.json`))?.operationKey!==s.operationKey)return stop(s,'BACKEND_JOB_IDENTITY_MISMATCH','Task ID is already bound to a different operation.');}
        if(call.receipt.httpStatus!==200||(flash?!['QUEUED','RUNNING','SUCCESS','FAILED'].includes(call.data.status):call.data.code!==0))return stop(s,'EXTERNAL_RESULT_UNKNOWN','Task ID received with an inconsistent submission response; query only this task.','unknown');
        return resultOf(s);
      }
      return stop(s,'EXTERNAL_RESULT_UNKNOWN','Inference POST has no recoverable taskId; do not submit it again.','unknown',{httpStatus:call.receipt.httpStatus});
    }catch{return stop(s,'EXTERNAL_RESULT_UNKNOWN','Inference receipt unavailable; retain the original operation.','unknown');}
  }
  function fileUrl(value){
    if(typeof value!=='string'||value.length>4096||/%2e|%2f|%5c|\\|\/\.\.?\//i.test(value))throw error('BACKEND_FILE_URL_INVALID');
    let u;try{u=new URL(value);}catch{throw error('BACKEND_FILE_URL_INVALID');}
    if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash||!CDN.includes(u.hostname)||(!flash&&!u.pathname.includes('/output/'))||!u.pathname.toLowerCase().endsWith('.png'))throw error('BACKEND_FILE_URL_INVALID');
    // Strip API/session credentials. Object-store signatures stay in memory for this GET only.
    for(const key of [...u.searchParams.keys()])if(/^(api.?key|Rh-Comfy-Auth|authorization|bearer|token|cookie)$/i.test(key))u.searchParams.delete(key);
    if(apiKey&&(u.href.includes(apiKey)||decodeURIComponent(u.href).includes(apiKey)))throw error('BACKEND_FILE_URL_INVALID');
    return u;
  }
  function filesOf(data){
    if(!Array.isArray(data.results)||(flash?(data.results.length<1||data.results.length>17):data.results.length!==layers))throw error('BACKEND_OUTPUT_UNSUPPORTED');
    const files=data.results.map((f,i)=>{
      if(f?.outputType!=='png')throw error('BACKEND_OUTPUT_UNSUPPORTED');
      const u=fileUrl(f.url);
      let metadata=f;
      if(flash&&typeof f.text==='string'&&f.text.length<8192){try{metadata={...f,...JSON.parse(f.text)};}catch{}}
      const label=metadata.layer_name??metadata.name??metadata.label;
      const layerName=flash&&typeof label==='string'&&/^[\p{L}\p{N} :_-]{1,80}$/u.test(label)?label:null;
      const z=metadata.zindex??metadata.z_index;
      const rect=(a,limit)=>Array.isArray(a)&&a.length===4&&a.every(n=>Number.isFinite(n)&&n>=0&&n<=limit)&&a[0]<a[2]&&a[1]<a[3];
      const b=metadata.boundingBox;
      const providerBox=flash&&rect(b?.absolute,8192)&&rect(b?.normalized,1000)?{absolute:b.absolute,normalized:b.normalized}:undefined;
      return {url:u.href,descriptor:{...(layerName?{layerName}:{}),...(providerBox?{providerBox}:{}),...(flash&&Number.isInteger(z)&&Math.abs(z)<4096?{z}:{}),ordinal:i+1,urlWithoutQuery:u.origin+u.pathname,objectSha256:sha256(u.origin+u.pathname),outputType:'png'}};
    });
    if(new Set(files.map(f=>f.descriptor.objectSha256)).size!==files.length)throw error('BACKEND_OUTPUT_UNSUPPORTED');return files;
  }
  async function pixels(s,files,signal){
    const parts=[];let canvas,totalBytes=0,totalPixels=0;s.downloads??=[];
    for(let i=0;i<s.files.length;i++){
      const name=`${sha256(s.operationKey)}-layer-${i+1}.png`,previous=s.downloads[i];let bytes;
      try{bytes=await readFile(await safePath(await root(),name));}catch(e){if(e.code!=='ENOENT')throw e;}
      if(bytes&&(!previous||previous.path!==name||previous.sha256!==sha256(bytes)||previous.bytes!==bytes.length))return stop(s,'BACKEND_CACHE_CHANGED','Cached layer does not match its recorded receipt.');
      if(!bytes){
        if(previous)return stop(s,'BACKEND_CACHE_CHANGED','Recorded layer file is missing.');
        if(!files)return {status:'running',jobId:s.jobId,code:'BACKEND_DOWNLOAD_LINK_REQUIRED'};
        const wire=await receive(fileUrl(files[i].url),{signal,authenticated:false,limit:Math.min(maxFileBytes,maxTotalBytes-totalBytes)});
        if(wire.httpStatus!==200)return stop(s,'BACKEND_DOWNLOAD_HTTP_ERROR','PNG GET did not return 200; redirects are not followed.','blocked',{httpStatus:wire.httpStatus});
        bytes=wire.bytes;
      }
      totalBytes+=bytes.length;if(bytes.length>maxFileBytes||totalBytes>maxTotalBytes)return stop(s,'BACKEND_OUTPUT_SIZE_LIMIT','PNG byte budget exceeded.');
      let image;try{image=decodePng(bytes);}catch{return stop(s,'BACKEND_PIXELS_INVALID','Not a supported CRC-valid PNG.');}
      if(!flash&&(!image.hasAlpha||bytes[25]!==6))return stop(s,'BACKEND_ALPHA_REQUIRED','Output must contain genuine RGBA; alpha is not synthesized.');
      canvas??={width:image.width,height:image.height};totalPixels+=image.width*image.height;
      if(totalPixels>maxTotalPixels)return stop(s,'BACKEND_OUTPUT_SIZE_LIMIT','Decoded pixel budget exceeded.');
      if(!flash&&(image.width!==canvas.width||image.height!==canvas.height))return stop(s,'BACKEND_LAYER_CANVAS_MISMATCH','Unequal canvases; alignment is not guessed.');
      if(!previous){await writeBound(await root(),name,bytes);s.downloads[i]={ordinal:i+1,path:name,sha256:sha256(bytes),bytes:bytes.length,width:image.width,height:image.height,alpha:image.hasAlpha?'rgba':'opaque',receivedAt:stamp()};await save(s);}
      parts.push({...(flash?{providerOrder:s.files[i].z,providerBox:s.files[i].providerBox,providerLabel:s.files[i].layerName,reference:!image.hasAlpha,visible:image.hasAlpha}:{}),id:`runninghub-layer-${i+1}`,name:s.files[i].layerName||`RunningHub ordinal layer ${i+1}`,png:bytes,rect:{left:0,top:0,width:image.width,height:image.height},tags:[],origin:'generated',occlusion:{status:'inferred_unreviewed',note:'Ordinal is not a verified semantic or draw order.'}});
    }
    s.status='completed';delete s.code;delete s.note;await save(s);
    return {status:'completed',jobId:s.jobId,result:{canvas,parts,quality:{checks:['identity-preservation','occlusion-completion','default-composite'].map(name=>({name,layer:'visual',status:'not_run',note:'Downloaded pixels require actual visual review.'})),sourceCanvasMapping:{sourceWidth:s.source.width,sourceHeight:s.source.height,outputWidth:canvas.width,outputHeight:canvas.height,verified:false},providerLayerOrder:'Results array ordinal only; registration and semantics unverified.'}}};
  }
  function taskFailure(data){
    let tips=data.promptTips;try{if(typeof tips==='string'&&tips)tips=JSON.parse(tips);}catch{tips=null;}
    return nonempty(data.errorCode)||nonempty(data.errorMessage)||nonempty(data.failedReason)||tips?.result===false||nonempty(tips?.error)||nonempty(tips?.node_errors);
  }
  async function query(jobId,{operationKey,signal}={}){
    if(typeof jobId!=='string'||!JOB.test(jobId))throw error('BACKEND_JOB_ID_INVALID');
    operationKey??=(await readJson(await root(),`job-${jobId}.json`))?.operationKey;
    const s=operationKey?await saved(operationKey):null;
    if(!s||s.jobId!==jobId)return {status:'blocked',jobId,code:'BACKEND_RECEIPT_MISSING'};
    if(!validIdentity(s))return {status:'blocked',jobId,code:'BACKEND_CACHE_IDENTITY_MISMATCH'};
    if(s.status==='completed'){
      // Older receipts retained the pixels but discarded placement. Recover only
      // metadata via the original query, never upload, infer or fetch pixels again.
      if(flash&&!s.placementSchema&&apiKey){
        let result;
        try {result=inspect(await receive(BASE+'/openapi/v2/query',{method:'POST',body:Buffer.from(JSON.stringify({taskId:jobId})),signal}));}
        catch {return {status:'blocked',jobId,code:'BACKEND_PLACEMENT_QUERY_UNAVAILABLE'};}
        if(result.receipt.httpStatus!==200||result.data?.taskId!==jobId||result.data.status!=='SUCCESS')return {status:'blocked',jobId,code:'BACKEND_PLACEMENT_QUERY_UNAVAILABLE'};
        const descriptors=filesOf(result.data).map(f=>f.descriptor);
        if(s.files.length!==descriptors.length||s.files.some((old,i)=>Object.entries(old).some(([k,v])=>JSON.stringify(v)!==JSON.stringify(descriptors[i][k]))))
          return {status:'blocked',jobId,code:'BACKEND_RESULT_CHANGED'};
        s.files=descriptors;s.placementSchema=1;s.placementReceipt=result.receipt;s.queryPosts++;await save(s);
      }
      return pixels(s,null,signal);
    }
    if(!['running','unknown','downloading'].includes(s.status))return resultOf(s);
    if(!apiKey)return {status:'blocked',jobId,code:'BACKEND_AUTH_REQUIRED'};
    if(s.lastQueryAt!==undefined&&now()-s.lastQueryAt<pollIntervalMs)return {status:'running',jobId,code:'BACKEND_POLL_THROTTLED'};
    s.lastQueryAt=now();s.queryPosts++;await save(s);
    try{
      const call=inspect(await receive(`${BASE}/openapi/v2/query`,{method:'POST',body:Buffer.from(JSON.stringify({taskId:jobId})),signal}));s.queryReceipt=call.receipt;await save(s);
      if(call.receipt.httpStatus!==200)return stop(s,'EXTERNAL_RESULT_UNKNOWN','Original task query HTTP unavailable; no new inference.','unknown',{httpStatus:call.receipt.httpStatus});
      const data=call.data;
      if(data?.taskId!==jobId||typeof data.status!=='string')return stop(s,'EXTERNAL_RESULT_UNKNOWN','Original task identity or query schema is unavailable.','unknown');
      s.providerStatus=redact(data.status);
      if(flash&&data.usage) {
        s.usage=Object.fromEntries(['consumeMoney','consumeCoins','thirdPartyConsumeMoney','taskCostTime'].filter(k=>data.usage[k]===null||/^[0-9.]{1,32}$/.test(String(data.usage[k]))).map(k=>[k,data.usage[k]]));
      }
      if(['FAILED','CANCELLED','CANCELED'].includes(data.status)||taskFailure(data))return stop(s,['CANCELLED','CANCELED'].includes(data.status)?'BACKEND_GENERATION_CANCELLED':'BACKEND_GENERATION_FAILED',data.errorMessage||'Provider returned a terminal error; inspect the sanitized receipt.','failed',{httpStatus:200,errorType:redact(String(data.errorCode||data.status))});
      if(['QUEUED','RUNNING'].includes(data.status)){s.status='running';delete s.code;delete s.note;await save(s);return resultOf(s);}
      if(data.status!=='SUCCESS')return stop(s,'EXTERNAL_RESULT_UNKNOWN','Unrecognized provider state; preserve original task.','unknown');
      let files;try{files=filesOf(data);}catch(e){return stop(s,e.message,'Output must be independent PNG layers from controlled HTTPS result paths; ZIP/PSD/composites are not unpacked or relabeled.');}
      const descriptors=files.map(f=>f.descriptor);
      if(s.files&&JSON.stringify(s.files)!==JSON.stringify(descriptors))return stop(s,'BACKEND_RESULT_CHANGED','Original task result identities changed during recovery.');
      s.files=descriptors;if(flash)s.placementSchema=1;s.status='downloading';delete s.code;delete s.note;await save(s);return await pixels(s,files,signal);
    }catch(e){
      if(e.message==='BACKEND_RESPONSE_TOO_LARGE')return stop(s,'BACKEND_RESPONSE_TOO_LARGE','Bounded response exceeded the configured limit.');
      return stop(s,'BACKEND_QUERY_INTERRUPTED','Original task retained; resume only its query/download.','running');
    }
  }
  async function recover({operationKey,signal,uploadedInput:confirmed}={}){
    const s=typeof operationKey==='string'?await saved(operationKey):null;
    if(!s)return {status:'blocked',code:'BACKEND_RECEIPT_MISSING'};
    if(!validIdentity(s))return {status:'blocked',jobId:s.jobId,code:'BACKEND_CACHE_IDENTITY_MISMATCH'};
    if(s.jobId)return query(s.jobId,{operationKey,signal});
    if(confirmed&&s.inferencePosts===0){s.upload=confirmedUpload(confirmed,s.source);s.status='uploaded';delete s.code;delete s.note;await save(s);}
    return resultOf(s);
  }
  async function submit(req){
    if(!req||[req.operationKey,req.cacheKey].some(k=>typeof k!=='string'||!k||k.length>1024||/[?=\s]|data:|https?:|api.?key|Rh-Comfy-Auth/i.test(k)||apiKey&&k.includes(apiKey))||!Buffer.isBuffer(req.source?.bytes)||req.source.bytes.length>maxInputBytes||req.source.mimeType!=='image/png'||req.source.sha256!==sha256(req.source.bytes)||req.rights?.allowDerivatives!==true)throw error('BACKEND_REQUEST_INVALID');
    const image=decodePng(req.source.bytes);if(image.width!==req.source.width||image.height!==req.source.height)throw error('BACKEND_SOURCE_DIMENSIONS_MISMATCH');
    const source={sha256:req.source.sha256,width:image.width,height:image.height,mimeType:'image/png'},fingerprint=sha256(JSON.stringify({cacheKey:req.cacheKey,source,recipe}));
    let s=await saved(req.operationKey);
    if(s){
      if(s.fingerprint!==fingerprint||!validIdentity(s))throw error('BACKEND_CACHE_IDENTITY_MISMATCH');
      if(s.jobId)return recover({operationKey:req.operationKey,signal:req.signal});
      if(s.status==='uploaded'||flash&&s.status==='ready')return infer(s,req.signal);
      return resultOf(s);
    }
    const blocked=gate();if(blocked)return blocked;if(req.signal?.aborted)return {status:'blocked',code:'BACKEND_CANCELLED'};
    if(flash&&req.inputSha256!==flash.inputSha256)return {status:'blocked',code:'FLASH_INPUT_HASH_MISMATCH'};
    const originalUpload=!flash&&uploadedInput?confirmedUpload(uploadedInput,source):null;
    s={schemaVersion:1,backendId,modelVersion,operationKey:req.operationKey,cacheKey:req.cacheKey,fingerprint,source,recipe,recipeSha256,status:originalUpload?'uploaded':'ready',upload:originalUpload||{status:'not_started'},uploadPosts:0,inferencePosts:0,queryPosts:0,createdAt:stamp()};
    try{await durable(`cache-${sha256(req.cacheKey)}.json`,{operationKey:req.operationKey,fingerprint},true);}
    catch(e){if(e.code!=='EEXIST')throw e;const c=await readJson(await root(),`cache-${sha256(req.cacheKey)}.json`);if(c?.operationKey!==req.operationKey||c.fingerprint!==fingerprint)throw error('BACKEND_CACHE_IDENTITY_MISMATCH');}
    try{await durable(filename(req.operationKey),s,true);}catch(e){if(e.code!=='EEXIST')throw e;return recover({operationKey:req.operationKey,signal:req.signal});}
    if(flash||originalUpload)return infer(s,req.signal);
    if(!await claim(s,'upload'))return {status:'blocked',code:'EXTERNAL_RESULT_UNKNOWN'};
    s.status='upload_submitting';s.upload.status='submitting';s.uploadPosts=1;await save(s);
    const boundary=`rh-${randomUUID()}`;
    const payload=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${source.sha256}.png"\r\nContent-Type: image/png\r\n\r\n`),req.source.bytes,Buffer.from(`\r\n--${boundary}--\r\n`)]);
    try{
      const call=inspect(await receive(`${BASE}/openapi/v2/media/upload/binary`,{method:'POST',contentType:`multipart/form-data; boundary=${boundary}`,body:payload,signal:req.signal}));s.uploadReceipt=call.receipt;
      if(call.receipt.httpStatus!==200||call.data?.code!==0||call.data.data?.type!=='image'||!validFile(call.data.data.fileName))return stop(s,'EXTERNAL_RESULT_UNKNOWN','Upload has no confirmed usable original fileName; do not upload again.','unknown',{httpStatus:call.receipt.httpStatus});
      if(call.data.data.size!==undefined&&String(req.source.bytes.length)!==String(call.data.data.size))return stop(s,'BACKEND_UPLOAD_SIZE_MISMATCH','Upload receipt size does not match the input.');
      s.upload={status:'uploaded',fileName:call.data.data.fileName,inputSha256:source.sha256,receivedAt:stamp()};s.status='uploaded';await save(s);
    }catch{return stop(s,'EXTERNAL_RESULT_UNKNOWN','Upload receipt unavailable; never blindly re-upload.','unknown');}
    return infer(s,req.signal);
  }
  return {id:backendId,version:'1.0.0',modelVersion,recipe,submit,query,recover};
}

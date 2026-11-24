import { mkdir, realpath, readFile, open } from 'node:fs/promises';
import { directRequest } from './see-through.mjs';
import { sha256, readJson, writeJson, writeBound, safePath } from './files.mjs';
import { decodePng } from './png.mjs';

export const FAL_LAYERED_MODEL='fal-ai/qwen-image-layered';
const BASE=`https://queue.fal.run/${FAL_LAYERED_MODEL}`;
const VERSION='fal-ai/qwen-image-layered-public-unpinned';
const JOB=/^[A-Za-z0-9_-]{16,128}$/;
const QUEUE_STATES=['IN_QUEUE','IN_PROGRESS','COMPLETED'];
const error=code=>new Error(code);
const httpCode=status=>status===401?'BACKEND_AUTH_REQUIRED':status===403?'BACKEND_ACCESS_DENIED':status===429?'BACKEND_QUOTA_OR_QUEUE_LIMIT':'BACKEND_HTTP_ERROR';

/** One durable operation permits one Queue POST. No SDK, upload endpoint,
 * automatic retry, model fallback or semantic eye/mouth inference is used.
 * apiKey stays in this closure; callers must authorize cost before submit.
 */
export function createFalLayeredBackend({stateDir,apiKey,allowUnpinnedModel=false,request=directRequest,layers=4,seed=0,steps=28,guidance=5,prompt='',negativePrompt='',timeoutMs=45000,pollIntervalMs=1000,maxInputBytes=8*1024*1024,maxJsonBytes=1024*1024,maxFileBytes=16*1024*1024,maxTotalBytes=64*1024*1024,now=Date.now}={}){
  if(!stateDir)throw error('BACKEND_STATE_DIR_REQUIRED');
  if(apiKey!==undefined&&(typeof apiKey!=='string'||!apiKey||apiKey.length>4096||/[\s\u0000-\u001f\u007f]/.test(apiKey)))throw error('BACKEND_CREDENTIAL_INVALID');
  if(!Number.isInteger(layers)||layers<2||layers>10||!Number.isInteger(seed)||seed<0||seed>2147483647||!Number.isInteger(steps)||steps<1||steps>50||!Number.isFinite(guidance)||guidance<1||guidance>20||[prompt,negativePrompt].some(p=>typeof p!=='string'||p.length>6000))throw error('BACKEND_RECIPE_INVALID');
  if(!Number.isInteger(timeoutMs)||timeoutMs<10||timeoutMs>120000||!Number.isInteger(pollIntervalMs)||pollIntervalMs<1000||pollIntervalMs>60000||[maxInputBytes,maxJsonBytes,maxFileBytes,maxTotalBytes].some(n=>!Number.isInteger(n)||n<1)||maxInputBytes>8*1024*1024||maxJsonBytes>2*1024*1024||maxFileBytes>16*1024*1024||maxTotalBytes>96*1024*1024||typeof now!=='function')throw error('BACKEND_LIMIT_INVALID');
  const recipe={modelId:FAL_LAYERED_MODEL,modelRevision:'unpinned',layers,seed,steps,guidance,prompt,negativePrompt,syncMode:false,safetyChecker:true,outputFormat:'png',acceleration:'regular',noRetry:true,disableFallback:true,storeIO:true,cdnExpirationSeconds:86400};
  const recipeSha256=sha256(JSON.stringify(recipe));
  const storedRecipe={...recipe,prompt:undefined,negativePrompt:undefined,promptSha256:sha256(prompt),negativePromptSha256:sha256(negativePrompt)};
  let rootPromise;
  const root=()=>rootPromise??=mkdir(stateDir,{recursive:true}).then(()=>realpath(stateDir));
  const receiptName=key=>`${sha256(key)}.json`;
  const saved=async key=>readJson(await root(),receiptName(key));
  const save=async state=>writeJson(await root(),receiptName(state.operationKey),state);
  const stamp=()=>new Date(now()).toISOString();
  function redact(value){
    if(typeof value==='string'){
      if(apiKey)value=value.split(apiKey).join('[REDACTED]');
      return value.replace(/data:[^,\s]+,[A-Za-z0-9+/_=-]+/gi,'[REDACTED_DATA_URI]').replace(/\bKey\s+[^\s,;]+/gi,'Key [REDACTED]').slice(0,2000);
    }
    if(Array.isArray(value))return value.slice(0,20).map(redact);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).slice(0,30).map(([k,v])=>[redact(k),/authorization|api.?key|token|cookie|secret|image_url|^input$|^body$/i.test(k)?'[REDACTED]':redact(v)]));
    return value;
  }
  const resultOf=state=>({status:['running','completed','failed','blocked'].includes(state.status)?state.status:'blocked',...(state.jobId?{jobId:state.jobId}:{}),...(state.code?{code:state.code}:state.status==='unknown'||state.status==='submitting'?{code:'EXTERNAL_RESULT_UNKNOWN'}:{}),...(state.note?{note:state.note}:{}),...(state.httpStatus?{httpStatus:state.httpStatus}:{}),...(state.errorType?{errorType:state.errorType}:{})});
  async function stop(state,code,note,status='blocked',extra={}){
    Object.assign(state,{status,code,note:redact(note),...extra});await save(state);return resultOf(state);
  }
  async function receive(url,{method='GET',body,signal,authenticated=true,limit=maxJsonBytes}={}){
    if(signal?.aborted)throw error('BACKEND_CANCELLED');
    const controller=new AbortController(),combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    // Covers headers AND the complete bounded body, not only socket idleness.
    const timer=setTimeout(()=>controller.abort(error('BACKEND_REQUEST_TIMEOUT')),timeoutMs);
    let response;
    const abortBody=()=>response?.body?.destroy?.(error('BACKEND_REQUEST_INTERRUPTED'));
    combined.addEventListener('abort',abortBody,{once:true});
    try{
      const headers=authenticated?{Authorization:`Key ${apiKey}`}:{ };
      if(method==='POST')Object.assign(headers,{'Content-Type':'application/json','Content-Length':String(body.length),'X-Fal-No-Retry':'1','x-app-fal-disable-fallback':'true','X-Fal-Store-IO':'1','X-Fal-Object-Lifecycle-Preference':JSON.stringify({expiration_duration_seconds:86400}),'X-Fal-Request-Start-Timeout':'300'});
      response=await request(url,{method,headers,body,signal:combined,timeoutMs});
      const chunks=[];let size=0;
      for await(const chunk of response.body){
        if(combined.aborted)throw error('BACKEND_REQUEST_INTERRUPTED');
        const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit)throw error('BACKEND_RESPONSE_TOO_LARGE');chunks.push(bytes);
      }
      if(combined.aborted)throw error('BACKEND_REQUEST_INTERRUPTED');
      return {httpStatus:response.status,bytes:Buffer.concat(chunks)};
    }finally{clearTimeout(timer);combined.removeEventListener('abort',abortBody);response?.body?.destroy?.();}
  }
  function inspect(wire){
    let data;try{data=JSON.parse(wire.bytes.toString('utf8'));}catch{}
    const receipt={httpStatus:wire.httpStatus,bodyBytes:wire.bytes.length,bodySha256:sha256(wire.bytes),receivedAt:stamp()};
    for(const key of ['status','request_id','error','errors','error_type','detail','type'])if(data?.[key]!==undefined)receipt[key]=redact(data[key]);
    return {data,receipt};
  }
  const hasError=data=>data&&['error','error_type','errors'].some(k=>data[k]!==undefined&&data[k]!==null&&data[k]!==''&&!(Array.isArray(data[k])&&!data[k].length));
  const urls=jobId=>({response_url:`${BASE}/requests/${jobId}`,status_url:`${BASE}/requests/${jobId}/status`,cancel_url:`${BASE}/requests/${jobId}/cancel`});
  function fileUrl(value){
    if(typeof value!=='string'||value.length>2048||apiKey&&value.includes(apiKey)||/%2e|%2f|%5c|\\|\/\.\.?\//i.test(value))throw error('BACKEND_FILE_URL_INVALID');
    let url;try{url=new URL(value);}catch{throw error('BACKEND_FILE_URL_INVALID');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash||!(url.hostname==='fal.media'||/^[a-z0-9-]+\.fal\.media$/.test(url.hostname))||!url.pathname.startsWith('/files/'))throw error('BACKEND_FILE_URL_INVALID');
    return url.href;
  }
  function filesOf(data){
    if(!data||!Array.isArray(data.images)||data.images.length!==layers||data.seed!==seed||!Array.isArray(data.has_nsfw_concepts)||data.has_nsfw_concepts.length!==layers||data.has_nsfw_concepts.some(value=>value!==false))throw error('BACKEND_OUTPUT_INVALID');
    return data.images.map(file=>{
      if(!file||file.content_type!==undefined&&file.content_type!=='image/png'||file.file_size!==undefined&&(!Number.isInteger(file.file_size)||file.file_size<1||file.file_size>maxFileBytes)||['width','height'].some(k=>file[k]!==undefined&&(!Number.isInteger(file[k])||file[k]<1||file[k]>8192)))throw error('BACKEND_OUTPUT_INVALID');
      return {url:fileUrl(file.url),...Object.fromEntries(['width','height','file_size'].filter(k=>file[k]!==undefined).map(k=>[k,file[k]]))};
    });
  }
  async function pixels(state,signal){
    const parts=[];let canvas,totalBytes=0,totalPixels=0;
    state.downloads??=[];
    for(let i=0;i<state.files.length;i++){
      const file=state.files[i],filename=`${sha256(state.operationKey)}-layer-${i+1}.png`;
      let bytes;try{bytes=await readFile(await safePath(await root(),filename));}catch(e){if(e.code!=='ENOENT')throw e;}
      const previous=state.downloads[i];
      if(bytes&&(!previous||previous.path!==filename||previous.sha256!==sha256(bytes)||previous.bytes!==bytes.length))return stop(state,'BACKEND_CACHE_CHANGED','Cached PNG differs from its durable receipt.');
      if(!bytes){
        if(previous)return stop(state,'BACKEND_CACHE_CHANGED','Previously recorded PNG is missing.');
        const wire=await receive(fileUrl(file.url),{signal,authenticated:false,limit:Math.min(maxFileBytes,maxTotalBytes-totalBytes)});
        if(wire.httpStatus!==200)return stop(state,httpCode(wire.httpStatus),'PNG GET did not return HTTP 200; redirects are not followed.','blocked',{httpStatus:wire.httpStatus});
        bytes=wire.bytes;
      }
      totalBytes+=bytes.length;if(bytes.length>maxFileBytes||totalBytes>maxTotalBytes)return stop(state,'BACKEND_OUTPUT_SIZE_LIMIT','PNG byte budget exceeded.');
      let image;try{image=decodePng(bytes);}catch{return stop(state,'BACKEND_PIXELS_INVALID','Output is not a supported, CRC-valid PNG.');}
      if(!image.hasAlpha||bytes[25]!==6)return stop(state,'BACKEND_ALPHA_REQUIRED','A genuine RGBA PNG is required; no synthetic alpha is added.');
      if(file.file_size!==undefined&&file.file_size!==bytes.length||file.width!==undefined&&file.width!==image.width||file.height!==undefined&&file.height!==image.height)return stop(state,'BACKEND_FILE_METADATA_MISMATCH','Provider metadata does not match decoded PNG bytes.');
      canvas??={width:image.width,height:image.height};totalPixels+=image.width*image.height;
      if(totalPixels>64*1024*1024)return stop(state,'BACKEND_OUTPUT_SIZE_LIMIT','Decoded layer pixel budget exceeded.');
      if(image.width!==canvas.width||image.height!==canvas.height)return stop(state,'BACKEND_LAYER_CANVAS_MISMATCH','Ordinal layers have unequal canvases; no guessed registration is applied.');
      if(!previous){await writeBound(await root(),filename,bytes);state.downloads[i]={path:filename,sha256:sha256(bytes),bytes:bytes.length,width:image.width,height:image.height,httpStatus:200,receivedAt:stamp(),ordinal:i+1};await save(state);}
      parts.push({id:`fal-layer-${i+1}`,name:`fal ordinal layer ${i+1}`,png:bytes,rect:{left:0,top:0,width:image.width,height:image.height},tags:[],origin:'generated',occlusion:{status:'inferred_unreviewed',note:'Provider order and generated hidden pixels require actual visual review.'}});
    }
    state.status='completed';delete state.code;delete state.note;await save(state);
    return {status:'completed',jobId:state.jobId,result:{canvas,parts,quality:{checks:['identity-preservation','occlusion-completion','default-composite'].map(name=>({name,layer:'visual',status:'not_run',note:'Transport and PNG checks do not establish visual quality.'})),sourceCanvasMapping:{sourceWidth:state.source.width,sourceHeight:state.source.height,outputWidth:canvas.width,outputHeight:canvas.height,verified:false,note:'Equal dimensions do not establish source registration or preserved alpha.'},providerLayerOrder:'Returned images array ordinal; draw order and source alignment are unverified.'}}};
  }
  async function resume(state,{signal}={}){
    if(!state)return {status:'blocked',code:'BACKEND_RECEIPT_MISSING'};
    if(state.backendId!=='fal-layered-queue'||state.modelVersion!==VERSION||state.recipeSha256!==recipeSha256)return {status:'blocked',jobId:state.jobId,code:'BACKEND_CACHE_IDENTITY_MISMATCH'};
    if(state.status==='completed')return pixels(state,signal);
    if(state.jobId&&['running','unknown'].includes(state.status))return query(state.jobId,{operationKey:state.operationKey,signal});
    return resultOf(state);
  }
  async function query(jobId,{signal,operationKey}={}){
    if(typeof jobId!=='string'||!JOB.test(jobId))throw error('BACKEND_JOB_ID_INVALID');
    operationKey??=(await readJson(await root(),`job-${jobId}.json`))?.operationKey;
    const state=operationKey?await saved(operationKey):null;
    if(!state||state.jobId!==jobId||state.backendId!=='fal-layered-queue')return {status:'blocked',jobId,code:'BACKEND_RECEIPT_MISSING'};
    if(state.modelVersion!==VERSION||state.recipeSha256!==recipeSha256)return {status:'blocked',jobId,code:'BACKEND_CACHE_IDENTITY_MISMATCH'};
    if(!['running','unknown','completed'].includes(state.status))return resultOf(state);
    if(state.status==='completed')return pixels(state,signal);
    if(!apiKey)return {status:'blocked',jobId,code:'BACKEND_AUTH_REQUIRED'};
    try{
      if(state.files)return await pixels(state,signal);
      if(state.lastQueryAt!==undefined&&now()-state.lastQueryAt<pollIntervalMs)return {status:'running',jobId,code:'BACKEND_POLL_THROTTLED'};
      state.lastQueryAt=now();await save(state);
      const status=inspect(await receive(urls(jobId).status_url,{signal}));state.queueReceipt=status.receipt;await save(state);
      if(status.receipt.httpStatus!==200&&status.receipt.httpStatus!==202)return stop(state,status.receipt.httpStatus===404?'EXTERNAL_RESULT_UNKNOWN':httpCode(status.receipt.httpStatus),'Original request status is unavailable; no resubmission.','unknown',{httpStatus:status.receipt.httpStatus});
      if(status.data?.request_id!==undefined&&status.data.request_id!==jobId)return stop(state,'BACKEND_RECEIPT_INVALID','Status belongs to a different request.');
      if(!QUEUE_STATES.includes(status.data?.status))return stop(state,'EXTERNAL_RESULT_UNKNOWN','Unrecognized original queue status.','unknown');
      if(hasError(status.data))return stop(state,'BACKEND_GENERATION_FAILED',status.data.error||JSON.stringify(redact(status.data.errors))||status.data.error_type,'failed',{httpStatus:status.receipt.httpStatus,errorType:redact(status.data.error_type||'unspecified')});
      state.queueStatus=status.data.status;
      state.status='running';delete state.code;delete state.note;delete state.httpStatus;delete state.errorType;await save(state);
      if(state.queueStatus!=='COMPLETED')return resultOf(state);
      const result=inspect(await receive(urls(jobId).response_url,{signal}));state.resultReceipt=result.receipt;await save(state);
      if(result.receipt.httpStatus===404)return stop(state,'EXTERNAL_RESULT_UNKNOWN','Original result was not retained or is unavailable.','unknown',{httpStatus:404});
      if([401,403,429].includes(result.receipt.httpStatus))return stop(state,httpCode(result.receipt.httpStatus),'Original result GET is blocked by access or quota; recover this request only.','unknown',{httpStatus:result.receipt.httpStatus});
      if(result.receipt.httpStatus===400&&!hasError(result.data))return stop(state,'BACKEND_RESULT_PENDING','Original result endpoint is not ready.','running',{httpStatus:400});
      if(result.receipt.httpStatus!==200||hasError(result.data))return stop(state,'BACKEND_GENERATION_FAILED',result.data?.error||JSON.stringify(redact(result.data?.errors||result.data?.detail))||'Model result HTTP failure.','failed',{httpStatus:result.receipt.httpStatus,errorType:redact(result.data?.error_type||result.data?.type||'unspecified')});
      try{state.files=filesOf(result.data);}catch(e){return stop(state,e.message,'Result schema, safety flags or file URL failed validation.');}
      state.outputSeed=result.data.seed;state.status='running';await save(state);
      return await pixels(state,signal);
    }catch(e){
      if(e.message==='BACKEND_RESPONSE_TOO_LARGE')return stop(state,'BACKEND_RESPONSE_TOO_LARGE','Original response exceeded the configured byte limit.');
      state.code='BACKEND_QUERY_INTERRUPTED';state.note='Original request retained; recovery performs GET only.';await save(state);
      return {status:'running',jobId,code:state.code,note:state.note};
    }
  }
  async function submit(req){
    if(!req||[req.operationKey,req.cacheKey].some(k=>typeof k!=='string'||!k||k.length>1024||apiKey&&k.includes(apiKey)||/data:/i.test(k))||!Buffer.isBuffer(req.source?.bytes)||req.source.bytes.length>maxInputBytes||req.source.mimeType!=='image/png'||req.source.sha256!==sha256(req.source.bytes)||req.rights?.allowDerivatives!==true)throw error('BACKEND_REQUEST_INVALID');
    const image=decodePng(req.source.bytes);if(image.width!==req.source.width||image.height!==req.source.height)throw error('BACKEND_SOURCE_DIMENSIONS_MISMATCH');
    const source={sha256:req.source.sha256,width:image.width,height:image.height,mimeType:'image/png'},fingerprint=sha256(JSON.stringify({cacheKey:req.cacheKey,source,recipe}));
    const previous=await saved(req.operationKey);
    if(previous){if(previous.fingerprint!==fingerprint)throw error('BACKEND_CACHE_IDENTITY_MISMATCH');return resume(previous,{signal:req.signal});}
    if(!apiKey)return {status:'blocked',code:'BACKEND_AUTH_REQUIRED'};
    if(!allowUnpinnedModel)return {status:'blocked',code:'BACKEND_MODEL_UNPINNED',note:'Caller must explicitly accept the unpinned public deployment before any submission.'};
    if(req.signal?.aborted)return {status:'blocked',code:'BACKEND_CANCELLED'};
    const payload=Buffer.from(JSON.stringify({image_url:`data:image/png;base64,${req.source.bytes.toString('base64')}`,prompt,negative_prompt:negativePrompt,num_layers:layers,seed,num_inference_steps:steps,guidance_scale:guidance,sync_mode:false,enable_safety_checker:true,output_format:'png',acceleration:'regular'}));
    const state={schemaVersion:1,backendId:'fal-layered-queue',modelVersion:VERSION,modelId:FAL_LAYERED_MODEL,operationKey:req.operationKey,cacheKey:req.cacheKey,fingerprint,source,recipe:storedRecipe,recipeSha256,status:'submitting',createdAt:stamp(),inferencePosts:1,requestBytes:payload.length,requestSha256:sha256(payload)};
    let fd;
    try{fd=await open(await safePath(await root(),receiptName(req.operationKey)),'wx',0o600);await fd.writeFile(JSON.stringify(state,null,2)+'\n');await fd.sync();}
    catch(e){if(e.code==='EEXIST'){const existing=await saved(req.operationKey);if(existing?.fingerprint!==fingerprint)throw error('BACKEND_CACHE_IDENTITY_MISMATCH');return resume(existing,{signal:req.signal});}throw e;}
    finally{await fd?.close();}
    try{
      const call=inspect(await receive(BASE,{method:'POST',body:payload,signal:req.signal}));state.submitReceipt=call.receipt;
      if(typeof call.data?.request_id==='string'&&JOB.test(call.data.request_id)&&!call.data.request_id.includes(apiKey)){
        state.jobId=call.data.request_id;state.urls=urls(state.jobId);state.status='running';
        await save(state);await writeJson(await root(),`job-${state.jobId}.json`,{operationKey:state.operationKey});
        if(Object.keys(state.urls).some(key=>call.data[key]!==undefined&&call.data[key]!==null&&call.data[key]!==state.urls[key]))return stop(state,'BACKEND_RECEIPT_URL_INVALID','Original request ID retained; untrusted receipt URLs will not be followed.');
        if(!QUEUE_STATES.includes(call.data.status))return stop(state,'EXTERNAL_RESULT_UNKNOWN','Request ID received with unknown status; query the original ID.','unknown');
        return resultOf(state);
      }
      return stop(state,call.receipt.httpStatus>=400&&call.receipt.httpStatus<500?httpCode(call.receipt.httpStatus):'EXTERNAL_RESULT_UNKNOWN','Submission has no recoverable request ID; never repeat this operation.',call.receipt.httpStatus>=400&&call.receipt.httpStatus<500?'blocked':'unknown',{httpStatus:call.receipt.httpStatus});
    }catch{return stop(state,'EXTERNAL_RESULT_UNKNOWN','Submission response is unknown; retain this operation and do not POST again.','unknown');}
  }
  return {id:'fal-layered-queue',version:'1.0.0',modelVersion:VERSION,recipe,submit,query,recover:async({operationKey,signal})=>resume(await saved(operationKey),{signal})};
}

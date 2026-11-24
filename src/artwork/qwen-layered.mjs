import { mkdir, realpath, readFile, open } from 'node:fs/promises';
import { directRequest } from './see-through.mjs';
import { sha256, readJson, writeJson, writeBound, safePath } from './files.mjs';
import { decodePng } from './png.mjs';

export const QWEN_LAYERED_URL='https://qwen-qwen-image-layered.hf.space';
const MAX_RESPONSE=2*1024*1024;
async function bytesOf(response,limit=MAX_RESPONSE){const chunks=[];let size=0;for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>limit){response.body.destroy?.();throw new Error('BACKEND_RESPONSE_TOO_LARGE');}chunks.push(bytes);}return Buffer.concat(chunks);}
const httpCode=status=>status===401?'BACKEND_AUTH_REQUIRED':status===403?'BACKEND_ACCESS_DENIED':status===429?'BACKEND_QUOTA_OR_QUEUE_LIMIT':'BACKEND_HTTP_ERROR';

/** Official /infer_1 metadata pinned by digest, not a promise of fine Live2D parts.
 * Each opaque ordinal layer deliberately has no inferred semantic tags.
 */
export function createQwenLayeredBackend({stateDir,request=directRequest,baseUrl=QWEN_LAYERED_URL,layers=10,seed=0,steps=50,prompt='',metadataSha256='ae9fc4096247ea2ab2014c8b72a84e7225767dc77e74ef12e8ea807c64f9dd88'}={}){
  if(!stateDir)throw new Error('BACKEND_STATE_DIR_REQUIRED');
  const base=new URL(baseUrl);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||base.pathname!=='/')throw new Error('BACKEND_URL_INVALID');
  if(!Number.isInteger(layers)||layers<2||layers>10||!Number.isInteger(seed)||seed<0||seed>2147483647||!Number.isInteger(steps)||steps<1||steps>50||typeof prompt!=='string'||prompt.length>6000)throw new Error('BACKEND_RECIPE_INVALID');
  const recipe={apiName:'infer_1',layers,seed,randomizeSeed:false,prompt,negativePrompt:' ',guidance:4,steps,cfgNormalize:true,useEnglishCaption:true,metadataSha256,baseUrl:base.origin};
  let rootPromise;const root=()=>rootPromise??=mkdir(stateDir,{recursive:true}).then(()=>realpath(stateDir));
  const receiptName=key=>`${sha256(key)}.json`;
  const saved=async key=>readJson(await root(),receiptName(key));
  const save=async state=>writeJson(await root(),receiptName(state.operationKey),state);
  async function record(state,phase,bytes,extra={}){
    const relative=`${sha256(state.operationKey)}-${phase}.raw`;
    await writeBound(await root(),relative,bytes);
    return {path:relative,sha256:sha256(bytes),bytes:bytes.length,receivedAt:new Date().toISOString(),...extra};
  }
  const resultOf=state=>({status:['completed','running','failed','blocked'].includes(state.status)?state.status:'blocked',jobId:state.jobId,code:state.code||(!['completed','running'].includes(state.status)?'EXTERNAL_RESULT_UNKNOWN':undefined),...(state.note?{note:state.note}:{})});
  async function output(state,signal){
    const gallery=state.output?.[0];if(!Array.isArray(gallery)||gallery.length<2||gallery.length>layers+1)return {status:'blocked',jobId:state.jobId,code:'BACKEND_OUTPUT_INVALID',note:'Expected a real gallery of RGBA layers.'};
    const parts=[];let canvas,total=0;state.downloads??=[];
    for(let index=0;index<gallery.length;index++){
      const entry=gallery[index],file=Array.isArray(entry)?entry[0]:entry.image||entry;
      if(!file?.path)return {status:'blocked',jobId:state.jobId,code:'BACKEND_OUTPUT_INVALID'};
      const url=new URL(file.url||`/gradio_api/file=${encodeURIComponent(file.path)}`,base);
      if(url.origin!==base.origin||url.protocol!=='https:'||url.username||url.password)return {status:'blocked',jobId:state.jobId,code:'BACKEND_FILE_ORIGIN_INVALID'};
      const filename=`${sha256(state.operationKey)}-layer-${index+1}.png`;let bytes;
      try{bytes=await readFile(await safePath(await root(),filename));}catch(error){if(error.code!=='ENOENT')throw error;}
      const previous=state.downloads[index];
      if(bytes&&(!previous||previous.sha256!==sha256(bytes)))return {status:'blocked',jobId:state.jobId,code:'BACKEND_CACHE_CHANGED'};
      if(!bytes){
        const response=await request(url,{signal,timeoutMs:45000});if(!response.ok)return {status:'blocked',jobId:state.jobId,code:httpCode(response.status),httpStatus:response.status};
        bytes=await bytesOf(response,16*1024*1024);await writeBound(await root(),filename,bytes);
        state.downloads[index]={path:filename,sha256:sha256(bytes),bytes:bytes.length,url:url.href,httpStatus:response.status,receivedAt:new Date().toISOString()};await save(state);
      }
      total+=bytes.length;if(total>96*1024*1024)return {status:'blocked',jobId:state.jobId,code:'BACKEND_OUTPUT_SIZE_LIMIT'};
      let image;try{image=decodePng(bytes);}catch(error){return {status:'blocked',jobId:state.jobId,code:'BACKEND_PIXELS_INVALID',note:error.message};}
      if(!image.hasAlpha)return {status:'blocked',jobId:state.jobId,code:'BACKEND_ALPHA_REQUIRED'};
      canvas??={width:image.width,height:image.height};
      if(image.width!==canvas.width||image.height!==canvas.height)return {status:'blocked',jobId:state.jobId,code:'BACKEND_LAYER_CANVAS_MISMATCH'};
      parts.push({id:`qwen-layer-${index+1}`,name:`Qwen ordinal layer ${index+1}`,png:bytes,rect:{left:0,top:0,width:image.width,height:image.height},tags:[],origin:'generated',occlusion:{status:'inferred_unreviewed',note:'Generated RGBA; semantic identity, occluded content and order require actual review.'}});
    }
    return {status:'completed',jobId:state.jobId,result:{canvas,parts,quality:{checks:['identity-preservation','occlusion-completion','default-composite'].map(name=>({name,layer:'visual',status:'not_run',note:'Real pixels are retained. No visual acceptance follows from a successful API call.'})),sourceCanvasMapping:{sourceWidth:state.source.width,sourceHeight:state.source.height,outputWidth:canvas.width,outputHeight:canvas.height,verified:false},providerLayerOrder:'gallery ordinal; verify against real composite',note:'The public app uses resolution bucket 640 and converts input to RGB then RGBA; original alpha is not guaranteed preserved. Prompt describes content and does not control individual layer semantics.'}}};
  }
  async function resume(state,{signal}={}){
    if(!state)return {status:'blocked',code:'BACKEND_RECEIPT_MISSING'};
    if(state.status==='completed')return output(state,signal);
    if(state.status!=='running')return resultOf(state);
    return query(state.jobId,{signal,operationKey:state.operationKey});
  }
  async function query(jobId,{signal,operationKey}={}){
    if(!/^[a-f0-9]{16,128}$/i.test(jobId))throw new Error('BACKEND_JOB_ID_INVALID');
    operationKey??=(await readJson(await root(),`job-${jobId}.json`))?.operationKey;
    let state=operationKey?await saved(operationKey):null;
    if(!state||state.jobId!==jobId)return {status:'blocked',jobId,code:'BACKEND_RECEIPT_MISSING'};
    if(state.status!=='running')return resume(state,{signal});
    let response;const received=[];let size=0,pending='';
    try{
      response=await request(`${base.origin}/gradio_api/call/infer_1/${jobId}`,{signal,timeoutMs:45000});
      if(!response.ok){const bytes=await bytesOf(response);state.sseReceipt=await record(state,'events',bytes,{httpStatus:response.status,method:'GET'});state.status=response.status===404?'unknown':'blocked';state.code=response.status===404?'EXTERNAL_RESULT_UNKNOWN':httpCode(response.status);await save(state);return resultOf(state);}
      for await(const chunk of response.body){
        const bytes=Buffer.from(chunk);size+=bytes.length;if(size>MAX_RESPONSE)throw new Error('BACKEND_EVENT_TOO_LARGE');received.push(bytes);pending+=bytes.toString('utf8');pending=pending.replace(/\r\n/g,'\n');let end;
        while((end=pending.indexOf('\n\n'))>=0){
          const frame=pending.slice(0,end);pending=pending.slice(end+2);const event=frame.match(/^event:\s*(.+)$/m)?.[1],data=frame.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trim()).join('\n');
          if(!['complete','error'].includes(event))continue;
          state.sseReceipt=await record(state,'events',Buffer.concat(received),{httpStatus:response.status,method:'GET',event,data:data.slice(0,2000),capturedThroughTerminalChunk:true});
          if(event==='error'){
            const missing=/^"?404:\s*Not Found"?$/.test(data);state={...state,status:missing?'unknown':'failed',code:missing?'EXTERNAL_RESULT_UNKNOWN':'BACKEND_GENERATION_FAILED',errorSummary:data.slice(0,2000),note:missing?'Original result unavailable; do not resubmit.':data==='null'?'Backend failed; the simple SSE API did not expose server error details.':data.slice(0,2000)};await save(state);response.body.destroy?.();return resultOf(state);
          }
          state={...state,status:'completed',output:JSON.parse(data)};await save(state);response.body.destroy?.();return output(state,signal);
        }
      }
    }catch(error){
      if(received.length){state.sseReceipt=await record(state,'events',Buffer.concat(received),{httpStatus:response?.status,method:'GET',interrupted:true,error:error.code||error.message});await save(state);}
      if(signal?.aborted)throw error;
      return {status:'running',jobId,code:'BACKEND_QUERY_INTERRUPTED',note:'Original job retained; no new inference was submitted.'};
    }
    return {status:'running',jobId,code:'BACKEND_RESULT_PENDING'};
  }
  async function submit(req){
    if(!req?.operationKey||!req.cacheKey||!req.source?.bytes||req.source.mimeType!=='image/png'||req.source.sha256!==sha256(req.source.bytes)||req.rights?.allowDerivatives!==true)throw new Error('BACKEND_REQUEST_INVALID');
    const existing=await saved(req.operationKey);if(existing){if(existing.cacheKey!==req.cacheKey)throw new Error('BACKEND_CACHE_IDENTITY_MISMATCH');return resume(existing,{signal:req.signal});}
    let state={schemaVersion:1,operationKey:req.operationKey,cacheKey:req.cacheKey,status:'submitting',backendId:'qwen-layered-gradio',modelVersion:'Qwen-Image-Layered-public-unpinned',recipe,createdAt:new Date().toISOString(),source:{sha256:req.source.sha256,width:req.source.width,height:req.source.height,mimeType:req.source.mimeType},uploadPosts:0,inferencePosts:0};
    let fd;try{fd=await open(await safePath(await root(),receiptName(req.operationKey)),'wx',0o600);await fd.writeFile(JSON.stringify(state,null,2)+'\n');}catch(error){if(error.code==='EEXIST')return resume(await saved(req.operationKey),{signal:req.signal});throw error;}finally{await fd?.close();}
    try{
      const boundary=`----artwork${sha256(req.operationKey).slice(0,24)}`;
      const body=Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="source.png"\r\nContent-Type: image/png\r\n\r\n`),Buffer.from(req.source.bytes),Buffer.from(`\r\n--${boundary}--\r\n`)]);
      state.uploadPosts++;state.uploadStartedAt=new Date().toISOString();await save(state);
      const upload=await request(`${base.origin}/gradio_api/upload`,{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(body.length)},body,signal:req.signal});
      const uploadBytes=await bytesOf(upload);state.uploadReceipt=await record(state,'upload',uploadBytes,{method:'POST',httpStatus:upload.status,requestBytes:body.length,requestSha256:sha256(body)});await save(state);
      if(!upload.ok){state={...state,status:'blocked',code:httpCode(upload.status)};await save(state);return resultOf(state);}
      const uploaded=JSON.parse(uploadBytes);if(!Array.isArray(uploaded)||typeof uploaded[0]!=='string')throw new Error('BACKEND_UPLOAD_INVALID');state.uploadedPath=uploaded[0];await save(state);
      const data=[{path:uploaded[0],meta:{_type:'gradio.FileData'}},seed,false,prompt,' ',4,steps,layers,true,true];
      const payload=Buffer.from(JSON.stringify({data}));state.inferencePosts++;state.inferenceStartedAt=new Date().toISOString();state.requestData=data;await save(state);
      const call=await request(`${base.origin}/gradio_api/call/infer_1`,{method:'POST',headers:{'content-type':'application/json','content-length':String(payload.length)},body:payload,signal:req.signal});
      const callBytes=await bytesOf(call);state.callReceipt=await record(state,'call',callBytes,{method:'POST',httpStatus:call.status,requestBytes:payload.length,requestSha256:sha256(payload)});await save(state);
      if(!call.ok){state={...state,status:call.status>=500?'unknown':'blocked',code:call.status>=500?'EXTERNAL_RESULT_UNKNOWN':httpCode(call.status)};await save(state);return resultOf(state);}
      const receipt=JSON.parse(callBytes);if(!/^[a-f0-9]{16,128}$/i.test(receipt.event_id))throw new Error('BACKEND_RECEIPT_INVALID');
      state={...state,status:'running',jobId:receipt.event_id};await save(state);await writeJson(await root(),`job-${state.jobId}.json`,{operationKey:req.operationKey});return {status:'running',jobId:state.jobId};
    }catch(error){state={...state,status:'unknown',code:'EXTERNAL_RESULT_UNKNOWN',note:`Submission outcome is unknown (${error.code||error.message}); do not resubmit.`};await save(state);if(req.signal?.aborted)throw error;return resultOf(state);}
  }
  return {id:'qwen-layered-gradio',version:'1.0.0',modelVersion:'Qwen-Image-Layered-public-unpinned',recipe,submit,query,recover:async({operationKey,signal})=>resume(await saved(operationKey),{signal})};
}

import https from 'node:https';
import { mkdir, realpath, readFile } from 'node:fs/promises';
import { sha256, readJson, writeJson, writeBound, safePath } from './files.mjs';
import { decodeLayeredPsd } from './psd.mjs';

export const SEE_THROUGH_URL='https://24yearsold-see-through-demo.hf.space';
const receiptKey=key=>sha256(String(key));
// Uses node:https directly; no proxy environment, login state, Cookie or automatic POST retry.
export function directRequest(url,{method='GET',headers={},body,signal,timeoutMs=45000}={}) {
  return new Promise((resolve,reject)=>{
    // Gradio clears SSE sessions on disconnect. Heartbeats must keep a long job alive;
    // a total-duration AbortSignal would cancel it even while the socket is active.
    const req=https.request(url,{method,headers,signal},res=>resolve({status:res.statusCode,ok:res.statusCode>=200&&res.statusCode<300,body:res}));req.setTimeout(timeoutMs,()=>req.destroy(new Error('BACKEND_CONNECTION_IDLE_TIMEOUT')));req.on('error',reject);req.end(body);
  });
}
async function readBytes(response,maxBytes) {
  const chunks=[];let size=0;for await(const chunk of response.body){const b=Buffer.from(chunk);size+=b.length;if(size>maxBytes){response.body.destroy?.();throw new Error('BACKEND_RESPONSE_TOO_LARGE');}chunks.push(b);}return Buffer.concat(chunks);
}
const readBodyJson=async response=>JSON.parse((await readBytes(response,2*1024*1024)).toString('utf8'));
function classify(status){return status===401?'BACKEND_AUTH_REQUIRED':status===403?'BACKEND_ACCESS_DENIED':status===429?'BACKEND_QUOTA_OR_QUEUE_LIMIT':'BACKEND_HTTP_ERROR';}
function urlAt(base,value) {const u=new URL(value,base);if(u.origin!==new URL(base).origin||u.protocol!=='https:'||u.username||u.password)throw new Error('BACKEND_FILE_ORIGIN_INVALID');return u;}
function semanticTags(name) {
  const n=name.toLowerCase().trim(),base=n.replace(/(?:[-_ ](?:left|right|l|r))$/,'');
  const map={'front hair':['hair','front'],'back hair':['hair','back'],hairf:['hair','front'],hairb:['hair','back'],face:['face'],irides:['eye','iris'],eyewhite:['eye','white'],eyebg:['eye','white'],eyelash:['eye','lash'],eyebrow:['brow'],ears:['ear'],earl:['ear'],earr:['ear'],mouth:['mouth'],neck:['neck'],neckwear:['neck','accessory'],headwear:['headwear'],eyewear:['eyewear'],earwear:['ear','accessory'],nose:['nose'],topwear:['top'],handwear:['arm'],bottomwear:['bottom'],legwear:['leg'],footwear:['foot'],tail:['tail'],wings:['wings'],objects:['object']};
  const tags=[...(map[base]||[])];const side=n.match(/(?:[-_ ](left|right|l|r))$/)?.[1]||(n==='earl'?'l':n==='earr'?'r':null);if(side)tags.push(['l','left'].includes(side)?'left':'right');return tags;
}
export { semanticTags };

/** Official Gradio 6.12 /inference adapter. See evidence/upstream/hf-info.json.
 * submit({operationKey,cacheKey,source,brief,recipe,rights,signal?})
 * query(jobId,{signal?}); recover({operationKey,signal?}).
 * A lost POST receipt is blocked as UNKNOWN; recover never creates a second job.
 */
export function createSeeThroughBackend({stateDir,baseUrl=SEE_THROUGH_URL,modelVersion='see-through-v3-demo-unpinned',resolution=768,seed=42,request=directRequest,queryTimeoutMs=45000}={}) {
  if(!stateDir)throw new Error('BACKEND_STATE_DIR_REQUIRED');const origin=new URL(baseUrl);if(origin.protocol!=='https:'||origin.username||origin.password||origin.search||origin.hash||origin.pathname!=='/')throw new Error('BACKEND_URL_INVALID');
  if(!Number.isInteger(resolution)||resolution<768||resolution>1280||resolution%64||!Number.isInteger(seed)||seed<0||seed>9999)throw new Error('BACKEND_RECIPE_INVALID');
  const base=origin.origin;let rootPromise;const root=()=>rootPromise??=mkdir(stateDir,{recursive:true}).then(()=>realpath(stateDir));
  const locks=new Set();const file=key=>`${receiptKey(key)}.json`;
  async function save(key,state){await writeJson(await root(),file(key),state);}
  async function saved(key){return readJson(await root(),file(key));}
  const sessionGone=raw=>typeof raw==='string'&&/^"?404:\s*Not Found"?$/.test(raw.trim());
  const failureNote=state=>state.errorSummary==='null'?'Backend reported a failed generation, but server-side error details were not exposed by the Gradio simple SSE API. Inspect provider logs; do not infer quota, authentication or model failure from null.':state.errorSummary;
  async function lostSession(state,raw){
    const previous={at:new Date().toISOString(),status:state.status,code:state.code||null,errorSummary:raw};
    state={...state,status:'blocked',code:'EXTERNAL_RESULT_UNKNOWN',errorSummary:raw,history:[...(state.history||[]),previous],note:'Gradio event session is unavailable. The original generation outcome is unknown; do not resubmit.'};
    await save(state.operationKey,state);return state;
  }
  async function corrected(state){return state?.status==='failed'&&state.code==='BACKEND_GENERATION_FAILED'&&sessionGone(state.errorSummary)?lostSession(state,state.errorSummary):state;}
  async function completed(state,signal) {
    const resultPath=`${receiptKey(state.operationKey)}.psd`;let psd;
    try{psd=await readFile(await safePath(await root(),resultPath));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(psd&&state.sourcePsdSha256&&sha256(psd)!==state.sourcePsdSha256)return {status:'blocked',jobId:state.jobId,code:'BACKEND_CACHE_CHANGED'};
    if(!psd){const data=state.output;if(!Array.isArray(data)||!data[0]?.path)return {status:'blocked',jobId:state.jobId,code:'BACKEND_OUTPUT_INVALID'};const f=data[0];let url;try{url=f.url?urlAt(base,f.url):urlAt(base,`/gradio_api/file=${encodeURIComponent(f.path)}`);}catch{return {status:'blocked',jobId:state.jobId,code:'BACKEND_FILE_ORIGIN_INVALID'};}
      const response=await request(url,{signal,timeoutMs:queryTimeoutMs});if(!response.ok)return {status:'blocked',jobId:state.jobId,code:classify(response.status),httpStatus:response.status};psd=await readBytes(response,128*1024*1024);await writeBound(await root(),resultPath,psd);
    }
    state={...state,sourcePsdSha256:sha256(psd)};await save(state.operationKey,state);
    let result;try{result=decodeLayeredPsd(psd);}catch(e){return {status:'blocked',jobId:state.jobId,code:'BACKEND_PIXELS_INVALID',note:e.message};}
    result.parts=result.parts.map(p=>({...p,tags:semanticTags(p.name),group:/^(face|eye|irides|nose|mouth|ear|brow)/i.test(p.name)?'head':'body',occlusion:{status:'inferred_unreviewed',note:'See-Through generative decomposition; exact hidden-region masks unavailable.'}}));
    result.quality={checks:[{name:'identity-preservation',layer:'visual',status:'not_run',note:'Real generated PSD requires source/composite comparison.'},{name:'occlusion-completion',layer:'visual',status:'not_run',note:'Provider inpainting is not proof of continuous skin or clean eye/mouth bases.'},{name:'default-composite',layer:'visual',status:'not_run',note:'Not human or user approved.'}],sourcePsdSha256:sha256(psd),sourceCanvasMapping:'Demo pads non-square inputs; verify against source before rigging.'};
    return {status:'completed',jobId:state.jobId,result};
  }
  async function resume(state,{signal}={}){
    state=await corrected(state);
    if(!state)return {status:'blocked',code:'BACKEND_RECEIPT_MISSING'};
    if(state.status==='completed')return completed(state,signal);
    if(['blocked','failed'].includes(state.status))return {status:state.status,jobId:state.jobId,code:state.code,httpStatus:state.httpStatus,...(state.errorSummary?{note:failureNote(state)}:{})};
    if(!state.jobId)return {status:'blocked',code:'EXTERNAL_RESULT_UNKNOWN',note:'Submission receipt is unknown; no automatic resubmission.'};
    return query(state.jobId,{signal,operationKey:state.operationKey});
  }
  async function query(jobId,{signal,operationKey}={}) {
    if(!/^[a-f0-9]{16,128}$/i.test(jobId))throw new Error('BACKEND_JOB_ID_INVALID');
    let state;
    if(operationKey)state=await saved(operationKey);
    else {const index=await readJson(await root(),`job-${jobId}.json`);if(index)state=await saved(index.operationKey);}
    if(!state||state.jobId!==jobId)return {status:'blocked',jobId,code:'BACKEND_RECEIPT_MISSING'};
    state=await corrected(state);
    if(state.status==='completed')return completed(state,signal);
    if(['blocked','failed'].includes(state.status))return {status:state.status,jobId,code:state.code,httpStatus:state.httpStatus,...(state.errorSummary?{note:failureNote(state)}:{})};
    let response;
    try{response=await request(`${base}/gradio_api/call/inference/${jobId}`,{signal,timeoutMs:queryTimeoutMs});if(!response.ok){if(response.status===404){state=await lostSession(state,'404: Not Found');return {status:'blocked',jobId,code:state.code,note:state.errorSummary,httpStatus:404};}return {status:'blocked',jobId,code:classify(response.status),httpStatus:response.status};}
      let pending='',size=0;const received=[];
      for await(const chunk of response.body){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>2*1024*1024)throw new Error('BACKEND_EVENT_TOO_LARGE');received.push(bytes);pending+=bytes.toString('utf8');pending=pending.replace(/\r\n/g,'\n');let end;
        while((end=pending.indexOf('\n\n'))>=0){const block=pending.slice(0,end);pending=pending.slice(end+2);const type=block.match(/^event:\s*(.+)$/m)?.[1];const raw=block.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');
          if(type==='complete'){state={...state,status:'completed',output:JSON.parse(raw)};await save(state.operationKey,state);response.body.destroy?.();return completed(state,signal);}
          if(type==='error'){
            const captured=Buffer.concat(received),eventPath=`${receiptKey(state.operationKey)}-error.sse`;
            await writeBound(await root(),eventPath,captured);
            state={...state,sseReceipt:{path:eventPath,sha256:sha256(captured),bytes:captured.length,httpStatus:response.status,event:type,data:raw.slice(0,1000),receivedAt:new Date().toISOString(),capturedThroughTerminalChunk:true}};
            state=sessionGone(raw)?await lostSession(state,raw):{...state,status:'failed',code:'BACKEND_GENERATION_FAILED',errorSummary:raw.slice(0,1000)};await save(state.operationKey,state);response.body.destroy?.();return {status:state.status,jobId,code:state.code,note:failureNote(state)};
          }
        }
      }
    }catch(e){if(signal?.aborted)throw e;return {status:'running',jobId,code:'BACKEND_QUERY_INTERRUPTED'};}
    return {status:'running',jobId,code:'BACKEND_RESULT_PENDING'};
  }
  async function submit(req) {
    if(!req?.operationKey||!req.cacheKey||!req.source?.bytes||req.rights?.allowDerivatives!==true)throw new Error('BACKEND_REQUEST_INVALID');
    if(req.source.sha256!==sha256(req.source.bytes))throw new Error('BACKEND_SOURCE_HASH_MISMATCH');const key=req.operationKey;
    if(locks.has(key))return {status:'blocked',code:'BACKEND_OPERATION_BUSY'};locks.add(key);
    try{const existing=await saved(key);if(existing){if(existing.cacheKey!==req.cacheKey)throw new Error('BACKEND_CACHE_IDENTITY_MISMATCH');return resume(existing,{signal:req.signal});}
      let state={schemaVersion:1,operationKey:key,cacheKey:req.cacheKey,sourceSha256:req.source.sha256,backendId:'see-through-gradio',modelVersion,status:'submitting',recipe:{resolution,seed,tblr_split:true}};
      // Exclusive receipt creation also prevents a second process from submitting this operation.
      const journal=await safePath(await root(),file(key));
      const {open}=await import('node:fs/promises');let fd;
      try{fd=await open(journal,'wx',0o600);await fd.writeFile(JSON.stringify(state,null,2)+'\n');}catch(e){if(e.code==='EEXIST')return resume(await saved(key),{signal:req.signal});throw e;}finally{await fd?.close();}
      const boundary=`----artwork${receiptKey(key).slice(0,24)}`,ext=req.source.mimeType==='image/jpeg'?'jpg':'png';const head=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="source.${ext}"\r\nContent-Type: ${ext==='jpg'?'image/jpeg':'image/png'}\r\n\r\n`),body=Buffer.concat([head,Buffer.from(req.source.bytes),Buffer.from(`\r\n--${boundary}--\r\n`)]);
      try{
        const upload=await request(`${base}/gradio_api/upload`,{method:'POST',headers:{'content-type':`multipart/form-data; boundary=${boundary}`,'content-length':String(body.length)},body,signal:req.signal});
        if(!upload.ok){state={...state,status:'blocked',code:classify(upload.status),httpStatus:upload.status};await save(key,state);return {status:'blocked',code:state.code,httpStatus:upload.status};}
        const uploaded=await readBodyJson(upload);if(!Array.isArray(uploaded)||typeof uploaded[0]!=='string')throw new Error('BACKEND_UPLOAD_INVALID');state={...state,uploadedPath:uploaded[0]};await save(key,state);
        const payload=Buffer.from(JSON.stringify({data:[{path:uploaded[0],meta:{_type:'gradio.FileData'}},resolution,seed,true]}));
        const call=await request(`${base}/gradio_api/call/inference`,{method:'POST',headers:{'content-type':'application/json','content-length':String(payload.length)},body:payload,signal:req.signal});
        if(!call.ok){state={...state,status:call.status>=400&&call.status<500?'blocked':'unknown',code:classify(call.status),httpStatus:call.status};await save(key,state);return {status:'blocked',code:state.status==='unknown'?'EXTERNAL_RESULT_UNKNOWN':state.code,httpStatus:call.status};}
        const receipt=await readBodyJson(call);if(!/^[a-f0-9]{16,128}$/i.test(receipt.event_id))throw new Error('BACKEND_RECEIPT_INVALID');state={...state,status:'running',jobId:receipt.event_id};await save(key,state);await writeJson(await root(),`job-${state.jobId}.json`,{operationKey:key});return {status:'running',jobId:state.jobId};
      }catch(e){state={...state,status:'unknown',code:'EXTERNAL_RESULT_UNKNOWN'};await save(key,state);return {status:'blocked',code:state.code};}
    }finally{locks.delete(key);}
  }
  return {id:'see-through-gradio',version:'1.0.0',modelVersion,recipe:{resolution,seed,tblr_split:true,baseUrl:base},submit,query,recover:async({operationKey,signal})=>resume(await saved(operationKey),{signal})};
}

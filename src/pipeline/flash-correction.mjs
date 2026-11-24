import {link,readdir} from 'node:fs/promises';
import {readJson,safePath,sha256} from '../artwork/files.mjs';
import {FLASH_ROUTE,flashRequestFromQuote} from '../artwork/runninghub-layered.mjs';

export const correctionOperation='artwork/operation-upload-correction-1013.json';
const originalOperation='artwork/operation.json', failureStage='artwork/failed-public-flash-stage.json';
const hash=s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);

// Read-only proof. A generic provider error, a bare job ID, or a pending POST never qualifies.
export async function inspectFlashCorrection({root,job,input,policy,operation}) {
  const auth=policy?.flashAuthorization,permit=auth?.uploadCorrection;
  if(policy?.enabled!==true||!permit||permit.allowUpload!==true||auth.taskId!==job.id||auth.candidateId!==job.candidateId||
    auth.revision!==job.revision||permit.maxUnitFen!==11||permit.maxOutputImages!==17||permit.maxEstimatedTotalFen!==187||
    !/^\d{8,32}$/.test(permit.failedJobId)||!hash(permit.failedOperationKey))return null;
  operation??=await readJson(job.output,originalOperation);
  if(operation?.status!=='failed'||operation.code!=='BACKEND_GENERATION_FAILED'||operation.backend?.id!=='runninghub-standard-flash'||
    operation.backend?.modelVersion!=='seedream-v5-flash'||operation.jobId!==permit.failedJobId||operation.operationKey!==permit.failedOperationKey||
    !hash(operation.cacheKey)||operation.operationKey!==sha256([job.id,job.candidateId,job.revision,operation.cacheKey].join(':')))return null;
  input??=await readJson(job.output,'intake/stage.json');
  if(input?.status!=='completed'||input.taskId!==job.id||input.candidateId!==job.candidateId||input.revision!==job.revision||
    operation.inputSha256!==input.inputSha256||operation.descriptionSha256!==input.descriptionSha256||!hash(input.sourceImage?.sha256))return null;
  const quote=await readJson(root,auth.quotePath);
  if(!quote||quote.source==='task_upload')return null;
  let original;try{original=flashRequestFromQuote(quote,input.inputSha256);}catch{return null;}
  const prefix='artwork/backend/',key=sha256(operation.operationKey);
  const [s,marker,index,archive]=await Promise.all([readJson(job.output,prefix+key+'.json'),readJson(job.output,prefix+key+'-inference.json'),
    readJson(job.output,prefix+'job-'+operation.jobId+'.json'),readJson(job.output,failureStage)]);
  const failure=archive??await readJson(job.output,'artwork/stage.json');
  if(!failure||failure.stage!=='artwork'||failure.status!=='failed'||failure.unresolved?.at(-1)?.code!=='BACKEND_GENERATION_FAILED'||
    ['taskId','candidateId','revision','inputSha256','descriptionSha256'].some(k=>failure[k]!==input[k]))return null;
  if(!s||s.operationKey!==operation.operationKey||s.cacheKey!==operation.cacheKey||s.jobId!==operation.jobId||
    s.backendId!==operation.backend.id||s.modelVersion!==operation.backend.modelVersion||s.status!=='failed'||s.code!==operation.code||
    s.providerStatus!=='FAILED'||s.errorType!=='1013'||s.queryReceipt?.httpStatus!==200||s.queryReceipt?.status!=='FAILED'||
    s.queryReceipt?.errorCode!=='1013'||!hash(s.queryReceipt.bodySha256)||!/file download timed out|文件下载超时/i.test(s.queryReceipt.errorMessage)||
    s.inferencePosts!==1||s.publicSource?.sha256!==input.inputSha256||s.source?.sha256!==input.sourceImage.sha256||
    s.recipe?.inputSha256!==input.inputSha256||s.recipe?.paramsSha256!==original.paramsSha256||s.recipe?.submitEndpoint!=='/openapi/v2/'+FLASH_ROUTE||
    s.recipeSha256!==sha256(JSON.stringify(s.recipe))||s.fingerprint!==sha256(JSON.stringify({cacheKey:s.cacheKey,source:s.source,recipe:s.recipe}))||
    marker?.phase!=='inference'||marker.operationKey!==s.operationKey||marker.cacheKey!==s.cacheKey||marker.fingerprint!==s.fingerprint||
    marker.recipeSha256!==s.recipeSha256||marker.source?.sha256!==s.source.sha256||index?.operationKey!==s.operationKey||
    [s.files,s.downloads,s.results].some(rows=>rows!=null&&(!Array.isArray(rows)||rows.length)))return null;
  if((await readdir(await safePath(job.output,'artwork/backend'))).some(name=>name.startsWith(key+'-layer-')))return null;
  return {original,failedOperationKey:s.operationKey,failedJobId:s.jobId,archiveExists:!!archive};
}
export async function archiveFlashFailure(output,proof) {
  if(proof.archiveExists)return;
  try{await link(await safePath(output,'artwork/stage.json'),await safePath(output,failureStage));}
  catch(e){if(e.code!=='EEXIST')throw e;}
}
export async function canResumeFailedFlash(root,job) {
  if(job.stage!=='artwork'||job.error?.code!=='BACKEND_GENERATION_FAILED'||await readJson(job.output,correctionOperation))return false;
  const policy=(await readJson(root,'config/project.json'))?.singleImage?.artwork;
  return policy?.budgetAuthorized===true&&!!await inspectFlashCorrection({root,job,policy});
}

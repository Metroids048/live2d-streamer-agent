import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

export class RigError extends Error {
  constructor(code,message=code,details={}) {super(message);this.code=code;this.details=details;}
}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function isSaveStorageFailure(pending,receipt) {
  return ['project_save_as','project_save'].includes(pending?.operation)&&!!pending.jobId&&
    receipt?.id===pending.jobId&&receipt.terminal===true&&receipt.status==='failed'&&
    receipt.project_id===pending.projectId&&receipt.input_state===pending.request?.state&&
    receipt.error?.code==='io_error'&&/No space left on device|ENOSPC/i.test(receipt.error.message??'');
}
export async function writeJson(file,value) {
  const tmp=file+'.tmp';await fs.writeFile(tmp,JSON.stringify(value,null,2)+'\n',{flag:'w'});await fs.rename(tmp,file);
}

function compactGeometryReceipt(data) {
  const geometry=data.geometry_diagnostics;
  if(geometry?.safe!==true||geometry.warnings?.length||geometry.violations?.length||
    !Array.isArray(geometry.diagnostics))return data;
  const {diagnostics,affectedCoordinates,...summary}=geometry;
  return {...data,geometry_diagnostics:{...summary,coordinateReportCount:diagnostics.length}};
}

// One candidate's durable operation journal. No retries of an edit whose outcome is unknown.
export class RigSession {
  constructor(ctx,dir,journal) {this.ctx=ctx;this.dir=dir;this.journal=journal;this.schemas=new Map();}
  async persist() {
    this.journal.updatedAt=new Date().toISOString();await writeJson(path.join(this.dir,'state.json'),this.journal);
    const {projectId,state,pending,updatedAt}=this.journal;
    await this.ctx.checkpoint?.({stage:'rigging',projectId,state,
      pending:pending?{operation:pending.operation,key:pending.key,jobId:pending.jobId??null}:null,
      completedSteps:Object.keys(this.journal.done).length,journalPath:'rigging/state.json',updatedAt});
  }
  async capturePlan(key,read) {
    const planning=this.journal.planning;
    // Older journals have no pre-edit snapshot. Their original request hash
    // remains the authority; don't persist current editor state as a baseline.
    if(!planning)return read();
    if(Object.hasOwn(planning,key))return planning[key];
    planning[key]=await read();
    await this.persist();
    return planning[key];
  }
  async raw(operation,request) {
    this.ctx.signal?.throwIfAborted();
    return this.ctx.engine.call(operation,request,{wait:false,unwrap:false,onJob:async job=> {
      if(this.journal.pending){this.journal.pending.jobId=job.id;this.journal.pending.status=job.status;await this.persist();}
    }});
  }
  async query(operation,request={}) {
    const r=await this.raw(operation,request);
    if(r.data?.id?.startsWith('job-'))throw new RigError('READ_RETURNED_JOB',operation);
    if(this.journal.projectId&&r.data?.project_id&&r.data.project_id!==this.journal.projectId)throw new RigError('ENGINE_PROJECT_CHANGED');
    if(this.journal.state&&r.data?.state&&r.data.state!==this.journal.state)throw new RigError('ENGINE_STATE_CHANGED');
    return r;
  }
  async inspect(scope) {return (await this.query('workspace_inspect',{scope})).data;}
  async list(scope) {
    const items=[];let offset=0;
    for(;;) {
      const r=(await this.query('workspace_inspect',{scope,offset,limit:64})).data;items.push(...r.items);
      if(r.next===undefined)break;if(!Number.isInteger(r.next)||r.next<=offset)throw new RigError('INVALID_INSPECT_PAGINATION');offset=r.next;
    }
    return items;
  }
  async assertCurrent() {
    const current=(await this.raw('workspace_inspect',{scope:'project'})).data;
    if(this.journal.projectId&&current.project_id!==this.journal.projectId)throw new RigError('ENGINE_PROJECT_CHANGED');
    if(this.journal.state&&current.state!==this.journal.state)throw new RigError('ENGINE_STATE_CHANGED');
    if(current.busy)throw new RigError('ENGINE_BUSY');return current;
  }
  async schema(operation) {
    if(!this.schemas.has(operation)) {
      const def=(await this.query('workspace_get_operation',{id:operation})).data;
      if(def.id!==operation||!def.request_schema)throw new RigError('ENGINE_OPERATION_SCHEMA_MISMATCH',operation);
      this.schemas.set(operation,def);await writeJson(path.join(this.dir,'schemas',operation+'.json'),def);
    }
    return this.schemas.get(operation);
  }
  async completePending(response) {
    let {data,images=[]}=response;
    while(data?.id?.startsWith('job-')) {
      this.journal.pending.jobId=data.id;this.journal.pending.status=data.status;await this.persist();
      if(!data.terminal) {
        response=await this.raw('job_wait',{id:data.id,timeout_ms:30000});data=response.data;images=response.images??[];continue;
      }
      if(data.status!=='completed') {
        const storage=isSaveStorageFailure(this.journal.pending,data);
        const error=new RigError(storage?'ENOSPC':'ENGINE_JOB_FAILED',data.error?.message??data.status,{jobId:data.id,status:data.status,error:data.error});
        this.journal.failed={...this.journal.pending,error:{code:error.code,message:error.message,details:error.details},
          ...(storage?{terminalReceipt:data}:{})};
        this.journal.pending=null;await this.persist();throw error;
      }
      data=data.result;if(!data)throw new RigError('ENGINE_JOB_RESULT_MISSING');break;
    }
    const pending=this.journal.pending;
    if(!data||typeof data!=='object')throw new RigError('ENGINE_RESULT_MISSING');
    if(typeof data.state!=='string'||!data.state||pending.lifecycle&&(typeof data.project_id!=='string'||!data.project_id))throw new RigError('ENGINE_RESULT_IDENTITY_MISSING');
    if(!pending.lifecycle&&this.journal.projectId&&data.project_id&&data.project_id!==this.journal.projectId)throw new RigError('ENGINE_RESULT_PROJECT_MISMATCH');
    if(data.project_id)this.journal.projectId=data.project_id;
    if(data.state)this.journal.state=data.state;
    const imageFiles=[];
    for(const [i,b] of images.entries()) {
      const file=path.join('operation-images',`${pending.key}-${i}.png`);await fs.writeFile(path.join(this.dir,file),b);imageFiles.push(file);
    }
    this.journal.done[pending.key]={operation:pending.operation,bodyHash:pending.bodyHash,data:compactGeometryReceipt(data),imageFiles,request_id:pending.request_id,jobId:pending.jobId??null};
    this.journal.pending=null;await this.persist();return {data,images};
  }
  async resume() {
    if(this.journal.failed)throw new RigError('PREVIOUS_ENGINE_OPERATION_FAILED','原编辑失败；需要新候选或定位修复，禁止同候选自动重交。',this.journal.failed);
    const pending=this.journal.pending;if(!pending)return;
    if(!pending.jobId)throw new RigError('ENGINE_SUBMISSION_UNKNOWN','原请求回执未知；保留 request_id，由总控核原任务，禁止再次提交。',pending);
    // Lookup is deliberately independent of the currently loaded GUI project; never cancel/restore it here.
    let r;
    try {r=await this.raw('job_get',{id:pending.jobId});}
    catch {throw new RigError('ENGINE_JOB_QUERY_UNKNOWN','原 job 暂无法查询，未重交。',pending);}
    if(r.data?.id!==pending.jobId)throw new RigError('ENGINE_JOB_ID_MISMATCH');
    if(r.data.project_id&&pending.projectId&&r.data.project_id!==pending.projectId)throw new RigError('ENGINE_JOB_PROJECT_MISMATCH');
    await this.completePending(r);
  }
  // A process crash with no outstanding edit can reopen the exact committed
  // history. Only its process-local state changes; completed edits stay intact.
  async recoverCommitted({checkpoint,lastStepKey,archive,openReceipt,evidence,storageRepairId}) {
    const last=this.journal.done[lastStepKey]?.data;
    const revision=last?.revision??checkpoint?.nativeHead?.revisionId;
    const failed=this.journal.failed;
    const storage=storageRepairId&&isSaveStorageFailure(failed,failed?.terminalReceipt)&&
      failed.projectId===this.journal.projectId&&failed.request.state===this.journal.state;
    if(this.journal.pending||failed&&!storage||!last||last.project_id!==this.journal.projectId||last.state!==this.journal.state||
      !last.history_node_id||!revision||!last.revision&&checkpoint?.nativeHead?.id!==last.history_node_id||
      checkpoint?.state!==this.journal.state||checkpoint?.historyHead!==last.history_node_id||
      archive?.projectId!==this.journal.projectId||archive?.historyNodeId!==last.history_node_id||archive?.revision!==revision||
      !/^[a-f0-9]{64}$/.test(archive?.sha256??'')||typeof evidence!=='string'||!evidence.trim())
      throw new RigError('ENGINE_COMMITTED_RECOVERY_MISMATCH');
    const current=(await this.raw('workspace_inspect',{scope:'project'})).data;
    const history=(await this.raw('history_list',{})).data;
    const head=history?.nodes?.find(n=>n.id===history.headNodeId&&n.isHead===true);
    if(current?.loaded!==true||current.busy!==false||current.project_id!==this.journal.projectId||
      current.history_node_id!==last.history_node_id||history?.headNodeId!==last.history_node_id||head?.revisionId!==revision||!current.state||
      openReceipt?.project_id!==current.project_id||openReceipt?.state!==current.state||
      openReceipt?.history_node_id!==current.history_node_id||openReceipt?.revision!==head.revisionId)
      throw new RigError('ENGINE_COMMITTED_RECOVERY_REOPEN_MISMATCH');
    this.journal.recoveries??=[];
    this.journal.recoveries.push({kind:'committed-history-reopen',fromState:this.journal.state,toState:current.state,
      lastStepKey,checkpoint,archive,openReceipt,evidence,recordedAt:new Date().toISOString()});
    if(storage) {
      this.journal.repairs??=[];
      this.journal.repairs.push({failed,receipt:failed.terminalReceipt,receiptOrigin:'committed-history-reopen',
        repairId:storageRepairId,evidence,recordedAt:new Date().toISOString()});
      this.journal.requestRepairs??={};this.journal.requestRepairs[failed.key]=storageRepairId;
      this.journal.failed=null;
    }
    for(const entry of Object.values(this.journal.done))entry.data=compactGeometryReceipt(entry.data);
    this.journal.state=current.state;await this.persist();
  }
  // Explicit repair only: a diagnosed, terminal failure is retained, never treated as a completed edit.
  async recoverFailed({requestId,jobId,bodyHash,operation,repairId,evidence,archivedReceipt,controlledReopen}) {
    const failed=this.journal.failed;
    if(!failed||this.journal.pending||failed.request_id!==requestId||failed.jobId!==jobId||failed.bodyHash!==bodyHash||
      !/^[a-f0-9]{64}$/.test(bodyHash??'')||failed.projectId!==this.journal.projectId||failed.request.state!==this.journal.state||
      typeof repairId!=='string'||!repairId.trim()||typeof evidence!=='string'||!evidence.trim())throw new RigError('ENGINE_REPAIR_MISMATCH');
    // A native validation rejection has no job and accepted no edit. Keep that
    // real rejection instead of inventing a terminal job receipt.
    const rejected=failed.error?.code==='MAKER_REJECTED'&&['invalid_argument','topology_refused'].includes(failed.error.details?.detail?.code)&&!failed.jobId;
    if(!failed.jobId&&(!rejected||operation!==failed.operation||failed.error.details.operation!==operation||archivedReceipt||controlledReopen))
      throw new RigError('ENGINE_REPAIR_MISMATCH');
    // Jobs are process-local. A controlled restart may use its saved terminal receipt.
    const receipt=rejected?structuredClone(failed.error):archivedReceipt??(await this.raw('job_get',{id:jobId})).data;
    if(!rejected&&(receipt?.id!==jobId||receipt.terminal!==true||receipt.status!=='failed'||
      receipt.project_id!==this.journal.projectId||receipt.input_state!==failed.request.state))throw new RigError('ENGINE_REPAIR_NOT_TERMINAL');
    let current;
    if(controlledReopen) {
      const {before,after,contentHashes,openReceipt}=controlledReopen;
      current=(await this.raw('workspace_inspect',{scope:'project'})).data;
      const sameContent=['document','configuration','layers'].every(k=>/^[a-f0-9]{64}$/.test(contentHashes?.[k]?.before??'')&&contentHashes[k].before===contentHashes[k].after);
      if(!sameContent||before?.projectId!==this.journal.projectId||before?.state!==this.journal.state||
        before?.historyNodeId!==after?.historyNodeId||before?.revision!==after?.revision||!before?.revision||
        after?.projectId!==before.projectId||after?.projectId!==current.project_id||after?.state!==current.state||
        current.history_node_id!==after.historyNodeId||current.busy!==false||current.loaded!==true||
        openReceipt?.state!==current.state||openReceipt?.project_id!==current.project_id||openReceipt?.history_node_id!==current.history_node_id)
        throw new RigError('ENGINE_REPAIR_REOPEN_MISMATCH');
    } else current=await this.assertCurrent();
    this.journal.repairs??=[];
    this.journal.repairs.push({failed:structuredClone(failed),receipt,receiptOrigin:rejected?'rejected-before-accept':archivedReceipt?'before-controlled-restart':'live',project:current,controlledReopen,repairId,evidence,recordedAt:new Date().toISOString()});
    this.journal.requestRepairs??={};this.journal.requestRepairs[failed.key]=repairId;
    this.journal.state=current.state;this.journal.failed=null;await this.persist();
  }
  async step(key,operation,body={}, {lifecycle=false}={}) {
    if(this.journal.failed)throw new RigError('PREVIOUS_ENGINE_OPERATION_FAILED');
    const bodyHash=hash({operation,body,lifecycle}),done=this.journal.done[key];
    if(done) {
      if(done.bodyHash!==bodyHash||done.operation!==operation)
        throw new RigError('RECIPE_CHANGED_USE_NEW_CANDIDATE',undefined,{key,operation});
      return {data:done.data,images:await Promise.all(done.imageFiles.map(f=>fs.readFile(path.join(this.dir,f))))};
    }
    if(this.journal.pending)throw new RigError('ENGINE_PENDING_OPERATION');
    this.ctx.signal?.throwIfAborted();await this.ctx.progress?.({stage:'rigging',operation,key});
    const def=await this.schema(operation),current=await this.assertCurrent();
    const repairId=this.journal.requestRepairs?.[key];
    const request_id='rig-'+hash({identity:this.journal.identity,key,operation,body,...(repairId?{repairId}:{})}).slice(0,48);
    const properties=def.request_schema.properties??{};
    const request={...body};
    if(properties.request_id)request.request_id=request_id;
    if(properties.project_id)request.project_id=current.project_id??null;
    if(properties.state)request.state=current.state;
    validateRequest(request,def.request_schema);
    this.journal.pending={key,operation,bodyHash,request_id,request,projectId:current.project_id??null,lifecycle,status:'submitting'};
    await this.persist();
    let response;
    try {response=await this.raw(operation,request);}
    catch(error) {
      // Result-contract validation happens after the native commit. Its outcome
      // needs inspection, just like a lost reply; never mark it safe to replay.
      if(error.code==='MAKER_REJECTED'&&error.details?.detail?.code!=='output_contract') {
        this.journal.failed={...this.journal.pending,error:{code:error.code,message:error.message,details:error.details}};
        this.journal.pending=null;await this.persist();
      }
      throw error;
    }
    return this.completePending(response);
  }
}

// Exact runtime operation schemas are inspected before edits; no guessed extra fields.
export function validateRequest(value,schema,location='request') {
  const fail=()=>{throw new RigError('ENGINE_REQUEST_SCHEMA',location);};
  if(schema.oneOf||schema.anyOf) {
    const variants=schema.oneOf??schema.anyOf;
    const matches=variants.filter(s=>{try{validateRequest(value,s,location);return true;}catch{return false;}});
    if(!matches.length||schema.oneOf&&matches.length!==1)fail();return;
  }
  if(schema.const!==undefined&&value!==schema.const||schema.enum&&!schema.enum.includes(value))fail();
  if(schema.type&&!(Array.isArray(schema.type)?schema.type:[schema.type]).some(t=>t==='null'?value===null:t==='object'?value!==null&&typeof value==='object'&&!Array.isArray(value):t==='array'?Array.isArray(value):t==='integer'?Number.isInteger(value):t==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===t))fail();
  if(value&&typeof value==='object'&&!Array.isArray(value)) {
    for(const k of schema.required??[])if(!Object.hasOwn(value,k))fail();
    if(schema.minProperties!==undefined&&Object.keys(value).length<schema.minProperties)fail();
    for(const [k,v] of Object.entries(value)) {
      const sub=schema.properties?.[k];
      if(sub)validateRequest(v,sub,`${location}.${k}`);
      else if(schema.additionalProperties===false)fail();
      else if(schema.additionalProperties&&typeof schema.additionalProperties==='object')validateRequest(v,schema.additionalProperties,`${location}.${k}`);
    }
  }
  if(Array.isArray(value)) {
    if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity))fail();
    if(schema.items)value.forEach((v,i)=>validateRequest(v,schema.items,`${location}[${i}]`));
  }
  if(typeof value==='number'&&(value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum||schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum))fail();
  if(typeof value==='string'&&(value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern).test(value)))fail();
}

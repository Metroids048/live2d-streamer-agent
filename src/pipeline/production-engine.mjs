import * as fs from 'node:fs/promises';
import path from 'node:path';
import {Fault} from '../rpc.mjs';
import {Psd2Live} from '../psd2live.mjs';
import {acquireEngineLease,identityKeys} from './lease.mjs';
import {recoverCommittedRig} from '../rigging/storage-recovery.mjs';

// Use the running server's MCP initialize handshake, not the version written into a manifest.
export class PinnedPsd2Live extends Psd2Live {
  async rpc(method,params) {
    const data=await super.rpc(method,params);
    if(method==='initialize'&&(data?.serverInfo?.name!=='psd2live'||data.serverInfo.version!=='3.6.7'))
      throw new Fault('ENGINE_BUILD_MISMATCH','当前制作服务没有报告固定的 PSD2Live 3.6.7，未发送制作请求');
    return data;
  }
}
const alive=pid=>{if(!Number.isInteger(pid)||pid<=0)return true;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const reads=new Set(['workspace_get_operation','workspace_inspect','history_list','job_list','mesh_get_topology','view_render_model',
  'view_render_poses','expression_list','motion_get','motion_sample']);

// Every engine phase calls this through the production worker only after valid Artwork.
// The stage journals own replay/recovery; this guard owns the shared editor and refuses foreign writes.
export function createStageEngine({root,client,ensureEngine,location,runtime}) {
  return async function withEngine(stage,source,ctx,run) {
    const owner={...Object.fromEntries(identityKeys.map(k=>[k,source[k]])),stage};
    if(identityKeys.slice(0,4).some(k=>ctx[k]!==owner[k]))throw new Fault('ENGINE_LEASE_IDENTITY','任务与工程租约身份不符');
    const start={at:new Date().toISOString(),tick:performance.now()};
    let lease;
    try {lease=await acquireEngineLease(root,owner);}
    catch(e) {await ctx.recordTiming?.(stage,'acquire_engine_lease',start,e.code??'failed');throw e;}
    let keep=false;
    try {
      await ctx.recordTiming?.(stage,'acquire_engine_lease',start,'acquired');

      // A saved or foreign project can be replaced by project_import_layout even when not dirty.
      // Check ownership before entering buildRig (which writes a stage journal).
      let expected=source.engineProjectId??source.projectId??null,storageJournal,hasJournal=false;
      const journalFile=path.join(ctx.taskRoot,stage==='rigging'?'rigging/state.json':
        source.stage==='dynamics'?'dynamics/preview/engine-journal.json':'dynamics/engine-journal.json');
      try {
        if(await fs.realpath(journalFile)!==journalFile)throw new Fault('REFERENCE_INVALID','引擎检查点不能是链接');
        const journal=JSON.parse(await fs.readFile(journalFile,'utf8'));
        hasJournal=true;
        const identity=stage==='rigging'?journal.identity:journal;
        if((stage==='rigging'||journal.schemaVersion===2?identityKeys:['taskId','candidateId','revision']).some(k=>identity?.[k]!==owner[k]))
          throw new Fault('ENGINE_LEASE_IDENTITY','引擎检查点属于另一版本');
        if(stage==='rigging')expected=journal.projectId??null;
        if(stage==='rigging'&&ctx.riggingStorageRecovery&&journal.failed)storageJournal=journal;
        const last=journal.steps?.at(-1);
        if(stage==='dynamics'&&last)expected=last.result?.project_id??last.request?.project_id??expected;
        const p=journal.pending;
        if(stage==='dynamics'&&!p&&lease.record.pending){
          const entry=journal.failure??last,prior=lease.record.pending;
          if(!entry||entry.operation!==prior.operation||entry.request?.request_id!==prior.requestId||!prior.jobId||entry.jobId!==prior.jobId)
            throw new Fault('ENGINE_LEASE_IDENTITY','原租约与持久化终态步骤不一致');
          await lease.update({pending:null});
        }
        if(p) {
          const requestId=p.request_id??p.request?.request_id,prior=lease.record.pending;
          if(prior&&(prior.operation!==p.operation||prior.requestId!==requestId||prior.jobId&&p.jobId&&prior.jobId!==p.jobId))
            throw new Fault('ENGINE_LEASE_IDENTITY','编辑日志和独占租约的原操作不符');
          await lease.update({pending:{operation:p.operation,requestId,jobId:prior?.jobId??p.jobId??null,projectId:p.projectId??p.request?.project_id??null}});
          // Stage recovery uses its own durable journal. Repair only a lost job ID when the
          // lease captured it before a worker interruption; never invent an id or repeat a write.
          if(!p.jobId&&prior?.jobId) {
            p.jobId=prior.jobId;const tmp=journalFile+'.'+lease.record.leaseId+'.tmp';
            await fs.writeFile(tmp,JSON.stringify(journal,null,2)+'\n',{flag:'wx',mode:0o600});await fs.rename(tmp,journalFile);
          }
        }
      }catch(e){if(e.code!=='ENOENT')throw e;}
      if(stage==='rigging') {
        const file=path.join(ctx.taskRoot,'rigging/.build.lock');
        try {
          if(await fs.realpath(file)!==file)throw new Fault('REFERENCE_INVALID','绑定锁不能是链接');
          const lock=JSON.parse(await fs.readFile(file,'utf8'));
          if(lock.taskId===owner.taskId&&lock.candidateId===owner.candidateId&&!alive(lock.pid))await fs.unlink(file);
          else throw new Fault('ENGINE_BUSY','绑定或审查仍在运行，保留原锁');
        }catch(e){if(e.code!=='ENOENT')throw e;}
      }
      await ensureEngine({recoverOnly:!!lease.record.pending});
      if(storageJournal) {
        if(!runtime?.engineRuntimePatch||!location?.args.length)
          throw new Fault('ENGINE_BUILD_MISMATCH','缺少绑定原工程的独立引擎或固定运行组件');
        await recoverCommittedRig({root,taskRoot:ctx.taskRoot,engineDir:location.dir,runtime:runtime.engineRuntimePatch,
          client,lease,journal:storageJournal,storage:true});
      }
      let bound=expected,terminalJob=null;
      const inspect=async()=> (await client.call('workspace_inspect',{scope:'project'})).data;
      const matches=s=>typeof s.loaded==='boolean'&&s.busy===false&&
        (s.loaded?!!bound&&s.project_id===bound:!bound&&s.project_id==null);
      let emptyDynamicsState;
      if(!lease.record.pending) {
        const live=await inspect();
        if(stage==='dynamics'&&source.stage==='rigging'&&source.status==='completed'&&
          location?.args.length>=3&&!hasJournal&&live.loaded===false&&live.project_id==null&&live.busy===false&&live.state) {
          bound=null;
          emptyDynamicsState=live.state;
        }
        if(!matches(live))throw new Fault('ENGINE_PROJECT_OCCUPIED','专用编辑器当前工程与候选不符或仍忙；保持原工程并等待恢复');
      }
      const call=async(op,request={},options={})=>{
        await lease.assertHeld();
        let pending=lease.record.pending;
        if(op==='job_get'||op==='job_wait') {
          if(!pending?.jobId||request.id!==pending.jobId)throw new Fault('ENGINE_PENDING_MISMATCH','仅可查询本候选的原作业回执');
          const r=await client.call(op,request,{...options,wait:false,unwrap:false});
          if(r.data?.id!==pending.jobId)throw new Fault('ENGINE_PENDING_MISMATCH','回读作业身份不符');
          if(stage==='dynamics'){terminalJob=r.data.terminal?r.data:null;return r;}
          if(r.data.terminal) {
            if(r.data.status==='completed'&&r.data.result?.project_id)bound=r.data.result.project_id;
            await lease.update({pending:null});
          }
          return r;
        }
        if(stage==='dynamics'&&terminalJob?.status==='completed'&&op==='workspace_inspect'&&request.scope==='project')return client.call(op,request,options);
        if(pending)throw new Fault('ENGINE_SUBMISSION_UNKNOWN','编辑结果未知，仅允许查询原作业',{pending});
        if(reads.has(op))return client.call(op,request,options);
        // The lifecycle request must itself name the exact state inspected, to close races with other editor users.
        const state=await inspect();
        if(!matches(state)||!request.state||request.state!==state.state||
          (request.project_id??null)!==(state.project_id??null)||!request.request_id)
          throw new Fault('MAKER_REJECTED','工程或编辑器版本已改变，未提交写入');
        if(op==='project_import_layout'&&(bound||request.discard_unsaved!==false))
          throw new Fault('MAKER_REJECTED','仅可向空编辑器导入当前候选');
        if(emptyDynamicsState&&!bound&&(op!=='project_open'||request.path!==path.join(ctx.taskRoot,'dynamics/character.psd2live')))
          throw new Fault('MAKER_REJECTED','空编辑器只允许打开当前绑定工程的校验副本');
        pending={operation:op,requestId:request.request_id,jobId:null,projectId:state.project_id??null};
        await lease.update({pending});
        try {
          const r=await client.call(op,request,{...options,onJob:async job=>{
            await lease.update({pending:{...pending,jobId:job.id}});await options.onJob?.(job);
          }});
          if(r.data?.id?.startsWith('job-')&&!r.data.terminal) {
            if(lease.record.pending.jobId!==r.data.id)await lease.update({pending:{...pending,jobId:r.data.id}});
          }else {
            const result=r.data?.terminal?r.data.result:r.data;if(result?.project_id)bound=result.project_id;
            await lease.update({pending:null});
          }
          return r;
        } catch(e) {
          if(e.code==='MAKER_JOB_FAILED'||e.code==='MAKER_REJECTED'&&(!e.details?.operation||e.details.operation===op))await lease.update({pending:null});
          throw e;
        }
      };
      const acknowledgeJob=async id=>{
        await lease.assertHeld();
        if(!id||lease.record.pending?.jobId!==id||terminalJob?.id!==id)throw new Fault('ENGINE_PENDING_MISMATCH','原作业与确认回执不符');
        bound=terminalJob.result?.project_id??lease.record.pending.projectId;terminalJob=null;await lease.update({pending:null});
      };
      const result=await run({...ctx,emptyDynamicsState,engine:{call,acknowledgeJob}});
      keep=result?.status==='awaiting_external_result';
      return result;
    } finally {await lease.release({outcomeUnknown:keep});}
  };
}

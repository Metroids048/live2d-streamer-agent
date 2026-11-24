import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual,promisify} from 'node:util';
import {execFile} from 'node:child_process';
import {Fault} from '../rpc.mjs';
import {archive} from '../packaging/archive.mjs';
import {artifact,digest,listFiles,relativePath,verifyArtifacts,writeJson} from './files.mjs';

export const receiptDigest=value=>createHash('sha256').update(value).digest('hex');
const reject=message=>{throw new Fault('DYNAMICS_RECEIPT_UNVERIFIED',message);};
const exec=promisify(execFile);

async function evidence(root,operation,body,result,{terminal=false}={}) {
  if(body.path) {
    if(await fs.realpath(body.path)!==body.path)reject('工程路径已改变');
    if(terminal) {
      const project=await archive({action:'project',file:body.path});
      const read=async name=>JSON.parse((await exec('/usr/bin/unzip',['-p',body.path,name],{maxBuffer:16*1024*1024})).stdout);
      const head=await read('history/HEAD.json');
      if(project.projectId!==result.project_id||head.headNodeId!==result.history_node_id)reject('工程归属或历史节点与终态不符');
      const node=await read('history/nodes/'+receiptDigest(head.headNodeId)+'.json');
      if(node.id!==head.headNodeId||node.revisionId!==result.revision)reject('已保存工程的修订与原回执不符');
    }
    return [await artifact(root,relativePath(root,body.path),'engine-project')];
  }
  if(!body.output_directory)return [];
  const dir=body.output_directory;
  if(await fs.realpath(dir)!==dir)reject('导出目录已改变');
  const files=await listFiles(dir);
  if(terminal) {
    if(!result.revision||!Array.isArray(result.files)||!result.files.length)reject('导出终态没有完整产物清单');
    if(operation==='project_export_model') {
      if(result.files.length!==files.length||new Set(result.files.map(f=>f.path)).size!==files.length)reject('模型导出清单数量不符');
      for(const f of result.files)if(!files.includes(f.path)||(await fs.stat(f.path)).size!==f.bytes)reject('模型导出路径或大小不符');
    }else {
      if(result.directory!==dir||result.target!=='mp4'||!Array.isArray(result.losses))reject('预览导出归属不符');
      const claimed=result.files.map(f=>typeof f==='string'&&path.resolve(dir,f));
      const video=files.filter(f=>f.endsWith('.mp4'));
      if(video.length!==1||!claimed.includes(video[0])||claimed.some(f=>!files.includes(f)))reject('原预览回执与视频文件不符');
    }
  }
  return Promise.all(files.map(f=>artifact(root,relativePath(root,f),'engine-export')));
}

// Replay only the verified prefix. The first new write must still match the current live project and state.
export function engineRun({root,journal,file,ctx,project,state,preview=false}) {
  let cursor=0;
  const persist=()=>writeJson(file,journal);
  const inspect=async()=>{
    ctx.signal?.throwIfAborted();
    const s=(await ctx.engine.call('workspace_inspect',{scope:'project'})).data;
    if(s.loaded!==(project!==null)||s.busy||(s.project_id??null)!==project||s.state!==state)
      throw new Fault('ENGINE_BUSY','编辑器工程或版本与原回执不一致');
    return s;
  };
  async function step(name,operation,body={}) {
    const requestId=(preview?'dyn-preview-':'dyn-')+receiptDigest([journal.taskId,journal.candidateId,journal.revision,name].join(':')).slice(0,preview?32:40);
    const request={...body,request_id:requestId,project_id:project,state};
    const done=journal.steps[cursor],pending=journal.pending;
    if(done) {
      if(done.name!==name||done.operation!==operation||done.requestId!==requestId||!isDeepStrictEqual(done.request,request))
        reject('已完成操作与本版确定性制作轨迹不符');
      // Opening a clone/scratch precedes saving new bytes at the same path.
      const overwritten=body.path&&[...journal.steps.slice(cursor+1),pending].some(s=>s?.operation==='project_save_as'&&s.request?.path===body.path);
      if(!Array.isArray(done.files)||(!done.files.length&&(body.path||body.output_directory))||!done.result?.state||
        operation==='project_open'&&!done.result.project_id)reject('历史步骤缺少工程文件或状态凭据');
      if(!overwritten)await verifyArtifacts(root,done.files);
      project=done.result.project_id??project;state=done.result.state;cursor++;return done.result;
    }
    let r;
    if(pending) {
      if(pending.name!==name||pending.operation!==operation||!isDeepStrictEqual(pending.request,request))reject('未决请求与本版制作轨迹不符');
      if(!pending.jobId)reject('原请求仍无作业编号，禁止重交');
      // A rejected lookup (e.g. after the server restarted) does not prove that its original edit failed.
      let job;
      try {job=(await ctx.engine.call('job_get',{id:pending.jobId},{wait:false,unwrap:false})).data;}
      catch {reject('原作业查询不可用，保留请求');}
      if(job.id!==pending.jobId||job.operation!==operation||(job.project_id??null)!==project||job.input_state!==state)reject('原作业编号、操作或工程状态不符');
      if(!job.terminal)reject('原作业仍在运行');
      if(['failed','cancelled'].includes(job.status)) {
        journal.failure={...pending,code:'MAKER_JOB_FAILED',message:job.error?.message??job.status,terminal:job.status};
        journal.pending=null;await persist();await ctx.engine.acknowledgeJob?.(job.id);
        throw new Fault('MAKER_JOB_FAILED',journal.failure.message);
      }
      r=job.result;
      if(job.status!=='completed'||!r?.state||operation==='project_open'&&!r.project_id||
        operation!=='project_open'&&r.project_id&&r.project_id!==project)reject('原作业未提供可核实的成功结果');
      const live=(await ctx.engine.call('workspace_inspect',{scope:'project'})).data;
      if(!live.loaded||live.busy||live.project_id!==(r.project_id??project)||live.state!==r.state||
        (live.history_node_id&&r.history_node_id&&live.history_node_id!==r.history_node_id))reject('当前编辑器与该作业成功后状态不符');
    }else {
      await inspect();
      if(body.output_directory&&(await fs.readdir(body.output_directory)).length)reject('未提交的导出目录已经有文件，保留现场');
      journal.pending={name,operation,request,jobId:null,startedAtUtc:new Date().toISOString()};await persist();
      await ctx.checkpoint?.({stage:'dynamics',status:'running',pending:journal.pending});
      try {
        r=(await ctx.engine.call(operation,request,{onJob:async job=>{
          journal.pending.jobId=job.id;await persist();
          await ctx.checkpoint?.({stage:'dynamics',status:'running',pending:journal.pending});
        }})).data;
      }catch(e){
        const rejected=e.code==='MAKER_REJECTED'&&(!e.details?.operation||e.details.operation===operation);
        if(rejected||e.code==='MAKER_JOB_FAILED'){
          journal.failure??={...journal.pending,code:e.code,message:e.message};journal.pending=null;await persist();
        }
        throw e;
      }
    }
    if(!r?.state||operation==='project_open'&&!r.project_id||operation!=='project_open'&&r.project_id&&r.project_id!==project)
      reject('缺少预期的制作状态或工程回执');
    const files=await evidence(root,operation,body,r,{terminal:!!pending});
    const recorded=journal.pending;
    journal.steps.push({name,operation,requestId,request,jobId:recorded.jobId,result:r,files,startedAtUtc:recorded.startedAtUtc,
      elapsedMs:Math.max(0,Date.now()-Date.parse(recorded.startedAtUtc??journal.startedAtUtc))||0,...(pending?{recovered:true}:{})});
    journal.pending=null;await persist();
    if(pending)await ctx.engine.acknowledgeJob?.(recorded.jobId);
    state=r.state;project=r.project_id??project;cursor++;
    await ctx.progress?.({stage:'dynamics',step:name});return r;
  }
  async function complete() {
    if(cursor!==journal.steps.length||journal.pending)reject('同版轨迹仍有未确认的原操作');
    return inspect();
  }
  return {step,inspect,complete,get project(){return project;},get state(){return state;},get replaying(){return cursor<journal.steps.length||!!journal.pending;}};
}

export async function outputDirectory(directory,recovery) {
  try {await fs.mkdir(directory);}
  catch(e) {if(e.code!=='EEXIST'||!recovery)throw e;
    if(await fs.realpath(directory)!==directory||!(await fs.stat(directory)).isDirectory())reject('原输出目录无效');}
}

export async function originalCopy(source,target,recovery,changed) {
  if(recovery) {
    try {if(await fs.realpath(target)!==target||!changed&&await digest(target)!==await digest(source))reject('候选工程副本已改变');return;}
    catch(e){if(e.code!=='ENOENT'||changed)throw e;}
  }
  await fs.copyFile(source,target,fs.constants.COPYFILE_EXCL);
}

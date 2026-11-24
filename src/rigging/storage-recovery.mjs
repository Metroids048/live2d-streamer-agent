import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {RigSession,isSaveStorageFailure,validateRequest,writeJson} from './engine.mjs';

const exec=promisify(execFile);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const optional=async file=>read(file).catch(error=>{if(error.code!=='ENOENT')throw error;return null;});

// Reopen only an exact committed native head. The copy is used to serialize an
// archive without adding a history node or modifying the original worktree.
export async function recoverCommittedRig({root,taskRoot,engineDir,runtime,client,lease,journal,storage=false}) {
  const dir=path.join(taskRoot,'rigging'),stateFile=path.join(dir,'state.json');
  const stateBytes=await fs.readFile(stateFile);
  assert.deepEqual(JSON.parse(stateBytes),journal);
  const failed=journal.failed;
  assert(!journal.pending&&(!failed&&!storage||storage&&isSaveStorageFailure(failed,failed?.terminalReceipt)));
  assert.match(journal.projectId,/^[a-f0-9-]{36}$/);
  const lastStepKey=Object.keys(journal.done).findLast(key=>journal.done[key].data?.state===journal.state);
  const last=journal.done[lastStepKey]?.data;
  assert(last?.history_node_id&&last.project_id===journal.projectId,'No matching committed native edit');
  const suffix='committed-'+sha(stateBytes).slice(0,16);
  const recoveryDir=path.join(taskRoot,'rigging-recovery',suffix),evidence=path.relative(taskRoot,recoveryDir);
  const requestFile=path.join(recoveryDir,'request.json'),openFile=path.join(recoveryDir,'open-receipt.json');
  const archivePath=path.join(recoveryDir,'committed.psd2live');
  const session=new RigSession({engine:client},dir,journal);
  const repairId=storage?'storage-'+sha(stateBytes).slice(0,32):undefined;
  const current=(await client.call('workspace_inspect',{scope:'project'})).data;
  assert.equal(current.busy,false);
  const saved=await optional(requestFile);
  if(storage&&!saved&&!lease.record.pending&&current.loaded) {
    const history=(await client.call('history_list',{})).data;
    assert.equal(current.project_id,journal.projectId);
    assert.equal(current.state,journal.state);
    assert.equal(current.history_node_id,last.history_node_id);
    assert.equal(history.headNodeId,last.history_node_id);
    if(last.revision)assert.equal(history.nodes.find(node=>node.id===history.headNodeId)?.revisionId,last.revision);
    await fs.mkdir(recoveryDir,{recursive:true});
    await fs.writeFile(path.join(recoveryDir,'state-before.json'),stateBytes,{flag:'wx'});
    await session.recoverFailed({requestId:failed.request_id,jobId:failed.jobId,bodyHash:failed.bodyHash,
      operation:failed.operation,repairId,evidence});
    const result={status:'recovered',mode:'same-editor',projectId:journal.projectId,state:journal.state,lastStepKey};
    await writeJson(path.join(recoveryDir,'result.json'),result);return result;
  }
  let request,checkpoint,archive,openReceipt;
  if(saved) {
    ({request,checkpoint,archive}=saved);
    assert.equal(saved.stateSha256,sha(stateBytes));
    assert.equal(archive.sha256,sha(await fs.readFile(archivePath)));
    openReceipt=await optional(openFile);
    const pending=lease.record.pending;
    if(pending) {
      assert(pending.operation==='project_open'&&pending.requestId===request.request_id);
      if(!openReceipt) {
        if(!pending.jobId)throw Object.assign(new Error('原工程重开回执未知'),{code:'ENGINE_SUBMISSION_UNKNOWN'});
        const job=(await client.call('job_wait',{id:pending.jobId,timeout_ms:30000},{wait:false,unwrap:false})).data;
        if(job?.id!==pending.jobId||job.terminal!==true||job.status!=='completed'||!job.result)
          throw Object.assign(new Error('原工程重开尚无成功回执'),{code:'ENGINE_SUBMISSION_UNKNOWN'});
        openReceipt=job.result;await writeJson(openFile,openReceipt);
      }
      await lease.update({pending:null});
    }
    if(!openReceipt)throw Object.assign(new Error('原工程重开回执未知'),{code:'ENGINE_SUBMISSION_UNKNOWN'});
  } else {
    assert(!lease.record.pending&&current.loaded===false&&current.project_id===null);
    for(let offset=0;;) {
      const jobs=(await client.call('job_list',{offset,limit:64})).data;
      assert(!(jobs.items??jobs.jobs??[]).some(job=>!job.terminal),'Engine still has work');
      if(jobs.next===undefined)break;
      assert(Number.isInteger(jobs.next)&&jobs.next>offset);
      offset=jobs.next;
    }
    const original=path.join(engineDir,'psd2live-workspace',journal.projectId);
    assert.equal(await fs.realpath(original),original);
    const checkpointFile=path.join(original,'recovery.json'),checkpointBytes=await fs.readFile(checkpointFile);
    checkpoint=JSON.parse(checkpointBytes);
    const head=await read(path.join(original,'HEAD.json'));
    assert.equal(checkpoint.state,journal.state);assert.equal(checkpoint.historyHead,last.history_node_id);
    assert.equal(head.headNodeId,last.history_node_id);
    if(!last.revision) {
      const nodes=path.join(original,'history','nodes');
      for(const name of await fs.readdir(nodes)) {
        const node=await read(path.join(nodes,name));
        if(node.id===head.headNodeId){checkpoint.nativeHead={id:node.id,revisionId:node.revisionId};break;}
      }
      assert.match(checkpoint.nativeHead?.revisionId??'',/^revision-[0-9a-f]{64}$/);
    }
    const revision=last.revision??checkpoint.nativeHead.revisionId;
    await fs.mkdir(path.dirname(recoveryDir),{recursive:true});await fs.mkdir(recoveryDir);
    await fs.writeFile(path.join(recoveryDir,'state-before.json'),stateBytes,{flag:'wx'});
    await fs.writeFile(path.join(recoveryDir,'checkpoint-before.json'),checkpointBytes,{flag:'wx'});
    const copy=path.join(recoveryDir,'workspace-copy');
    const helper=path.join(root,'scripts/recover-workspace/RecoverWorkspace.kt'),jar=path.join(recoveryDir,'recovery-tool.jar');
    const java=(await fs.readFile(path.join(root,'.local/tools/psd2live/build/run/java'),'utf8')).trim();
    const classpath=runtime.runtimeComponents.map(component=>component.path).join(path.delimiter);
    assert.equal(sha(await fs.readFile(runtime.compiler.path)),runtime.compiler.sha256);
    const reportPath=path.join(recoveryDir,'native-report.json');
    try {
      await fs.cp(original,path.join(copy,journal.projectId),{recursive:true,errorOnExist:true,force:false});
      const layout=path.join(taskRoot,'artwork','layout.json');
      assert.equal(await fs.realpath(layout),layout);
      assert((await fs.stat(layout)).isFile());
      await writeJson(path.join(copy,'session.json'),{projectId:journal.projectId,inputPath:layout,
        name:checkpoint.presentation?.projectSourceName??path.basename(layout),projectFile:null});
      await exec(java,['-cp',runtime.compiler.path+path.delimiter+classpath,'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler',
        '-jvm-target','21','-no-stdlib','-no-reflect','-Xfriend-paths='+runtime.runtimeJar,'-classpath',classpath,'-d',jar,helper],{timeout:120000,maxBuffer:65536});
      await exec(java,['-Djava.awt.headless=true','-Xmx2500m','-cp',jar+path.delimiter+classpath,
        'io.github.psd2live.application.RecoverWorkspaceKt',copy,journal.projectId,archivePath,reportPath],{timeout:180000,maxBuffer:65536});
    } finally {await fs.rm(copy,{recursive:true,force:true});}
    archive=await read(reportPath);archive.sha256=sha(await fs.readFile(archivePath));
    assert.equal(archive.projectId,journal.projectId);assert.equal(archive.historyNodeId,last.history_node_id);
    assert.equal(archive.revision,revision);assert.equal(archive.createdNode,false);
    assert.equal(sha(await fs.readFile(stateFile)),sha(stateBytes));
    assert.equal(sha(await fs.readFile(checkpointFile)),sha(checkpointBytes));
    assert.equal((await read(path.join(original,'HEAD.json'))).headNodeId,head.headNodeId);
    const def=(await client.call('workspace_get_operation',{id:'project_open'})).data;
    request={path:archivePath,project_id:null,state:current.state,request_id:'recover-'+sha(stateBytes).slice(0,40),discard_unsaved:false};
    validateRequest(request,def.request_schema);
    await writeJson(requestFile,{request,archive,checkpoint,stateSha256:sha(stateBytes),status:'submitting'});
    const pending={operation:'project_open',requestId:request.request_id,jobId:null,projectId:null};
    await lease.update({pending});
    const response=await client.call('project_open',request,{onJob:async job=>{
      pending.jobId=job.id;await lease.update({pending});await writeJson(path.join(recoveryDir,'job.json'),job);
    }});
    openReceipt=response.data;await writeJson(openFile,openReceipt);
    await lease.update({pending:null});
  }
  await session.recoverCommitted({checkpoint,lastStepKey,archive,openReceipt,evidence,storageRepairId:repairId});
  const result={status:'recovered',mode:'reopened',projectId:journal.projectId,state:journal.state,lastStepKey,
    completedSteps:Object.keys(journal.done).length,archiveSha256:archive.sha256};
  await writeJson(path.join(recoveryDir,'result.json'),result);return result;
}

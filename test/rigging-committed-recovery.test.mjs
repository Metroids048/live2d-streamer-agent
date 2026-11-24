import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RigSession} from '../src/rigging/engine.mjs';

async function fixture(t) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rig-recovery-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const original={operation:'author_axis',data:{project_id:'owned',state:'old:1:5',history_node_id:'head',revision:'revision-hash'},bodyHash:'unchanged'};
 const journal={projectId:'owned',state:'old:1:5',pending:null,done:{axis:original}};
 const current={loaded:true,busy:false,project_id:'owned',state:'new:1:0',history_node_id:'head',revision:'revision-hash'};
 const reads=[];const session=new RigSession({engine:{async call(op){reads.push(op);return {data:op==='history_list'?{headNodeId:current.history_node_id,nodes:[{id:current.history_node_id,revisionId:current.revision,isHead:true}]}:structuredClone(current)};}}},dir,journal);
 const proof={checkpoint:{state:'old:1:5',historyHead:'head'},lastStepKey:'axis',archive:{projectId:'owned',historyNodeId:'head',revision:'revision-hash',sha256:'a'.repeat(64)},openReceipt:{...current},evidence:'recovery.json'};
 return {dir,journal,current,original,session,proof,reads};
}
test('confirmed crash recovery rebinds only process state and preserves every completed step',async t=>{
 const f=await fixture(t),before=structuredClone(f.journal.done);await f.session.recoverCommitted(f.proof);
 assert.equal(f.journal.state,'new:1:0');assert.deepEqual(f.journal.done,before);assert.deepEqual(f.reads,['workspace_inspect','history_list']);
 assert.equal(f.journal.recoveries[0].fromState,'old:1:5');assert.equal(JSON.parse(await fs.readFile(path.join(f.dir,'state.json'))).recoveries.length,1);
});
test('pending, failed, foreign or nonidentical checkpoints cannot be rebound',async t=>{
 for(const mutate of [f=>{f.journal.pending={jobId:'unknown'};},f=>{f.journal.failed={};},f=>{f.proof.checkpoint.historyHead='other';},f=>{f.proof.archive.projectId='other';},f=>{f.proof.archive.revision='different';},f=>{f.proof.archive.sha256='bad';}]){
  const f=await fixture(t);mutate(f);await assert.rejects(f.session.recoverCommitted(f.proof),{code:'ENGINE_COMMITTED_RECOVERY_MISMATCH'});
  assert.equal(f.journal.state,'old:1:5');assert.equal(f.journal.recoveries,undefined);
 }
});
test('actual reopened history, revision and native receipt must all match the last confirmed edit',async t=>{
 for(const mutate of [f=>{f.current.project_id='foreign';},f=>{f.current.revision='different';},f=>{f.current.history_node_id='other';},f=>{f.current.busy=true;},f=>{f.proof.openReceipt.state='wrong';}]){
  const f=await fixture(t);mutate(f);await assert.rejects(f.session.recoverCommitted(f.proof),{code:'ENGINE_COMMITTED_RECOVERY_REOPEN_MISMATCH'});assert.equal(f.journal.state,'old:1:5');
 }
});

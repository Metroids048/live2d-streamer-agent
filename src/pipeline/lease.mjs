import * as fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {Fault} from '../rpc.mjs';
import {Store} from '../store.mjs';

export const identityKeys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
const live=pid=>{if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};

// Even a dead worker cannot surrender an unresolved external edit to a different candidate.
export async function acquireEngineLease(root,owner) {
  const store=new Store(root),file=path.join(store.dir,'engine-lease.json');
  if(identityKeys.some(k=>!Object.hasOwn(owner,k))||!owner.taskId||!owner.candidateId||!owner.stage)
    throw new Fault('ENGINE_LEASE_IDENTITY','缺少完整引擎租约身份');
  const identity=Object.fromEntries(identityKeys.map(k=>[k,owner[k]]));
  const record=await store.lock(async()=>{
    const previous=await store.read('engine-lease');
    if(previous&&(previous.version!==2||live(previous.pid)||previous.stage!==owner.stage||
      identityKeys.some(k=>previous[k]!==identity[k])))throw new Fault('ENGINE_BUSY','原任务持有专用编辑器；没有接管其他工程',{
        taskId:previous.taskId,stage:previous.stage,pending:previous.pending??null});
    const current={...identity,version:2,stage:owner.stage,leaseId:randomUUID(),pid:process.pid,
      acquiredAt:new Date().toISOString(),pending:previous?.pending??null};
    await store.write('engine-lease',current);return current;
  });
  const assertHeld=async()=>{
    const current=await store.read('engine-lease');
    if(current?.leaseId!==record.leaseId||current.pid!==process.pid)throw new Fault('ENGINE_LEASE_LOST','独占租约已改变，停止编辑');
  };
  async function update(patch) {
    await assertHeld();const next={...record,...patch};await store.write('engine-lease',next);Object.assign(record,next);
  }
  return {record,update,assertHeld,async release({outcomeUnknown=false}={}) {
    await assertHeld();
    if(outcomeUnknown||record.pending)await update({pid:null});
    else await fs.unlink(file);
  }};
}

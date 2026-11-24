// Explicit recovery of a confirmed, committed Rig checkpoint after process loss.
// No Artwork generation and no replay of an editing request.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from '../src/store.mjs';
import {PinnedPsd2Live} from '../src/pipeline/production-engine.mjs';
import {acquireEngineLease,identityKeys} from '../src/pipeline/lease.mjs';
import {imageEngineDirectory} from '../src/pipeline/engine-location.mjs';
import {recoverCommittedRig} from '../src/rigging/storage-recovery.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
const root=fileURLToPath(new URL('../',import.meta.url));
const [candidateArg,descriptorArg]=process.argv.slice(2);assert(candidateArg&&descriptorArg);
const taskRoot=await fs.realpath(candidateArg);assert(taskRoot.startsWith(path.join(root,'openclaw-workspace/outputs/')));
const dir=path.join(taskRoot,'rigging'),stateFile=path.join(dir,'state.json'),stateBytes=await fs.readFile(stateFile),journal=JSON.parse(stateBytes);
assert(!journal.pending&&!journal.failed,'Only an entirely confirmed checkpoint may recover this way');
const source=JSON.parse(await fs.readFile(path.join(taskRoot,'artwork/stage.json')));
for(const k of identityKeys)assert.equal(journal.identity[k],source[k]);
const descriptor=JSON.parse(await fs.readFile(descriptorArg));for(const k of identityKeys)assert.equal(descriptor[k],source[k]);
const engineDir=imageEngineDirectory(root,source.taskId,source.candidateId,source.revision);assert.equal(descriptor.engineDirectory,engineDir);
assert.equal(path.dirname(descriptor.argsFile),engineDir);assert.equal(sha(await fs.readFile(descriptor.argsFile)),descriptor.argsSha256);
const runtimeBytes=await fs.readFile(descriptor.runtimeManifest);assert.equal(sha(runtimeBytes),descriptor.runtimeManifestSha256);
const runtime=JSON.parse(runtimeBytes);
for(const c of [...runtime.runtimeComponents,runtime.compiler])assert.equal(sha(await fs.readFile(c.path)),c.sha256);
const store=new Store(root,engineDir),jobs=new Store(root);
const live=record=>{try{process.kill(record.pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw e;}};
const lease=await acquireEngineLease(root,{...journal.identity,stage:'rigging'});
try {
 assert(!lease.record.pending,'Unresolved engine edit requires original job recovery');
 let service=await store.read('psd2live-service');
 for(const k of ['taskId','candidateId','revision'])assert.equal(service[k],source[k]);
 assert.equal(service.argsSha256,descriptor.argsSha256);
 if(!live(service)) {
  const active=await jobs.read('maker-active'),job=await jobs.read('make-'+source.taskId);
  assert(active?.id===source.taskId&&job?.candidateId===source.candidateId&&job.revision===source.revision&&
    job.status==='failed'&&job.stage==='rigging'&&job.error?.code==='ENOSPC'&&!job.pending);
  const child=spawn(process.execPath,[path.join(root,'scripts/psd2live-service.mjs'),source.taskId,source.candidateId,
    String(source.revision),'',descriptor.argsFile],{cwd:root,detached:true,stdio:'ignore'});
  child.unref();
  for(let i=0;i<40;i++) {
   await delay(500);service=await store.read('psd2live-service');
   if(service?.supervisorPid===child.pid&&service.port>0&&live(service))break;
  }
  assert(service?.supervisorPid===child.pid&&service.port>0&&live(service),'Pinned editor did not start');
 }
 const client=new PinnedPsd2Live(root,{connectionDir:engineDir});client.endpoint=`http://127.0.0.1:${service.port}/mcp`;
 const result=await recoverCommittedRig({root,taskRoot,engineDir,runtime,client,lease,journal});
 console.log(JSON.stringify(result));
} finally {await lease.release();}

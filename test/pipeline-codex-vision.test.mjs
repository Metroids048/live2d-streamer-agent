import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createCodexVision} from '../src/pipeline/codex-vision.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
async function setup(t) {
  const taskRoot=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'vision-transport-')));t.after(()=>fs.rm(taskRoot,{recursive:true,force:true}));
  const image=path.join(taskRoot,'source.png');await fs.writeFile(image,'transport-test-not-image');
  return {taskRoot,request:{operationKey:'intake-vision-'+sha(taskRoot),image:{path:image,sha256:sha(await fs.readFile(image)),mimeType:'image/png',width:1,height:1},inputSha256:sha('original'),descriptionSha256:sha('description'),description:'description',taskId:'task',candidateId:'candidate',revision:1,instructions:'transport fixture only',outputSchema:{type:'object',properties:{test:{type:'boolean'}},required:['test'],additionalProperties:false}}};
}
function fakeSpawn(delay,onCall) {
  return (binary,args,options)=>{
    onCall(args);
    const output=args[args.indexOf('--output-last-message')+1];
    return spawn(process.execPath,['-e',`process.stdin.resume();setTimeout(()=>{require('fs').writeFileSync(process.argv[1],JSON.stringify({test:true}));process.exit(0)},${delay})`,output],options);
  };
}
test('durable vision transport reuses one response and rejects identity/cache changes',async t=>{
  const {taskRoot,request}=await setup(t);let calls=0;
  const backend=createCodexVision({taskRoot,binary:process.execPath,spawnProcess:fakeSpawn(0,args=>{calls++;assert(args.includes('--sandbox'));assert(!args.includes('--model'));}),waitMs:5000});
  assert.deepEqual(await backend.describeImage(request),{test:true});
  assert.deepEqual(await backend.describeImage(request),{test:true});assert.equal(calls,1);
  await assert.rejects(backend.recoverDescription({...request,candidateId:'wrong'}),{code:'INPUT_CONFLICT'});
  const response=path.join(taskRoot,'intake/codex-vision',request.operationKey,'response.json');await fs.writeFile(response,'{"test":false}');
  await assert.rejects(backend.recoverDescription(request),{code:'INPUT_CONFLICT'});
});
test('yielded inference is recovered after restart without another submission',async t=>{
  const {taskRoot,request}=await setup(t);let calls=0;
  const backend=createCodexVision({taskRoot,binary:process.execPath,spawnProcess:fakeSpawn(150,()=>calls++),waitMs:1});
  await assert.rejects(backend.describeImage(request),{code:'EXTERNAL_RESULT_UNKNOWN'});
  await assert.rejects(backend.describeImage(request),{code:'EXTERNAL_RESULT_UNKNOWN'});
  await new Promise(r=>setTimeout(r,250));
  const recovered=await createCodexVision({taskRoot}).recoverDescription(request);
  assert.equal(recovered.status,'completed');assert.deepEqual(recovered.response,{test:true});assert.equal(calls,1);
});
test('completed original event stream is recovered before final-message file arrives',async t=>{
  const {taskRoot,request}=await setup(t),dir=path.join(taskRoot,'intake/codex-vision',request.operationKey);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'receipt.json'),JSON.stringify({...request,image:undefined,imageSha256:request.image.sha256,status:'running',pid:process.pid}));
  const events=[{type:'thread.started',thread_id:'original'},{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'{"test":true}'}},{type:'turn.completed',usage:{}}];
  await fs.writeFile(path.join(dir,'events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');
  const result=await createCodexVision({taskRoot}).recoverDescription(request);
  assert.equal(result.status,'completed');assert.deepEqual(result.response,{test:true});
  const receipt=JSON.parse(await fs.readFile(path.join(dir,'receipt.json')));assert.equal(receipt.responseFile,'event-response.json');assert.equal(receipt.responseProvenance.kind,'codex_completed_event');
  await fs.writeFile(path.join(dir,'event-response.json'),'{}');await assert.rejects(createCodexVision({taskRoot}).recoverDescription(request),{code:'INPUT_CONFLICT'});
});
test('unfinished or ambiguous streams remain unknown and never resubmit',async t=>{
  const {taskRoot,request}=await setup(t),dir=path.join(taskRoot,'intake/codex-vision',request.operationKey);await fs.mkdir(dir,{recursive:true});
  await fs.writeFile(path.join(dir,'receipt.json'),JSON.stringify({...request,image:undefined,imageSha256:request.image.sha256,status:'unknown'}));
  const events=[{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'{"test":true}'}}];
  const save=()=>fs.writeFile(path.join(dir,'events.jsonl'),events.map(JSON.stringify).join('\n')+'\n');await save();
  const backend=createCodexVision({taskRoot,spawnProcess:()=>assert.fail('must not spawn')});
  assert.equal((await backend.recoverDescription(request)).status,'unknown');
  events.push(events[1],{type:'turn.completed'});await save();assert.equal((await backend.recoverDescription(request)).status,'unknown');
});

test('recovery recognizes a fresh launch intent before its child PID is written, and stops on a stale intent',async t=>{
  const {taskRoot,request}=await setup(t),dir=path.join(taskRoot,'intake/codex-vision',request.operationKey);
  await fs.mkdir(dir,{recursive:true});const file=path.join(dir,'receipt.json');
  const receipt={...request,image:undefined,imageSha256:request.image.sha256,status:'submitted',launcherPid:process.pid,createdAt:new Date().toISOString()};
  await fs.writeFile(file,JSON.stringify(receipt));
  const backend=createCodexVision({taskRoot,waitMs:0,spawnProcess:()=>assert.fail('must not resubmit')});
  assert.equal((await backend.recoverDescription(request)).status,'submitted');
  await fs.writeFile(file,JSON.stringify({...receipt,createdAt:new Date(Date.now()-60_000).toISOString()}));
  assert.equal((await backend.recoverDescription(request)).status,'unknown');
  await fs.writeFile(file,JSON.stringify({...receipt,launcherPid:undefined}));
  assert.equal((await backend.recoverDescription(request)).status,'unknown');
});

test('active worker and recovering worker both consume the original completed event while the CLI is still alive',async t=>{
  const {taskRoot,request}=await setup(t);
  let child,calls=0;
  const spawnProcess=(binary,args,options)=>{
    calls++;
    const events=[{type:'turn.started'},{type:'item.completed',item:{type:'agent_message',text:'{"test":true}'}},{type:'turn.completed'}];
    child=spawn(process.execPath,['-e',"process.stdin.resume();setTimeout(()=>console.log(process.argv[1]),100);setInterval(()=>{},10000)",events.map(JSON.stringify).join('\n')],options);
    return child;
  };
  const backend=createCodexVision({taskRoot,binary:process.execPath,spawnProcess,waitMs:10_000,pollMs:15});
  const production=backend.describeImage(request);
  while(!child)await new Promise(r=>setTimeout(r,5));
  t.after(()=>child.kill());
  const resumed=createCodexVision({taskRoot,waitMs:10_000,pollMs:23,spawnProcess:()=>assert.fail('resubmitted')}).recoverDescription(request);
  assert.deepEqual(await production,{test:true});
  assert.deepEqual((await resumed).response,{test:true});
  assert.equal(child.exitCode,null);
  assert.equal(calls,1);
});

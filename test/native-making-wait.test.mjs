import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {Maker} from '../src/maker.mjs';

// Exercise actual plugin registration/execute shape without a live OpenClaw gateway.
const sdk='data:text/javascript,'+encodeURIComponent('export const definePluginEntry=v=>v,saveMediaBuffer=()=>{},readMediaBuffer=()=>{},resolveMediaBufferPath=()=>{},readSessionTranscriptEvents=()=>{},appendAssistantMirrorMessageByIdentity=()=>{};');
const hooks=registerHooks({resolve(id,ctx,next){return id.startsWith('openclaw/plugin-sdk/')?{url:sdk,shortCircuit:true}:next(id,ctx);}});
const {default:plugin}=await import('../openclaw-plugin/index.mjs');hooks.deregister();
const ctx={agentId:'live2d-streamer',sessionId:'session',sessionKey:'key'};
let making;
plugin.register({on(){},registerService(){},registerCommand(){},registerTool(factory){making=factory(ctx).find(t=>t.name==='avatar_making');}});
const job_id='00000000-0000-4000-8000-000000000000';
const active={ok:true,id:job_id,status:'running',stage:'intake',workerAlive:true};
const payload=async(params,signal)=>JSON.parse((await making.execute('call',{job_id,...params},signal)).content[0].text);

test('native wait reads only the same session/job and returns when visual review becomes available',async t=>{
  let reads=0;
  t.mock.method(Maker.prototype,'run',(action,params,context)=>{
    assert.equal(action,'making');assert.deepEqual(params,{job_id});assert.equal(context.sessionId,ctx.sessionId);
    return ++reads===1?active:{...active,status:'blocked',stage:'rigging',visualReview:{startPage:0}};
  });
  assert.deepEqual(making.parameters.properties.wait_seconds.anyOf,[{type:'integer',minimum:0,maximum:45},{type:'null'}]);
  const result=await payload({wait_seconds:2});assert.deepEqual(result.visualReview,{startPage:0});assert.equal(reads,2);
});

test('settled, unknown/failed, stopped worker and session mismatch return immediately without scheduling',async t=>{
  let snapshot;
  const reads=t.mock.method(Maker.prototype,'run',()=>snapshot);
  for(snapshot of [{...active,status:'completed'},{...active,status:'awaiting_external_result'},{...active,status:'needs_input'},
    {...active,status:'blocked'},{...active,status:'failed'},{...active,workerAlive:false},{ok:false,code:'SESSION_MISMATCH'}]) {
    const result=await payload({wait_seconds:45});
    assert.equal(result.status,snapshot.status);assert.equal(result.code,snapshot.code);
    if(snapshot.workerAlive===false)assert.equal(result.waitState,'worker_stopped');
  }
  assert.equal(reads.mock.callCount(),7);
  assert.equal((await payload({wait_seconds:1000})).code,'INPUT_INVALID');assert.equal(reads.mock.callCount(),7);
});

test('status remains a single read by default; aborting the wait leaves production alone',async t=>{
  const reads=t.mock.method(Maker.prototype,'run',()=>active);
  const snapshot=await payload({});assert.equal(snapshot.waitState,undefined);assert.equal(reads.mock.callCount(),1);
  const controller=new AbortController(),wait=payload({wait_seconds:45},controller.signal);
  setTimeout(()=>controller.abort(),5);
  await assert.rejects(wait,{name:'AbortError'});assert.equal(reads.mock.callCount(),2);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {Maker} from '../src/maker.mjs';

// Plugin wiring only: SDK/publication seams are doubles. No gateway, media write or editor.
const sdk='data:text/javascript,'+encodeURIComponent('export const definePluginEntry=v=>v,saveMediaBuffer=()=>{},readMediaBuffer=()=>{},resolveMediaBufferPath=()=>{},readSessionTranscriptEvents=()=>{},appendAssistantMirrorMessageByIdentity=()=>{};');
const delivery='data:text/javascript,'+encodeURIComponent('export const deliver=async()=>({ok:true,branch:"complete"}),deliverStagePreview=async()=>({ok:true,branch:"g1-preview"});');
const hooks=registerHooks({resolve(id,ctx,next){
  if(id.startsWith('openclaw/plugin-sdk/'))return {url:sdk,shortCircuit:true};
  if(id==='../src/delivery.mjs')return {url:delivery,shortCircuit:true};
  return next(id,ctx);
}});
const {default:plugin}=await import('../openclaw-plugin/index.mjs');hooks.deregister();
const ctx={agentId:'live2d-streamer',sessionId:'synthetic-session',sessionKey:'synthetic-key'};
let tools;
plugin.register({on(){},registerService(){},registerCommand(){},registerTool(factory){tools=factory(ctx);}});
const invoke=async(name,params)=>JSON.parse((await tools.find(t=>t.name===name).execute('synthetic-call',params)).content[0].text);

test('native make exposes review_only and passes it only alongside same-task visual input',async t=>{
  const calls=t.mock.method(Maker.prototype,'resume',async(...args)=>({ok:true,reviewOnly:args[3]}));
  const make=tools.find(t=>t.name==='avatar_make');
  assert.deepEqual(make.parameters.properties.review_only.anyOf,[{type:'boolean'},{type:'null'}]);
  const good=await invoke('avatar_make',{resume_job_id:'same-task',visual_review:{},review_only:true});
  assert.equal(good.reviewOnly,true);assert.equal(calls.mock.callCount(),1);
  for(const params of [{resume_job_id:'same-task',review_only:true},{material_id:'material',review_only:true},
    {resume_job_id:'same-task',visual_review:{},review_only:'true'}]) {
    const result=await invoke('avatar_make',params);assert.equal(result.code,'INPUT_INVALID');assert.equal(result.isError,true);
  }
  assert.equal(calls.mock.callCount(),1);
});

test('native delivery requires explicit G1 selection and retains the completed-package route by default',async()=>{
  const deliver=tools.find(t=>t.name==='avatar_deliver');
  assert.deepEqual(deliver.parameters.properties.stage_preview.anyOf,[{type:'string',enum:['g1']},{type:'null'}]);
  assert.equal((await invoke('avatar_deliver',{job_id:'synthetic'})).branch,'complete');
  assert.equal((await invoke('avatar_deliver',{job_id:'synthetic',stage_preview:null})).branch,'complete');
  assert.equal((await invoke('avatar_deliver',{job_id:'synthetic',stage_preview:'g1'})).branch,'g1-preview');
});

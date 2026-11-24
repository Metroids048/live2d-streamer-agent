import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createQwenLayeredBackend } from '../src/artwork/qwen-layered.mjs';
import { encodePng } from '../src/artwork/png.mjs';
import { sha256 } from '../src/artwork/files.mjs';

const image=color=>encodePng({width:1,height:1,data:Buffer.from([color,20,30,128])});
const response=(status,body)=>({status,ok:status>=200&&status<300,body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body))])});
const req=()=>({operationKey:'fixture-qwen',cacheKey:'fixture-cache',source:{bytes:image(50),sha256:sha256(image(50)),width:1,height:1,mimeType:'image/png'},rights:{allowDerivatives:true}});
async function setup(t){const stateDir=await mkdtemp(path.join(tmpdir(),'artwork-qwen-'));t.after(()=>rm(stateDir,{force:true,recursive:true}));return stateDir;}

test('Qwen official wire order, raw receipt and real RGBA decoding preserve unknown semantics',async t=>{
  const stateDir=await setup(t),job='a'.repeat(32);let uploads=0,calls=0,events=0,downloads=0;
  const wire='event: heartbeat\r\ndata: null\r\n\r\nevent: complete\r\ndata: [[{"image":{"path":"/tmp/one.png"}},{"image":{"path":"/tmp/two.png"}}],null,null]\r\n\r\n';
  const request=async(url,options={})=>{
    url=String(url);
    if(url.endsWith('/upload')){uploads++;return response(200,['/tmp/source.png']);}
    if(url.endsWith('/call/infer_1')){calls++;assert.deepEqual(JSON.parse(options.body).data,[{path:'/tmp/source.png',meta:{_type:'gradio.FileData'}},0,false,'',' ',4,50,2,true,true]);return response(200,{event_id:job});}
    if(url.endsWith(job)){events++;return response(200,wire);}
    downloads++;return response(200,image(downloads));
  };
  const backend=createQwenLayeredBackend({stateDir,layers:2,request});
  assert.equal((await backend.submit(req())).status,'running');const result=await backend.query(job);
  assert.equal(result.status,'completed');assert.equal(result.result.parts.length,2);assert.ok(result.result.parts.every(p=>p.tags.length===0));assert.ok(result.result.quality.checks.every(c=>c.status==='not_run'));
  const saved=JSON.parse(await readFile(path.join(stateDir,`${sha256(req().operationKey)}.json`)));
  assert.equal(saved.uploadPosts,1);assert.equal(saved.inferencePosts,1);assert.equal(saved.sseReceipt.httpStatus,200);
  assert.equal((await readFile(path.join(stateDir,saved.sseReceipt.path))).toString(),wire);
  assert.equal((await backend.recover({operationKey:req().operationKey})).status,'completed');assert.deepEqual([uploads,calls,events,downloads],[1,1,1,2]);
});

test('Qwen lost POST is unknown and cannot trigger any second submission',async t=>{
  const stateDir=await setup(t);let uploads=0,calls=0;
  const request=async url=>{if(String(url).endsWith('/upload')){uploads++;return response(200,['/tmp/source.png']);}calls++;throw new Error('unknown fixture connection');};
  const make=()=>createQwenLayeredBackend({stateDir,request});
  assert.equal((await make().submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
  assert.equal((await make().submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');assert.deepEqual([uploads,calls],[1,1]);
});

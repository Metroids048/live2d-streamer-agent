import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createFalLayeredBackend, buildArtwork } from '../src/artwork/index.mjs';
import { encodePng, decodePng, crc32 } from '../src/artwork/png.mjs';
import { deflateSync } from 'node:zlib';
import { sha256 } from '../src/artwork/files.mjs';

// All transport responses and credentials here are offline fixtures.
const KEY='offline-fake-fal-key';
const JOB='019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6a7b';
const BASE='https://queue.fal.run/fal-ai/qwen-image-layered';
const resultUrl=`${BASE}/requests/${JOB}`;
const receipt={status:'IN_QUEUE',request_id:JOB,response_url:resultUrl,status_url:`${resultUrl}/status`,cancel_url:`${resultUrl}/cancel`};
const image=n=>encodePng({width:2,height:1,data:Buffer.from([n,20,30,128,0,0,0,0])});
function rgbPng(){
  const chunk=(type,data)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);out.writeUInt32BE(crc32(out.subarray(4,-4)),out.length-4);return out;};
  const header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,1,2,3,4,5,6]))),chunk('IEND',Buffer.alloc(0))]);
}
const response=(status,body)=>({status,ok:status>=200&&status<300,body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body))])});
const req=()=>({operationKey:'offline-fal-operation',cacheKey:'offline-fal-cache',source:{bytes:image(50),sha256:sha256(image(50)),width:2,height:1,mimeType:'image/png'},rights:{allowDerivatives:true}});
const output=(count=2)=>({images:Array.from({length:count},(_,i)=>({url:`https://v3b.fal.media/files/fixture/layer-${i+1}.png`,content_type:'image/png',width:2,height:1})),seed:0,has_nsfw_concepts:Array(count).fill(false)});
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'artwork-fal-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const statePath=(root,key=req().operationKey)=>path.join(root,`${sha256(key)}.json`);
const state=async root=>JSON.parse(await readFile(statePath(root),'utf8'));
const make=(stateDir,request,extra={})=>createFalLayeredBackend({stateDir,apiKey:KEY,allowUnpinnedModel:true,layers:2,request,...extra});
async function diskText(root){return (await Promise.all((await readdir(root)).filter(f=>f.endsWith('.json')).map(f=>readFile(path.join(root,f),'utf8')))).join('\n');}

test('fal queue acceptance, completion and exact RGBA outputs remain separate; cached recovery makes no calls',async t=>{
  const root=await setup(t);let posts=0,queries=0,results=0,downloads=0,clock=1000;
  const request=async(url,options={})=>{
    url=String(url);
    if(options.method==='POST'){
      posts++;const saved=await state(root);assert.equal(saved.status,'submitting');assert.equal(saved.inferencePosts,1);
      assert.equal(options.headers.Authorization,`Key ${KEY}`);assert.equal(options.headers['X-Fal-No-Retry'],'1');
      assert.equal(options.headers['x-app-fal-disable-fallback'],'true');assert.equal(options.headers['X-Fal-Store-IO'],'1');
      assert.deepEqual(JSON.parse(options.headers['X-Fal-Object-Lifecycle-Preference']),{expiration_duration_seconds:86400});
      assert.deepEqual(JSON.parse(options.body),{image_url:`data:image/png;base64,${req().source.bytes.toString('base64')}`,prompt:'',negative_prompt:'',num_layers:2,seed:0,num_inference_steps:28,guidance_scale:5,sync_mode:false,enable_safety_checker:true,output_format:'png',acceleration:'regular'});
      assert.ok(!(await diskText(root)).includes(KEY));assert.ok(!(await diskText(root)).includes('data:image/'));
      return response(200,receipt);
    }
    if(url===`${resultUrl}/status`){queries++;return response(200,{status:queries===1?'IN_PROGRESS':'COMPLETED',request_id:JOB});}
    if(url===resultUrl){results++;return response(200,output());}
    downloads++;assert.equal(options.headers?.Authorization,undefined);return response(200,image(downloads));
  };
  const backend=make(root,request,{now:()=>clock});
  assert.match(backend.modelVersion,/unpinned/);assert.equal((await backend.submit(req())).status,'running');
  assert.equal((await backend.query(JOB)).status,'running');assert.deepEqual([posts,queries,results,downloads],[1,1,0,0]);
  assert.equal((await backend.query(JOB)).status,'running');assert.equal(queries,1);clock+=1001;
  const done=await backend.query(JOB);assert.equal(done.status,'completed');
  assert.deepEqual(done.result.parts.map(p=>p.png),[image(1),image(2)]);
  assert.ok(done.result.parts.every(p=>p.tags.length===0&&!p.landmarks&&p.rect.left===0&&decodePng(p.png).data[3]===128));
  assert.ok(done.result.quality.checks.every(c=>c.status==='not_run'));assert.equal(done.result.quality.sourceCanvasMapping.verified,false);
  assert.equal((await make(root,request).recover({operationKey:req().operationKey})).status,'completed');
  assert.deepEqual([posts,queries,results,downloads],[1,2,1,2]);
  const saved=await state(root);assert.equal(saved.jobId,JOB);assert.equal(saved.resultReceipt.httpStatus,200);
  await writeFile(path.join(root,saved.downloads[0].path),image(9));
  assert.equal((await backend.recover({operationKey:req().operationKey})).code,'BACKEND_CACHE_CHANGED');
  assert.deepEqual([posts,queries,results,downloads],[1,2,1,2]);
});

test('fal disconnected or 5xx POST with no ID stays unknown across restarts, never resubmitted',async t=>{
  for(const mode of ['disconnect','500']){
    const root=await setup(t);let posts=0;
    const request=async()=>{posts++;if(mode==='disconnect')throw new Error(`echo Key ${KEY} data:image/png;base64,AAAA`);return response(500,{error:'upstream unavailable',error_type:'server_error'});};
    assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
    assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
    assert.equal((await make(root,request).recover({operationKey:req().operationKey})).code,'EXTERNAL_RESULT_UNKNOWN');
    assert.equal(posts,1);assert.ok(!(await diskText(root)).includes(KEY));assert.ok(!(await diskText(root)).includes('data:image/'));
  }
});

test('fal submit is exclusive even across two backend instances',async t=>{
  const root=await setup(t);let posts=0,release;
  const wait=new Promise(resolve=>{release=resolve;});
  const request=async()=>{posts++;await wait;return response(200,receipt);};
  const first=make(root,request).submit(req());
  while(posts===0)await new Promise(resolve=>setTimeout(resolve,1));
  const second=await make(root,request).submit(req());assert.equal(second.code,'EXTERNAL_RESULT_UNKNOWN');
  release();assert.equal((await first).jobId,JOB);assert.equal(posts,1);
});

test('fal missing credentials and unaccepted unpinned model block before POST; changed source cannot reuse operation',async t=>{
  const root=await setup(t);let calls=0;
  const request=async()=>{calls++;return response(200,receipt);};
  assert.equal((await make(root,request,{apiKey:undefined}).submit(req())).code,'BACKEND_AUTH_REQUIRED');
  assert.equal((await make(root,request,{allowUnpinnedModel:false}).submit(req())).code,'BACKEND_MODEL_UNPINNED');assert.equal(calls,0);
  await make(root,request).submit(req());
  const changed=req();changed.source={...changed.source,bytes:image(8),sha256:sha256(image(8))};
  await assert.rejects(()=>make(root,request).submit(changed),/BACKEND_CACHE_IDENTITY_MISMATCH/);assert.equal(calls,1);
});

test('fal recovery queries only known request ID after network interruption or 404, never POST',async t=>{
  const root=await setup(t);let posts=0,gets=0,clock=1000;
  const request=async(url,options={})=>{
    if(options.method==='POST'){posts++;return response(200,receipt);}
    assert.equal(String(url),`${resultUrl}/status`);gets++;if(gets===1)throw new Error('offline interruption');
    return response(404,{status:'NOT_FOUND'});
  };
  await make(root,request).submit(req());
  assert.equal((await make(root,request,{now:()=>clock}).recover({operationKey:req().operationKey})).code,'BACKEND_QUERY_INTERRUPTED');clock+=1001;
  assert.equal((await make(root,request,{now:()=>clock}).recover({operationKey:req().operationKey})).code,'EXTERNAL_RESULT_UNKNOWN');clock+=1001;
  assert.equal((await make(root,request,{now:()=>clock}).query(JOB)).code,'EXTERNAL_RESULT_UNKNOWN');
  assert.deepEqual([posts,gets],[1,3]);assert.equal((await state(root)).jobId,JOB);
});

test('fal COMPLETED failure retains HTTP/error_type and redacts echoed input; does not fetch pixels',async t=>{
  const root=await setup(t);let calls=0;
  const request=async(url,options={})=>{calls++;if(options.method==='POST')return response(200,receipt);return response(200,{status:'COMPLETED',request_id:JOB,error:`denied ${KEY} data:image/png;base64,AAAA`,error_type:'content_policy_violation'});};
  const backend=make(root,request);await backend.submit(req());const failed=await backend.query(JOB);
  assert.equal(failed.status,'failed');assert.equal(failed.errorType,'content_policy_violation');assert.equal(failed.httpStatus,200);
  assert.match(failed.note,/denied/);assert.ok(!(await diskText(root)).includes(KEY));assert.ok(!(await diskText(root)).includes('data:image/'));
  assert.equal((await backend.recover({operationKey:req().operationKey})).status,'failed');assert.equal(calls,2);
});

test('fal terminal status alone cannot hide error payloads or model HTTP failures',async t=>{
  for(const [httpStatus,payload]of [[200,{error:'real model failure',error_type:'runner_error'}],[200,{errors:[{message:'real errors list'}],error_type:'runner_error'}],[422,{detail:[{msg:'invalid input',input:`data:image/png;base64,AAAA ${KEY}`}],error_type:'validation_error'}]]){
    const root=await setup(t);
    const request=async(url,options={})=>options.method==='POST'?response(200,receipt):String(url).endsWith('/status')?response(200,{status:'COMPLETED',request_id:JOB}):response(httpStatus,payload);
    const backend=make(root,request);await backend.submit(req());const failed=await backend.query(JOB);
    assert.equal(failed.status,'failed');assert.equal(failed.httpStatus,httpStatus);assert.equal(failed.errorType,payload.error_type);
    assert.ok(!(await diskText(root)).includes(KEY));assert.ok(!(await diskText(root)).includes('data:image/'));
  }
});

test('fal rejects foreign receipt URLs while preserving original ID without following the URL',async t=>{
  const root=await setup(t);let calls=0;
  const backend=make(root,async()=>{calls++;return response(200,{...receipt,status_url:'https://127.0.0.1/private'});});
  assert.equal((await backend.submit(req())).code,'BACKEND_RECEIPT_URL_INVALID');
  assert.equal((await state(root)).jobId,JOB);await backend.recover({operationKey:req().operationKey});assert.equal(calls,1);
});

test('fal output URL/count/safety violations block downloads and cannot produce accepted artwork',async t=>{
  for(const change of [o=>o.images[0].url='https://fal.media.evil.invalid/layer.png',o=>o.images[0].url='http://v3b.fal.media/layer.png',o=>o.images[0].url='https://v3b.fal.media/files/%2e%2e/private.png',o=>o.images[0].url='https://v3b.fal.media/files/x.png?token=secret',o=>o.images.push(o.images[0]),o=>o.has_nsfw_concepts[0]=true]){
    const root=await setup(t);let downloads=0;const data=output();change(data);
    const request=async(url,options={})=>{if(options.method==='POST')return response(200,receipt);if(String(url).endsWith('/status'))return response(200,{status:'COMPLETED',request_id:JOB});if(String(url)===resultUrl)return response(200,data);downloads++;throw new Error('must not download');};
    const backend=make(root,request);await backend.submit(req());assert.equal((await backend.query(JOB)).status,'blocked');assert.equal(downloads,0);
  }
});

test('fal bounded downloads reject HTTP redirects, excess bytes, missing alpha and unequal layer canvases',async t=>{
  for(const mode of ['redirect','bytes','alpha','canvas']){
    const root=await setup(t);let downloads=0;
    const request=async(url,options={})=>{
      if(options.method==='POST')return response(200,receipt);
      if(String(url).endsWith('/status'))return response(200,{status:'COMPLETED',request_id:JOB});
      if(String(url)===resultUrl)return response(200,output());downloads++;
      if(mode==='redirect')return response(302,{location:'https://elsewhere.invalid/'});
      if(mode==='alpha')return response(200,rgbPng());
      if(mode==='canvas'&&downloads===2)return response(200,encodePng({width:1,height:1,data:Buffer.from([4,5,6,128])}));
      return response(200,image(downloads));
    };
    const backend=make(root,request,mode==='bytes'?{maxFileBytes:16}:{});await backend.submit(req());
    const result=await backend.query(JOB);assert.equal(result.status,'blocked');if(mode==='alpha')assert.equal(result.code,'BACKEND_ALPHA_REQUIRED');
    assert.equal((await backend.recover({operationKey:req().operationKey})).status,'blocked');
  }
});

test('fal recovery rejects recipe drift and temporary result access failure keeps the original request recoverable',async t=>{
  const root=await setup(t);let calls=0,clock=1000,deny=true;
  const request=async(url,options={})=>{
    calls++;if(options.method==='POST')return response(200,receipt);
    if(String(url).endsWith('/status'))return response(200,{status:'COMPLETED',request_id:JOB});
    if(String(url)===resultUrl)return deny?response(401,{detail:'access required'}):response(200,output());
    return response(200,image(Number(String(url).match(/layer-(\d+)/)[1])));
  };
  const backend=make(root,request,{now:()=>clock});await backend.submit(req());
  assert.equal((await make(root,request,{layers:4}).recover({operationKey:req().operationKey})).code,'BACKEND_CACHE_IDENTITY_MISMATCH');assert.equal(calls,1);
  assert.equal((await backend.query(JOB)).code,'BACKEND_AUTH_REQUIRED');assert.equal((await state(root)).status,'unknown');
  deny=false;clock+=1001;assert.equal((await backend.recover({operationKey:req().operationKey})).status,'completed');assert.equal((await state(root)).inferencePosts,1);assert.equal((await state(root)).httpStatus,undefined);
});

test('fal persists prompt digests only, not source data URIs or credentials echoed in captions',async t=>{
  const root=await setup(t),prompt=`caption ${KEY} data:image/png;base64,AAAA`;
  const backend=make(root,async()=>response(200,receipt),{prompt});await backend.submit(req());
  const saved=await state(root);assert.equal(saved.recipe.promptSha256,sha256(prompt));assert.equal(saved.recipe.prompt,undefined);
  assert.ok(!(await diskText(root)).includes(KEY));assert.ok(!(await diskText(root)).includes('data:image/'));
});

test('fal absolute POST deadline aborts transport and leaves an unknown original submission',async t=>{
  const root=await setup(t);let calls=0;
  const backend=make(root,async(url,{signal})=>{calls++;return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error(`echo ${KEY}`)),{once:true});});},{timeoutMs:15});
  assert.equal((await backend.submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal((await backend.submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal(calls,1);
});

test('fal restart after partial PNG download reuses validated first layer and only GETs the missing file',async t=>{
  const root=await setup(t);let posts=0,queries=0,results=0,fail=true;const downloads=[];
  const request=async(url,options={})=>{
    url=String(url);if(options.method==='POST'){posts++;return response(200,receipt);}
    if(url.endsWith('/status')){queries++;return response(200,{status:'COMPLETED',request_id:JOB});}
    if(url===resultUrl){results++;return response(200,output());}
    const ordinal=Number(url.match(/layer-(\d+)/)[1]);downloads.push(ordinal);
    if(ordinal===2&&fail){fail=false;throw new Error('offline interrupted download');}return response(200,image(ordinal));
  };
  await make(root,request).submit(req());assert.equal((await make(root,request).query(JOB)).code,'BACKEND_QUERY_INTERRUPTED');
  assert.equal((await make(root,request).recover({operationKey:req().operationKey})).status,'completed');
  assert.deepEqual(downloads,[1,2,2]);assert.deepEqual([posts,queries,results],[1,1,1]);
});

test('fal malformed submit receipt is unknown and oversized status is blocked, with no retry',async t=>{
  const root=await setup(t);let calls=0;
  const malformed=make(root,async()=>{calls++;return response(200,{status:'IN_QUEUE'});});
  assert.equal((await malformed.submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');await malformed.submit(req());assert.equal(calls,1);
  const other=await setup(t);let posts=0;
  const bounded=make(other,async(url,options={})=>{if(options.method==='POST'){posts++;return response(200,receipt);}return response(200,{status:'COMPLETED',detail:'x'.repeat(2000)});},{maxJsonBytes:1024});
  await bounded.submit(req());assert.equal((await bounded.query(JOB)).code,'BACKEND_RESPONSE_TOO_LARGE');assert.equal((await bounded.recover({operationKey:req().operationKey})).status,'blocked');assert.equal(posts,1);
});

test('fal coarse real PNGs through buildArtwork produce blocked Layout with no invented eye/mouth semantics',async t=>{
  const root=await setup(t),taskRoot=path.join(root,'candidate');
  await import('node:fs/promises').then(fs=>fs.mkdir(taskRoot));await writeFile(path.join(taskRoot,'source.png'),req().source.bytes);
  const input={schemaVersion:1,stage:'intake',status:'completed',taskId:'offline-task',candidateId:'offline-candidate',revision:1,parentRevision:null,inputSha256:req().source.sha256,descriptionSha256:'c'.repeat(64),sourceImage:{...req().source,path:'source.png',bytes:undefined},brief:{intent:{eyes:{blink:true},mouth:{speech:true}}},rights:{allowDerivatives:true},artifacts:[],checks:[],warnings:[],unresolved:[]};
  let posts=0;
  const request=async(url,options={})=>{
    if(options.method==='POST'){posts++;return response(200,receipt);}
    if(String(url).endsWith('/status'))return response(200,{status:'COMPLETED',request_id:JOB});
    if(String(url)===resultUrl)return response(200,output(4));
    return response(200,image(Number(String(url).match(/layer-(\d+)/)[1])));
  };
  const backend=make(path.join(root,'backend'),request,{layers:4});
  assert.equal((await buildArtwork(input,{taskRoot,artworkBackend:backend})).status,'awaiting_external_result');
  const bundle=await buildArtwork(input,{taskRoot,artworkBackend:backend});assert.equal(bundle.status,'blocked');
  assert.ok(bundle.checks.some(c=>c.name==='deformation-materials'&&c.status==='failed'));
  assert.ok(bundle.checks.filter(c=>c.layer==='visual').every(c=>c.status==='not_run'));
  const layout=JSON.parse(await readFile(path.join(taskRoot,bundle.layoutPath)));
  assert.equal(layout.layers.filter(l=>!l.reference).length,4);assert.ok(layout.layers.filter(l=>!l.reference).every(l=>l.tags.length===0));assert.equal(posts,1);
});

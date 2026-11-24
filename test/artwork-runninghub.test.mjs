import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createRunningHubLayeredBackend, buildArtwork } from '../src/artwork/index.mjs';
import { encodePng, crc32 } from '../src/artwork/png.mjs';
import { deflateSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from '../src/artwork/files.mjs';

// Transport, credentials, task IDs and pixels below are offline fixtures only.
const KEY='offline-fake-runninghub-key', JOB='2009191190196789249';
const BASE='https://www.runninghub.cn', FILE='openapi/offline-source.png';
const image=n=>encodePng({width:2,height:1,data:Buffer.from([n,20,30,128,0,0,0,0])});
const response=(status,body)=>({status,body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(JSON.stringify(body))])});
const req=()=>({operationKey:'offline-rh-operation',cacheKey:'offline-rh-cache',source:{bytes:image(50),sha256:sha256(image(50)),width:2,height:1,mimeType:'image/png'},rights:{allowDerivatives:true}});
const receipt={code:0,msg:'success',data:{taskId:JOB,taskStatus:'QUEUED',promptTips:''}};
const upload={code:0,message:'success',data:{fileName:FILE,type:'image',size:String(image(50).length)}};
const output=(count=4)=>({taskId:JOB,status:'SUCCESS',errorCode:'',errorMessage:'',results:Array.from({length:count},(_,i)=>({url:`https://rh-images.xiaoyaoyou.com/fixture/output/layer-${i+1}.png`,outputType:'png'}))});
async function setup(t){const root=await mkdtemp(path.join(tmpdir(),'artwork-runninghub-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const make=(stateDir,request,extra={})=>createRunningHubLayeredBackend({stateDir,apiKey:KEY,allowUnpinnedModel:true,budgetAuthorized:true,request,...extra});
const state=async root=>JSON.parse(await readFile(path.join(root,`${sha256(req().operationKey)}.json`),'utf8'));
async function diskText(root){return (await Promise.all((await readdir(root)).filter(f=>f.endsWith('.json')).map(f=>readFile(path.join(root,f),'utf8')))).join('\n');}
function transport({query=output(),file=image}={}){
  const counts={upload:0,inference:0,query:0,download:0};
  const request=async(url,options={})=>{
    if(String(url)===`${BASE}/openapi/v2/media/upload/binary`){counts.upload++;return response(200,upload);}
    if(String(url)===`${BASE}/task/openapi/ai-app/run`){counts.inference++;return response(200,receipt);}
    if(String(url)===`${BASE}/openapi/v2/query`){counts.query++;assert.deepEqual(JSON.parse(options.body),{taskId:JOB});return response(200,typeof query==='function'?query(counts.query):query);}
    counts.download++;assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);return response(200,file(Number(new URL(url).pathname.match(/layer-(\d+)/)?.[1]||1)));
  };
  return {request,counts};
}

test('RunningHub budget and unpinned acceptance are independent, default blocks all uploads/inference',async t=>{
  const root=await setup(t);let calls=0;const request=async()=>{calls++;throw new Error('must not call');};
  assert.equal((await createRunningHubLayeredBackend({stateDir:root,apiKey:KEY,allowUnpinnedModel:true,request}).submit(req())).code,'BACKEND_BUDGET_NOT_AUTHORIZED');
  assert.equal((await make(root,request,{allowUnpinnedModel:false}).submit(req())).code,'BACKEND_MODEL_UNPINNED');
  assert.equal((await make(root,request,{apiKey:undefined}).submit(req())).code,'BACKEND_AUTH_REQUIRED');assert.equal(calls,0);
});

test('RunningHub upload and inference intents are durable separately; exact app nodes and uint64 seed survive',async t=>{
  const root=await setup(t);let uploads=0,inferences=0;
  const request=async(url,options)=>{
    const s=await state(root);assert.equal(options.headers.Authorization,`Bearer ${KEY}`);
    if(url.endsWith('/binary')){
      uploads++;assert.equal(s.status,'upload_submitting');assert.deepEqual([s.uploadPosts,s.inferencePosts,s.queryPosts],[1,0,0]);
      const marker=JSON.parse(await readFile(path.join(root,`${sha256(req().operationKey)}-upload.json`)));assert.equal(marker.status,'submitting');assert.equal(marker.source.sha256,req().source.sha256);
      assert.match(options.headers['Content-Type'],/^multipart\/form-data; boundary=/);assert.ok(options.body.includes(req().source.bytes));assert.ok(!options.body.includes(KEY));return response(200,upload);
    }
    assert.equal(url,`${BASE}/task/openapi/ai-app/run`);inferences++;assert.equal(s.status,'inference_submitting');assert.equal(s.upload.fileName,FILE);
    const marker=JSON.parse(await readFile(path.join(root,`${sha256(req().operationKey)}-inference.json`)));assert.equal(marker.cacheKey,req().cacheKey);assert.equal(marker.status,'submitting');
    const body=JSON.parse(options.body);assert.deepEqual(body,{webappId:'2022230387451236353',apiKey:KEY,nodeInfoList:[{nodeId:'23',fieldName:'image',fieldValue:FILE},{nodeId:'20',fieldName:'value',fieldValue:'4'},{nodeId:'21',fieldName:'seed',fieldValue:'18446744073709551615'}]});
    return response(200,{...receipt,data:{...receipt.data,netWssUrl:`wss://www.runninghub.cn/ws?Rh-Comfy-Auth=do-not-save&apiKey=${KEY}`}});
  };
  const backend=make(root,request,{seed:'18446744073709551615'});assert.equal((await backend.submit(req())).jobId,JOB);
  const s=await state(root);assert.deepEqual([uploads,inferences,s.uploadPosts,s.inferencePosts,s.queryPosts],[1,1,1,1,0]);
  assert.ok(!(await diskText(root)).includes(KEY));assert.ok(!(await diskText(root)).includes('do-not-save'));
  for(const seed of [-1,Number.MAX_SAFE_INTEGER+1,'18446744073709551616','bad'])assert.throws(()=>make(root,request,{seed}),/BACKEND_SEED_INVALID/);
});

test('RunningHub queued/running/success, exact RGBA ordinal preservation and local cached recovery are distinct',async t=>{
  const root=await setup(t);let clock=1000;const tr=transport({query:n=>n===1?{taskId:JOB,status:'RUNNING'}:output()});
  let backend=make(root,tr.request,{now:()=>clock});assert.equal((await backend.submit(req())).status,'running');
  assert.equal((await backend.query(JOB)).status,'running');assert.equal((await backend.query(JOB)).code,'BACKEND_POLL_THROTTLED');clock+=5001;
  const result=await backend.recover({operationKey:req().operationKey});assert.equal(result.status,'completed');assert.equal(result.result.parts.length,4);
  result.result.parts.forEach((p,i)=>{assert.ok(p.png.equals(image(i+1)));assert.deepEqual(p.tags,[]);assert.equal(p.id,`runninghub-layer-${i+1}`);});
  assert.equal(result.result.quality.sourceCanvasMapping.verified,false);assert.ok(result.result.quality.checks.every(c=>c.status==='not_run'));
  backend=make(root,async()=>{throw new Error('must use cache');});assert.equal((await backend.recover({operationKey:req().operationKey})).status,'completed');
  const s=await state(root);assert.deepEqual([s.uploadPosts,s.inferencePosts,s.queryPosts],[1,1,2]);assert.deepEqual(tr.counts,{upload:1,inference:1,query:2,download:4});
  assert.equal(s.downloads[0].sha256,sha256(image(1)));assert.equal(s.downloads[0].alpha,'rgba');
});

test('RunningHub lost upload receipt never reuploads; confirmed original fileName recovers without inference until explicit submit',async t=>{
  const root=await setup(t);let uploads=0,inferences=0;
  const request=async url=>{if(url.endsWith('/binary')){uploads++;throw new Error(`lost ${KEY}`);}inferences++;return response(200,receipt);};
  assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
  assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal((await make(root,request).recover({operationKey:req().operationKey})).code,'EXTERNAL_RESULT_UNKNOWN');
  await assert.rejects(()=>make(root,request).recover({operationKey:req().operationKey,uploadedInput:{fileName:FILE,inputSha256:'a'.repeat(64)}}),/BACKEND_UPLOAD_IDENTITY_MISMATCH/);
  const confirmed={fileName:FILE,inputSha256:req().source.sha256};assert.equal((await make(root,request).recover({operationKey:req().operationKey,uploadedInput:confirmed})).code,'BACKEND_SUBMISSION_NOT_STARTED');assert.equal(inferences,0);
  assert.equal((await make(root,request).submit(req())).jobId,JOB);assert.deepEqual([uploads,inferences],[1,1]);
  const fresh=await setup(t);const tr=transport();await make(fresh,tr.request,{uploadedInput:confirmed}).submit(req());assert.equal(tr.counts.upload,0);assert.equal(tr.counts.inference,1);
});

test('RunningHub lost inference response or 5xx without taskId stays UNKNOWN across restart, never resubmits',async t=>{
  for(const mode of ['disconnect','500']){
    const root=await setup(t);let uploadPosts=0,inferencePosts=0;
    const request=async url=>{if(url.endsWith('/binary')){uploadPosts++;return response(200,upload);}inferencePosts++;if(mode==='disconnect')throw new Error(`Bearer ${KEY}`);return response(500,{errorMessage:'provider unavailable'});};
    assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
    assert.equal((await make(root,request).recover({operationKey:req().operationKey})).code,'EXTERNAL_RESULT_UNKNOWN');assert.deepEqual([uploadPosts,inferencePosts],[1,1]);
  }
});

test('RunningHub two instances cannot duplicate upload or inference, and another operation cannot reuse a cache claim',async t=>{
  const root=await setup(t);let uploads=0,inferences=0,release;const wait=new Promise(resolve=>{release=resolve;});
  const request=async url=>{if(url.endsWith('/binary')){uploads++;return response(200,upload);}inferences++;await wait;return response(200,receipt);};
  const first=make(root,request).submit(req());while(!inferences)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal((await make(root,request).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
  await assert.rejects(()=>make(root,request).submit({...req(),operationKey:'another-op'}),/BACKEND_CACHE_IDENTITY_MISMATCH/);
  release();assert.equal((await first).jobId,JOB);assert.deepEqual([uploads,inferences],[1,1]);
  const other=await setup(t);let uploaded=0,releaseUpload;const uploadWait=new Promise(resolve=>{releaseUpload=resolve;});
  const slow=async url=>{if(url.endsWith('/binary')){uploaded++;await uploadWait;return response(200,upload);}return response(200,receipt);};
  const pending=make(other,slow).submit(req());while(!uploaded)await new Promise(resolve=>setTimeout(resolve,1));
  assert.equal((await make(other,slow).submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');releaseUpload();await pending;assert.equal(uploaded,1);
});

test('RunningHub a new OS process retains an unknown original submission without making transport calls',async t=>{
  const root=await setup(t);let calls=0;
  const request=async url=>{calls++;if(url.endsWith('/binary'))return response(200,upload);throw new Error('lost original inference receipt');};
  await make(root,request).submit(req());assert.equal(calls,2);
  const script=`import {createRunningHubLayeredBackend} from ${JSON.stringify(new URL('../src/artwork/index.mjs',import.meta.url).href)};
    import {encodePng} from ${JSON.stringify(new URL('../src/artwork/png.mjs',import.meta.url).href)};
    import {sha256} from ${JSON.stringify(new URL('../src/artwork/files.mjs',import.meta.url).href)};
    const bytes=encodePng({width:2,height:1,data:Buffer.from([50,20,30,128,0,0,0,0])});let calls=0;
    const backend=createRunningHubLayeredBackend({stateDir:process.argv[1],apiKey:'offline-fake-runninghub-key',budgetAuthorized:true,allowUnpinnedModel:true,request:async()=>{calls++;throw Error('unexpected transport');}});
    const request={operationKey:'offline-rh-operation',cacheKey:'offline-rh-cache',source:{bytes,sha256:sha256(bytes),width:2,height:1,mimeType:'image/png'},rights:{allowDerivatives:true}};
    console.log(JSON.stringify({submit:await backend.submit(request),recover:await backend.recover({operationKey:request.operationKey}),calls}));`;
  const child=await promisify(execFile)(process.execPath,['--input-type=module','-e',script,root],{timeout:10000});
  const result=JSON.parse(child.stdout);assert.equal(result.calls,0);assert.equal(result.submit.code,'EXTERNAL_RESULT_UNKNOWN');assert.equal(result.recover.code,'EXTERNAL_RESULT_UNKNOWN');
  const s=await state(root);assert.deepEqual([s.uploadPosts,s.inferencePosts],[1,1]);
});

test('RunningHub duplicate task IDs cannot overwrite the original operation binding',async t=>{
  const root=await setup(t),tr=transport(),backend=make(root,tr.request);await backend.submit(req());
  const second={...req(),operationKey:'second-operation',cacheKey:'second-cache'};
  assert.equal((await backend.submit(second)).code,'BACKEND_JOB_IDENTITY_MISMATCH');
  assert.deepEqual(JSON.parse(await readFile(path.join(root,`job-${JOB}.json`))),{operationKey:req().operationKey});
  assert.equal((await backend.query(JOB,{operationKey:second.operationKey})).code,'BACKEND_JOB_IDENTITY_MISMATCH');
  assert.equal((await backend.query(JOB)).status,'completed');
});

test('RunningHub a stalled response body times out, preserves the original receipt and never retries inference',async t=>{
  const root=await setup(t);let uploads=0,inferences=0;
  const request=async url=>{if(url.endsWith('/binary')){uploads++;return response(200,upload);}inferences++;return {status:200,body:new Readable({read(){}})};};
  const backend=make(root,request,{timeoutMs:30});assert.equal((await backend.submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');
  assert.equal((await backend.submit(req())).code,'EXTERNAL_RESULT_UNKNOWN');assert.deepEqual([uploads,inferences],[1,1]);
  const other=await setup(t),tr=transport();await make(other,tr.request).submit(req());
  const query=make(other,async url=>{assert.equal(url,`${BASE}/openapi/v2/query`);return {status:200,body:new Readable({read(){}})};},{timeoutMs:30});
  assert.equal((await query.query(JOB)).code,'BACKEND_QUERY_INTERRUPTED');assert.equal((await state(other)).jobId,JOB);
});

test('RunningHub original task query uses POST but never upload/inference; HTTP404/disconnect remain unknown',async t=>{
  const root=await setup(t);const tr=transport();await make(root,tr.request).submit(req());let calls=0,clock=1000;
  const request=async(url,options)=>{assert.equal(url,`${BASE}/openapi/v2/query`);assert.equal(options.method,'POST');assert.deepEqual(JSON.parse(options.body),{taskId:JOB});calls++;if(calls===1)throw new Error('disconnected');return response(404,{message:'not found'});};
  let backend=make(root,request,{budgetAuthorized:false,allowUnpinnedModel:false,now:()=>clock});assert.equal((await backend.recover({operationKey:req().operationKey})).code,'BACKEND_QUERY_INTERRUPTED');clock+=5001;
  assert.equal((await backend.query(JOB)).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal((await state(root)).status,'unknown');assert.equal((await state(root)).queryPosts,2);
  assert.deepEqual(tr.counts,{upload:1,inference:1,query:0,download:0});
});

test('RunningHub real failure/errorCode/promptTips cannot be hidden by SUCCESS; unknown states and wrong IDs stay unknown',async t=>{
  for(const [payload,expected] of [
    [{taskId:JOB,status:'FAILED',errorCode:'1501',errorMessage:`denied ${KEY}`},'BACKEND_GENERATION_FAILED'],
    [{...output(),errorCode:'1501',errorMessage:'model failure'},'BACKEND_GENERATION_FAILED'],
    [{...output(),promptTips:JSON.stringify({result:false,node_errors:{23:{message:'invalid input'}}})},'BACKEND_GENERATION_FAILED'],
    [{taskId:JOB,status:'CANCELLED'},'BACKEND_GENERATION_CANCELLED'],
    [{taskId:JOB,status:'NOT_FOUND'},'EXTERNAL_RESULT_UNKNOWN'],
    [{...output(),taskId:'9999999999999999999'},'EXTERNAL_RESULT_UNKNOWN'],
    [{code:404,errorMessage:'no such task'},'EXTERNAL_RESULT_UNKNOWN']
  ]){
    const root=await setup(t),tr=transport({query:payload});const backend=make(root,tr.request);await backend.submit(req());assert.equal((await backend.query(JOB)).code,expected);assert.equal(tr.counts.download,0);assert.ok(!(await diskText(root)).includes(KEY));
  }
});

test('RunningHub signed CDN links stay in memory, API/session query credentials stripped, Bearer never reaches CDN',async t=>{
  const root=await setup(t);const signed=output();signed.results.forEach(f=>{f.url+=`?q-signature=memory-only-signature&apiKey=${KEY}&Rh-Comfy-Auth=private-session&authorization=private-header`;});
  const tr=transport({query:signed});const request=async(url,options)=>{
    if(options.method==='GET'){const u=new URL(url);assert.equal(u.searchParams.get('q-signature'),'memory-only-signature');assert.equal(u.searchParams.has('apiKey'),false);assert.equal(u.searchParams.has('Rh-Comfy-Auth'),false);assert.equal(u.searchParams.has('authorization'),false);assert.equal(options.headers.Authorization,undefined);}
    return tr.request(url,options);
  };
  const backend=make(root,request);await backend.submit(req());assert.equal((await backend.query(JOB)).status,'completed');const text=await diskText(root);
  for(const secret of [KEY,'memory-only-signature','private-session','private-header','?q-'])assert.ok(!text.includes(secret),secret);
});

test('RunningHub error receipt URL queries and echoed data/header secrets are redacted',async t=>{
  const root=await setup(t);const tr=transport({query:{taskId:JOB,status:'FAILED',errorCode:'BAD',errorMessage:`Bearer ${KEY} data:image/png;base64,AAAA https://rh-images.xiaoyaoyou.com/output/a.png?apiKey=alien-key&Rh-Comfy-Auth=alien-session; echoed "apiKey":"alien-inline" wss://example.invalid/ws?Rh-Comfy-Auth=alien-ws`,failedReason:{Authorization:'alien-bearer',apiKey:'alien-key',url:'https://example.invalid/?token=alien-token'},promptTips:JSON.stringify({apiKey:'alien-key',Authorization:'alien-bearer',signature:'alien-signature'})}});
  const backend=make(root,tr.request);await backend.submit(req());assert.equal((await backend.query(JOB)).status,'failed');const text=await diskText(root);
  for(const secret of [KEY,'data:image/','alien-key','alien-session','alien-bearer','alien-token','alien-inline','alien-ws','alien-signature'])assert.ok(!text.includes(secret),secret);
});

test('RunningHub malicious/foreign URLs and unsupported archive/composite/count never reach downloads',async t=>{
  for(const value of ['http://rh-images.xiaoyaoyou.com/fixture/output/a.png','https://127.0.0.1/output/a.png','https://rh-images.xiaoyaoyou.com.evil.test/output/a.png','https://user:pass@rh-images.xiaoyaoyou.com/output/a.png','https://rh-images.xiaoyaoyou.com/output/%2e%2e/a.png','https://rh-images.xiaoyaoyou.com/output/a.png#fragment']){
    const root=await setup(t),out=output();out.results[0].url=value;const tr=transport({query:out}),backend=make(root,tr.request);await backend.submit(req());assert.equal((await backend.query(JOB)).code,'BACKEND_FILE_URL_INVALID');assert.equal(tr.counts.download,0);
  }
  for(const out of [output(1),output(9),{...output(),results:[{url:'https://rh-images.xiaoyaoyou.com/output/all.zip',outputType:'zip'}]}, {...output(),results:output().results.map(f=>({...f,outputType:'psd'}))}]){
    const root=await setup(t),tr=transport({query:out}),backend=make(root,tr.request);await backend.submit(req());assert.equal((await backend.query(JOB)).code,'BACKEND_OUTPUT_UNSUPPORTED');assert.equal(tr.counts.download,0);
  }
});

test('RunningHub redirects, invalid pixels, nonRGBA, mismatched canvas and finite budgets fail honestly',async t=>{
  const chunk=(type,data)=>{const b=Buffer.alloc(data.length+12);b.writeUInt32BE(data.length);b.write(type,4);data.copy(b,8);b.writeUInt32BE(crc32(b.subarray(4,-4)),b.length-4);return b;};
  const h=Buffer.alloc(13);h.writeUInt32BE(2);h.writeUInt32BE(1,4);h[8]=8;h[9]=2;
  const rgb=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',h),chunk('IDAT',deflateSync(Buffer.from([0,1,2,3,4,5,6]))),chunk('IEND',Buffer.alloc(0))]);
  for(const [mode,expected,opts]of [['redirect','BACKEND_DOWNLOAD_HTTP_ERROR',{}],['invalid','BACKEND_PIXELS_INVALID',{}],['rgb','BACKEND_ALPHA_REQUIRED',{}],['canvas','BACKEND_LAYER_CANVAS_MISMATCH',{}],['bytes','BACKEND_RESPONSE_TOO_LARGE',{maxFileBytes:10}],['pixels','BACKEND_OUTPUT_SIZE_LIMIT',{maxTotalPixels:3}],['json','BACKEND_RESPONSE_TOO_LARGE',{maxJsonBytes:400}]]){
    const root=await setup(t);const tr=transport({file:n=>mode==='invalid'?Buffer.from('not PNG'):mode==='rgb'?rgb:mode==='canvas'&&n===2?encodePng({width:1,height:1,data:Buffer.from([1,2,3,128])}):image(n),query:mode==='json'?{...output(),errorMessage:'x'.repeat(500)}:output()});
    let gets=0;const request=async(url,options)=>{if(options.method==='GET'){gets++;if(mode==='redirect')return response(302,'');}return tr.request(url,options);};
    const backend=make(root,request,opts);await backend.submit(req());assert.equal((await backend.query(JOB)).code,expected,mode);if(mode==='redirect')assert.equal(gets,1);
  }
});

test('RunningHub interrupted download recovery queries original ID, downloads only missing PNGs, never resubmits',async t=>{
  const root=await setup(t);let clock=1000,fail=true;const gets=[0,0,0,0],tr=transport();
  const request=async(url,options)=>{if(options.method==='GET'){const n=Number(new URL(url).pathname.match(/layer-(\d+)/)[1]);gets[n-1]++;if(n===2&&fail){fail=false;throw new Error('connection lost');}}return tr.request(url,options);};
  let backend=make(root,request,{now:()=>clock});await backend.submit(req());assert.equal((await backend.query(JOB)).code,'BACKEND_QUERY_INTERRUPTED');assert.equal((await state(root)).downloads.length,1);clock+=5001;
  backend=make(root,request,{now:()=>clock});assert.equal((await backend.recover({operationKey:req().operationKey})).status,'completed');assert.deepEqual(gets,[1,2,1,1]);assert.deepEqual([tr.counts.upload,tr.counts.inference,tr.counts.query],[1,1,2]);
  await writeFile(path.join(root,(await state(root)).downloads[0].path),image(99));assert.equal((await backend.recover({operationKey:req().operationKey})).code,'BACKEND_CACHE_CHANGED');assert.deepEqual(gets,[1,2,1,1]);
});

test('RunningHub input/hash/rights/recipe changes cannot inherit an old operation',async t=>{
  const root=await setup(t),tr=transport();await make(root,tr.request).submit(req());
  const changed=req();changed.source={...changed.source,bytes:image(22),sha256:sha256(image(22))};await assert.rejects(()=>make(root,tr.request).submit(changed),/BACKEND_CACHE_IDENTITY_MISMATCH/);
  await assert.rejects(()=>make(root,tr.request,{seed:'42'}).submit(req()),/BACKEND_CACHE_IDENTITY_MISMATCH/);
  await assert.rejects(()=>make(root,tr.request).submit({...req(),rights:{allowDerivatives:false}}),/BACKEND_REQUEST_INVALID/);
  assert.equal((await make(root,tr.request,{seed:'42'}).recover({operationKey:req().operationKey})).code,'BACKEND_CACHE_IDENTITY_MISMATCH');assert.equal(tr.counts.inference,1);
});

test('RunningHub four coarse RGBA fixtures through actual buildArtwork remain blocked, no eye/mouth semantics or visual pass',async t=>{
  const root=await setup(t),taskRoot=path.join(root,'candidate');await mkdir(taskRoot);await writeFile(path.join(taskRoot,'source.png'),req().source.bytes);
  const input={schemaVersion:1,stage:'intake',status:'completed',taskId:'offline-task',candidateId:'offline-candidate',revision:1,parentRevision:null,inputSha256:req().source.sha256,descriptionSha256:'c'.repeat(64),sourceImage:{...req().source,path:'source.png',bytes:undefined},brief:{intent:{eyes:{blink:true},mouth:{speech:true}}},rights:{allowDerivatives:true},artifacts:[],checks:[],warnings:[],unresolved:[]};
  const tr=transport(),backend=make(path.join(root,'backend'),tr.request);assert.equal((await buildArtwork(input,{taskRoot,artworkBackend:backend})).status,'awaiting_external_result');
  const bundle=await buildArtwork(input,{taskRoot,artworkBackend:backend});assert.equal(bundle.status,'blocked');assert.ok(bundle.checks.some(c=>c.name==='deformation-materials'&&c.status==='failed'));assert.ok(bundle.checks.filter(c=>c.layer==='visual').every(c=>c.status==='not_run'));
  const layout=JSON.parse(await readFile(path.join(taskRoot,bundle.layoutPath)));assert.equal(layout.layers.filter(l=>!l.reference).length,4);assert.ok(layout.layers.filter(l=>!l.reference).every(l=>l.tags.length===0));assert.equal(tr.counts.inference,1);
});

test('quoted standard Flash submits only the quoted request once, with a verified anonymous source GET and recoverable original task',async t=>{
  const root=await setup(t),input=req(),p={imageUrl:'https://opengameart.org/sites/default/files/front_5.png',prompt:'offline',resolution:'auto',outputFormat:'png'};
  input.inputSha256=input.source.sha256;
  const quote={host:'www.runninghub.cn',path:'/openapi/v2/price-preview/seedream-v5-flash/layer-decomposition',httpStatus:200,errorCode:'',currency:'CNY',estimatedPrice:.11,
    inputSha256:input.inputSha256,params:p,paramsSha256:sha256(JSON.stringify(p))};
  let posts=0,queries=0,downloads=0,publicImage=input.source.bytes;
  const box={absolute:[258,182,763,1014],normalized:[252,178,744,989]};
  const request=async(url,options)=>{
    if(String(url)===p.imageUrl){assert.equal(options.method,'GET');assert.equal(options.headers.Authorization,undefined);return response(200,publicImage);}
    if(String(url)===BASE+'/openapi/v2/seedream-v5-flash/layer-decomposition'){
      assert.equal(options.headers.Authorization,'Bearer '+KEY);assert.deepEqual(JSON.parse(options.body),p);posts++;return response(200,{taskId:JOB,status:'RUNNING'});
    }
    if(String(url)===BASE+'/openapi/v2/query'){queries++;const rows=output(2);Object.assign(rows.results[1],{boundingBox:box,zindex:1});return response(200,rows);}
    downloads++;assert.equal(options.headers.Authorization,undefined);return response(200,image(String(url).includes('layer-1')?1:2));
  };
  const build=()=>make(root,request,{flashQuote:quote,allowUnpinnedModel:false});
  assert.equal((await build().submit({...input,inputSha256:'a'.repeat(64)})).code,'FLASH_INPUT_HASH_MISMATCH');
  publicImage=image(99);assert.equal((await build().submit({...input,operationKey:'changed-source',cacheKey:'changed-input'})).code,'FLASH_INPUT_URL_CHANGED');assert.equal(posts,0);
  publicImage=input.source.bytes;
  assert.equal((await build().submit(input)).jobId,JOB);
  let result=await build().recover({operationKey:input.operationKey});
  assert.equal(result.result.parts.length,2);assert.deepEqual(result.result.parts[1].providerBox,box);assert.equal(result.result.parts[1].providerOrder,1);
  const old=await state(root);delete old.placementSchema;delete old.files[1].providerBox;delete old.files[1].z;
  await writeFile(path.join(root,sha256(input.operationKey)+'.json'),JSON.stringify(old));
  result=await build().recover({operationKey:input.operationKey});assert.deepEqual(result.result.parts[1].providerBox,box);
  await build().recover({operationKey:input.operationKey});
  assert.deepEqual([posts,queries,downloads],[1,2,2]);
  assert.equal((await state(root)).uploadPosts,0);
  assert.throws(()=>make(root,request,{flashQuote:{...quote,params:{...p,prompt:'drift'}}}),/FLASH_QUOTE_MISMATCH/);
});

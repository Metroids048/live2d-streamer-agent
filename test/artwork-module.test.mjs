import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { deflateSync } from 'node:zlib';
import { buildArtwork, artworkRecipe } from '../src/artwork/index.mjs';
import { materialGaps } from '../src/rigging/recipe.mjs';
import { createSeeThroughBackend, semanticTags } from '../src/artwork/see-through.mjs';
import { decodeLayeredPsd } from '../src/artwork/psd.mjs';
import { encodePng, decodePng, alphaBounds, composite, cropPng } from '../src/artwork/png.mjs';
import { sha256 } from '../src/artwork/files.mjs';

const evidence=fileURLToPath(new URL('../evidence/single-image-live2d/02/',import.meta.url));
const pixel=(r,g,b,a=255)=>({width:1,height:1,data:Buffer.from([r,g,b,a])});
const u16=n=>{const b=Buffer.alloc(2);b.writeUInt16BE(n);return b;};
const i16=n=>{const b=Buffer.alloc(2);b.writeInt16BE(n);return b;};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const i32=n=>{const b=Buffer.alloc(4);b.writeInt32BE(n);return b;};
const section=b=>Buffer.concat([u32(b.length),b]);

// Test-only independent flat PSD fixture encoder, not a production PSD writer.
function psdFixture({compression=0,mask=false}={}) {
  const records=[],payload=[];
  for(const [name,rgba,left] of [['虹膜-r',[255,20,30,128],1],['face',[20,40,200,255],0]]) {
    const channels=rgba.map(v=>compression===0?Buffer.concat([u16(0),Buffer.from([v])]):compression===1?Buffer.concat([u16(1),u16(2),Buffer.from([0,v])]):Buffer.concat([u16(2),deflateSync(Buffer.from([v]))]));
    const pascal=Buffer.from(name==='face'?'face':'iris');
    const uni=Buffer.from(name,'utf16le');for(let i=0;i<uni.length;i+=2){const v=uni[i];uni[i]=uni[i+1];uni[i+1]=v;}
    const unicode=Buffer.concat([u32(name.length),uni]);
    const extra=Buffer.concat([section(mask?Buffer.alloc(20):Buffer.alloc(0)),section(Buffer.alloc(0)),Buffer.from([pascal.length]),pascal,Buffer.alloc((4-(pascal.length+1)%4)%4),Buffer.from('8BIMluni'),section(unicode),Buffer.alloc(unicode.length%2)]);
    records.push(Buffer.concat([i32(0),i32(left),i32(1),i32(left+1),u16(4),...[0,1,2,-1].map((id,i)=>Buffer.concat([i16(id),u32(channels[i].length)])),Buffer.from('8BIMnorm'),Buffer.from([255,0,0,0]),section(extra)]));
    payload.push(...channels);
  }
  const layers=Buffer.concat([i16(2),...records,...payload]);
  return Buffer.concat([Buffer.from('8BPS'),u16(1),Buffer.alloc(6),u16(4),u32(1),u32(2),u16(8),u16(3),section(Buffer.alloc(0)),section(Buffer.alloc(0)),section(Buffer.concat([section(layers),u32(0)])),u16(0),Buffer.alloc(8)]);
}
async function setup(t) {
  await fs.mkdir(evidence,{recursive:true});const taskRoot=await fs.mkdtemp(path.join(evidence,'test-temp-'));t.after(()=>fs.rm(taskRoot,{recursive:true,force:true}));
  await fs.mkdir(path.join(taskRoot,'intake'));
  const bytes=encodePng({width:2,height:2,data:Buffer.from([10,20,30,255,40,50,60,255,70,80,90,255,100,110,120,0])});
  await fs.writeFile(path.join(taskRoot,'intake/normalized.png'),bytes);
  const input={schemaVersion:1,taskId:'fixture-only',candidateId:'test',revision:'r01',parentRevision:null,inputSha256:sha256(bytes),descriptionSha256:sha256('fixture-only'),stage:'intake',status:'completed',artifacts:[],checks:[],warnings:[],unresolved:[],sourceImage:{path:'intake/normalized.png',mimeType:'image/png',width:2,height:2,hasAlpha:true,sha256:sha256(bytes)},brief:{originalDescription:'Fixture only; not a character or user acceptance.'},rights:{allowDerivatives:true,allowRedistribution:false,license:'self-created geometric test only',source:'test'}};
  return {taskRoot,input,ctx:{taskRoot,taskId:input.taskId,candidateId:input.candidateId,revision:input.revision}};
}
const coarse=()=>({canvas:{width:2,height:2},parts:[{id:'face',name:'face',png:encodePng(pixel(150,90,70)),rect:{left:0,top:0,width:1,height:1},tags:['face'],origin:'inpainted'},{id:'hair',name:'front hair',png:encodePng(pixel(20,30,90,200)),rect:{left:1,top:0,width:1,height:1},tags:['hair','front'],origin:'segmented'}]});
const fake=result=>({id:'test-only-mock',version:'1',modelVersion:'fixture',submit:async()=>({status:'completed',result}),query:async()=>({status:'completed',result})});
const response=(status,body)=>({status,ok:status>=200&&status<300,body:Readable.from([Buffer.isBuffer(body)?body:Buffer.from(typeof body==='string'?body:JSON.stringify(body))])});
const backendRequest=()=>{const bytes=encodePng(pixel(10,20,30));return {operationKey:'test-op',cacheKey:'test-cache',source:{bytes,sha256:sha256(bytes),mimeType:'image/png',width:1,height:1},rights:{allowDerivatives:true}};};

// Geometric contract probe only. The three visual results below are explicitly mocked.
function fineFixture(requirements) {
  return {canvas:{width:64,height:64},parts:requirements.map((semantic,i)=>({id:`fine-${i}`,name:semantic,png:encodePng(pixel(i+1,100,180)),rect:{left:i,top:0,width:1,height:1},tags:semantic.split(':'),origin:'generated'})),quality:{checks:['identity-preservation','occlusion-completion','default-composite'].map(name=>({name,layer:'visual',status:'passed',evidence:'mock-only geometric fixture'}))}};
}
const motionBrief=()=>({intent:{eyes:{blink:true,gaze:true},mouth:{speech:true},expressions:['happy','angry']}});

test('02 allows identical eye pixels only in disjoint opposite slots of a verified local portrait',async t=>{
  for(const [backendId,overlap,expected] of [['local-layer-layout',false,false],['local-layer-layout',true,true],['test-only-mock',false,true]]) {
    const s=await setup(t),profile={continuousWave:false,noLowerLash:[],basis:'fixture'};
    s.input.brief=motionBrief();
    const r=fineFixture(artworkRecipe(s.input.brief).required);
    r.quality.originalCropMatch=true;
    const [left,right]=r.parts.filter(p=>p.tags.includes('iris'));
    right.png=left.png;
    if(overlap)right.rect={...left.rect};
    const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:{...fake(r),id:backendId,productionProfile:profile}});
    assert.equal(b.checks.some(c=>c.name===`part:${right.id}:unique-pixels`&&c.status==='failed'),expected);
  }
});

test('02 blocks missing closed-eye and closed-mouth pixels required by 03',async t=>{
  const s=await setup(t);s.input.brief=motionBrief();
  const r=fineFixture(artworkRecipe(s.input.brief).required.filter(x=>!x.split(':').includes('closed')));
  assert.ok(materialGaps(r.parts,s.input.brief).some(x=>x.code==='EYE_CLOSED_MATERIAL_MISSING'));
  const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(r)});
  assert.equal(b.status,'blocked');
  const manifest=JSON.parse(await fs.readFile(path.join(s.taskRoot,b.artworkManifestPath)));
  for(const semantic of ['eye:closed:left','eye:closed:right','mouth:closed'])assert.ok(manifest.missingSemantics.includes(semantic));
});

test('hidden closed-eye variants count as material without entering the default composite',async t=>{
  const s=await setup(t);s.input.brief=motionBrief();
  const required=artworkRecipe(s.input.brief).required;
  for(const semantic of ['eye:closed:left','eye:closed:right','mouth:closed'])assert.ok(required.includes(semantic));
  const r=fineFixture(required);
  for(const p of r.parts.filter(p=>p.tags.includes('eye')&&p.tags.includes('closed'))){p.visible=false;p.variant={type:'toggle',parameter:p.tags.includes('left')?'ParamEyeLOpen':'ParamEyeROpen'};}
  assert.deepEqual(materialGaps(r.parts,s.input.brief),[]);
  const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(r)});assert.equal(b.status,'completed');
  const layout=JSON.parse(await fs.readFile(path.join(s.taskRoot,b.layoutPath)));
  assert.equal(layout.layers.filter(p=>p.tags?.includes('closed')&&p.tags.includes('eye')).every(p=>p.visible===false),true);
});

test('missing backend or withdrawn rights cannot overwrite a completed candidate receipt',async t=>{
  const s=await setup(t);const first=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(coarse())});
  const original=JSON.stringify({...first,status:'completed'});await fs.writeFile(path.join(s.taskRoot,'artwork/stage.json'),original);
  assert.equal((await buildArtwork(s.input,s.ctx)).status,'blocked');
  assert.equal(await fs.readFile(path.join(s.taskRoot,'artwork/stage.json'),'utf8'),original);
  assert.equal((await buildArtwork({...s.input,rights:{allowDerivatives:false}},s.ctx)).status,'blocked');
  assert.equal(await fs.readFile(path.join(s.taskRoot,'artwork/stage.json'),'utf8'),original);
});

test('02 refuses wrong-stage or unresolved intake before any backend submission',async t=>{
  const s=await setup(t);let submits=0;const backend={...fake(coarse()),submit:async()=>{submits++;return {status:'completed',result:coarse()};}};
  for(const input of [{...s.input,stage:'rigging'},{...s.input,checks:[{name:'source-review',layer:'visual',status:'failed'}]},{...s.input,unresolved:[{code:'AMBIGUOUS_CHARACTER'}]}]){
    const b=await buildArtwork(input,{...s.ctx,artworkBackend:backend});assert.equal(b.status,'blocked');assert.equal(b.layoutPath,undefined);
  }
  assert.equal(submits,0);
});

test('PNG pixel round trip, alpha bounds, CRC rejection and back-to-front alpha composition',()=>{
  const image={width:2,height:2,data:Buffer.from([0,0,0,0,255,0,0,255,0,0,0,0,0,0,0,0])};
  const png=encodePng(image);assert.deepEqual(decodePng(png).data,image.data);assert.deepEqual(alphaBounds(image),{left:1,top:0,width:1,height:1,opaquePixels:1,transparentPixels:3});
  const bad=Buffer.from(png);bad[45]^=1;assert.throws(()=>decodePng(bad),/PNG_CRC_INVALID/);
  const combined=composite({width:1,height:1},[{image:pixel(0,0,255),rect:{left:0,top:0,width:1,height:1}},{image:pixel(255,0,0),rect:{left:0,top:0,width:1,height:1},opacity:.5}]);assert.deepEqual([...combined.data],[128,0,128,255]);
});
for(const compression of [0,1,2])test(`PSD real binary decode preserves unicode, alpha, bounds and reverses record order, compression ${compression}`,()=>{
  const result=decodeLayeredPsd(psdFixture({compression}));assert.deepEqual(result.canvas,{width:2,height:1});assert.deepEqual(result.parts.map(p=>p.name),['face','虹膜-r']);assert.equal(result.parts[1].rect.left,1);assert.deepEqual([...decodePng(result.parts[1].png).data],[255,20,30,128]);
});
test('PSD rejects masks and truncated data instead of flattening to a fake layer',()=>{
  assert.throws(()=>decodeLayeredPsd(psdFixture({mask:true})),/PSD_BLEND_OR_MASK_UNSUPPORTED/);assert.throws(()=>decodeLayeredPsd(psdFixture().subarray(0,100)),/PSD_TRUNCATED/);
});
test('official semantic side suffix maps to character-relative side, coarse eyelash is not upper/lower',()=>{
  assert.deepEqual(semanticTags('eyewhite-r'),['eye','white','right']);assert.deepEqual(semanticTags('eyelash-l'),['eye','lash','left']);assert.deepEqual(semanticTags('front hair'),['hair','front']);
});
test('no backend or rights yields explicit blocked stage without invented pixels',async t=>{
  const s=await setup(t);const b=await buildArtwork(s.input,s.ctx);assert.equal(b.status,'blocked');assert.equal(b.unresolved.at(-1).code,'BACKEND_UNAVAILABLE');assert.equal(b.layoutPath,undefined);
  const b2=await buildArtwork({...s.input,rights:{allowDerivatives:false}},{...s.ctx,artworkBackend:fake(coarse())});assert.equal(b2.unresolved.at(-1).code,'RIGHTS_UNRESOLVED');
});
test('normalized source hash differs from original identity and remains valid',async t=>{
  const s=await setup(t);s.input.inputSha256=sha256('original JPEG bytes');const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(coarse())});assert.equal(b.status,'blocked');assert.ok(b.layoutPath);assert.equal(b.inputSha256,s.input.inputSha256);
});
test('coarse real pixels produce native layout and diagnostic files but fail detailed eye/mouth quality',async t=>{
  const s=await setup(t);const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(coarse())});assert.equal(b.status,'blocked');assert.ok(b.checks.some(c=>c.name==='deformation-materials'&&c.status==='failed'));
  assert.deepEqual(b.brief,s.input.brief);assert.deepEqual(b.rights,s.input.rights);assert.deepEqual(b.sourceImage,s.input.sourceImage);
  const layout=JSON.parse(await fs.readFile(path.join(s.taskRoot,b.layoutPath)));assert.equal(layout.format,'psd2live-layout');assert.equal(layout.layers[0].reference,true);assert.equal(layout.layers[0].visible,false);assert.equal(layout.layers[1].id,'face');
  assert.deepEqual([...decodePng(await fs.readFile(path.join(s.taskRoot,'artwork/composite.png'))).data.subarray(0,4)],[150,90,70,255]);
  for(const a of b.artifacts){assert.equal(a.sha256,sha256(await fs.readFile(path.join(s.taskRoot,a.path))));assert.equal(path.isAbsolute(a.path),false);}
  const manifest=JSON.parse(await fs.readFile(path.join(s.taskRoot,b.artworkManifestPath)));assert.ok(manifest.missingSemantics.includes('mouth:open'));assert.equal(manifest.previews.note.includes('not Live2D'),true);
});
test('alpha trim adjusts native rect without changing visible placement',async t=>{
  const s=await setup(t),r=coarse();r.parts[0].png=encodePng({width:2,height:2,data:Buffer.from([0,0,0,0,255,20,10,255,0,0,0,0,0,0,0,0])});r.parts[0].rect={left:0,top:1,width:4,height:6};
  const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(r)});const layout=JSON.parse(await fs.readFile(path.join(s.taskRoot,b.layoutPath)));assert.deepEqual(layout.layers[1].rect,{left:2,top:1,width:2,height:3});assert.deepEqual(layout.layers[1].image,{path:'parts/face.png',width:1,height:1});
});
test('whole-source copies and duplicate named parts cannot pass decomposition',async t=>{
  const s=await setup(t),r=coarse();r.parts[0].png=await fs.readFile(path.join(s.taskRoot,s.input.sourceImage.path));r.parts[1].png=r.parts[0].png;
  const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(r)});assert.equal(b.status,'blocked');assert.ok(b.checks.some(c=>c.name.endsWith(':not-source-copy')&&c.status==='failed'));assert.ok(b.checks.some(c=>c.name.endsWith(':unique-pixels')&&c.status==='failed'));
});
test('bad variant, symlink output and changed normalized source are refused',async t=>{
  const s=await setup(t),r=coarse();r.parts[0].variant={type:'switch',parameter:'Mouth',switch_id:-1};const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(r)});assert.equal(b.layoutPath,undefined);assert.equal(b.unresolved.at(-1).message,'ARTWORK_VARIANT_INVALID');
  const link=await setup(t);await fs.symlink(path.join(link.taskRoot,'intake'),path.join(link.taskRoot,'artwork'));await assert.rejects(()=>buildArtwork(link.input,link.ctx),/ARTWORK_SYMLINK_REJECTED/);
  const changed=await setup(t);await fs.writeFile(path.join(changed.taskRoot,changed.input.sourceImage.path),'changed');await assert.rejects(()=>buildArtwork(changed.input,changed.ctx),/ARTWORK_SOURCE_HASH_MISMATCH/);
});
test('running receipt resumes query, never submits again; revision recipe change refuses overwrite',async t=>{
  const s=await setup(t);let submits=0,queries=0;const backend={...fake(coarse()),submit:async()=>{submits++;return {status:'running',jobId:'fixture-job'};},query:async id=>{queries++;assert.equal(id,'fixture-job');return {status:'completed',result:coarse()};}};
  const first=await buildArtwork(s.input,{...s.ctx,artworkBackend:backend});assert.equal(first.status,'awaiting_external_result');const next=await buildArtwork(s.input,{...s.ctx,artworkBackend:backend});assert.ok(next.layoutPath);assert.deepEqual([submits,queries],[1,1]);
  const original=await fs.readFile(path.join(s.taskRoot,'artwork/stage.json'),'utf8');const conflict=await buildArtwork({...s.input,brief:{changed:true}},{...s.ctx,artworkBackend:backend});assert.equal(conflict.unresolved.at(-1).code,'CANDIDATE_IMMUTABLE');assert.equal(await fs.readFile(path.join(s.taskRoot,'artwork/stage.json'),'utf8'),original);
});
test('unknown submit response resumes only recover using original operation key',async t=>{
  const s=await setup(t);let submits=0,recovery=0;const backend={...fake(coarse()),submit:async()=>{submits++;throw new Error('lost response');},recover:async({operationKey})=>{assert.match(operationKey,/^[a-f0-9]{64}$/);recovery++;return {status:'blocked',code:'EXTERNAL_RESULT_UNKNOWN'};}};
  assert.equal((await buildArtwork(s.input,{...s.ctx,artworkBackend:backend})).status,'awaiting_external_result');assert.equal((await buildArtwork(s.input,{...s.ctx,artworkBackend:backend})).status,'awaiting_external_result');assert.deepEqual([submits,recovery],[1,1]);
});
test('concrete adapter uses real Gradio shapes, persists receipt, parses PSD and caches download',async t=>{
  const s=await setup(t);let uploads=0,calls=0,events=0,downloads=0;const job='a'.repeat(32);
  const request=async(url,options={})=>{url=String(url);if(url.endsWith('/upload')){uploads++;assert.match(options.headers['content-type'],/^multipart\/form-data/);return response(200,['/tmp/server/source.png']);}
    if(url.endsWith('/call/inference')){calls++;assert.deepEqual(JSON.parse(options.body).data,[{path:'/tmp/server/source.png',meta:{_type:'gradio.FileData'}},768,42,true]);return response(200,{event_id:job});}
    if(url.endsWith(job)){events++;return response(200,`event: heartbeat\ndata: null\n\nevent: complete\ndata: ${JSON.stringify([{path:'/tmp/out.psd'},[]])}\n\n`);}
    downloads++;assert.ok(url.includes('/gradio_api/file='));return response(200,psdFixture());};
  const backend=createSeeThroughBackend({stateDir:path.join(s.taskRoot,'artwork/backend'),request});assert.deepEqual(await backend.submit(backendRequest()),{status:'running',jobId:job});
  const done=await backend.query(job);assert.equal(done.status,'completed');assert.equal(done.result.parts.length,2);assert.ok(done.result.quality.checks.every(c=>c.status==='not_run'));
  assert.equal((await backend.recover({operationKey:'test-op'})).status,'completed');assert.deepEqual([uploads,calls,events,downloads],[1,1,1,1]);
});
test('lost Gradio POST receipt is never uploaded/submitted again after process restart',async t=>{
  const s=await setup(t);let posts=0;const request=async url=>{posts++;if(String(url).endsWith('/upload'))return response(200,['/tmp/server.png']);throw new Error('lost POST receipt');};const config={stateDir:path.join(s.taskRoot,'artwork/backend'),request};
  assert.equal((await createSeeThroughBackend(config).submit(backendRequest())).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal((await createSeeThroughBackend(config).submit(backendRequest())).code,'EXTERNAL_RESULT_UNKNOWN');assert.equal(posts,2);
});
test('Gradio auth and quota blocks are precise and not retried',async t=>{
  for(const status of [401,403,429]){const s=await setup(t);let calls=0;const backend=createSeeThroughBackend({stateDir:path.join(s.taskRoot,'artwork/backend'),request:async()=>{calls++;return response(status,'denied');}});const expected=status===401?'BACKEND_AUTH_REQUIRED':status===403?'BACKEND_ACCESS_DENIED':'BACKEND_QUOTA_OR_QUEUE_LIMIT';assert.equal((await backend.submit(backendRequest())).code,expected);assert.equal((await backend.submit(backendRequest())).code,expected);assert.equal(calls,1);}
});
test('terminal PSD corruption is blocked, not misreported as a running external job',async t=>{
  const s=await setup(t),job='b'.repeat(32);const backend=createSeeThroughBackend({stateDir:path.join(s.taskRoot,'artwork/backend'),request:async url=>{url=String(url);if(url.endsWith('/upload'))return response(200,['/tmp/a.png']);if(url.endsWith('/call/inference'))return response(200,{event_id:job});if(url.endsWith(job))return response(200,'event: complete\ndata: [{"path":"/tmp/b.psd"},[]]\n\n');return response(200,Buffer.from('not a PSD'));}});
  await backend.submit(backendRequest());const result=await backend.query(job);assert.equal(result.status,'blocked');assert.equal(result.code,'BACKEND_PIXELS_INVALID');
});

test('Gradio lost SSE session is unknown, not a proven generation failure',async t=>{
  const s=await setup(t),job='c'.repeat(32);let requests=0;
  const config={stateDir:path.join(s.taskRoot,'artwork/backend'),request:async url=>{requests++;url=String(url);if(url.endsWith('/upload'))return response(200,['/tmp/a.png']);if(url.endsWith('/call/inference'))return response(200,{event_id:job});return response(200,'event: error\ndata: "404: Not Found"\n\n');}};
  const backend=createSeeThroughBackend(config);await backend.submit(backendRequest());
  const first=await backend.query(job);assert.equal(first.status,'blocked');assert.equal(first.code,'EXTERNAL_RESULT_UNKNOWN');assert.equal(first.note,'"404: Not Found"');
  const restarted=createSeeThroughBackend(config);
  assert.equal((await restarted.query(job)).note,first.note);
  assert.equal((await restarted.recover({operationKey:'test-op'})).note,first.note);
  assert.equal(requests,3);
});

test('legacy misclassified SSE 404 receipt is corrected without losing the original failure',async t=>{
  const s=await setup(t),stateDir=path.join(s.taskRoot,'artwork/backend'),job='d'.repeat(32);await fs.mkdir(stateDir,{recursive:true});
  const legacy={operationKey:'test-op',cacheKey:'test-cache',jobId:job,status:'failed',code:'BACKEND_GENERATION_FAILED',errorSummary:'"404: Not Found"'};
  await fs.writeFile(path.join(stateDir,`${sha256('test-op')}.json`),JSON.stringify(legacy));
  let calls=0;const b=createSeeThroughBackend({stateDir,request:async()=>{calls++;throw new Error('must not send');}});
  const result=await b.recover({operationKey:'test-op'});assert.equal(result.code,'EXTERNAL_RESULT_UNKNOWN');assert.equal(result.status,'blocked');assert.equal(calls,0);
  const saved=JSON.parse(await fs.readFile(path.join(stateDir,`${sha256('test-op')}.json`)));assert.equal(saved.history[0].code,legacy.code);assert.equal(saved.history[0].errorSummary,legacy.errorSummary);
});

test('non-session Gradio error remains a failed generation and preserves its error summary',async t=>{
  const s=await setup(t),job='e'.repeat(32),stateDir=path.join(s.taskRoot,'artwork/backend');let calls=0;
  const wire='event: heartbeat\r\ndata: null\r\n\r\nevent: error\r\ndata: null\r\n\r\n';
  const b=createSeeThroughBackend({stateDir,request:async url=>{calls++;url=String(url);if(url.endsWith('/upload'))return response(200,['/tmp/a.png']);if(url.endsWith('/call/inference'))return response(200,{event_id:job});return response(200,wire);}});
  await b.submit(backendRequest());const r=await b.query(job);assert.equal(r.status,'failed');assert.equal(r.code,'BACKEND_GENERATION_FAILED');assert.match(r.note,/server-side error details were not exposed/);
  const saved=JSON.parse(await fs.readFile(path.join(stateDir,`${sha256('test-op')}.json`)));
  assert.equal(saved.errorSummary,'null');assert.equal(saved.sseReceipt.httpStatus,200);assert.equal(saved.sseReceipt.event,'error');assert.equal(saved.sseReceipt.data,'null');assert.ok(saved.sseReceipt.receivedAt);
  const captured=await fs.readFile(path.join(stateDir,saved.sseReceipt.path));assert.equal(captured.toString(),wire);assert.equal(saved.sseReceipt.sha256,sha256(captured));assert.equal(saved.sseReceipt.bytes,Buffer.byteLength(wire));
  const recovered=await b.recover({operationKey:'test-op'});assert.equal(recovered.status,'failed');assert.equal(recovered.note,r.note);assert.equal(calls,3);
});

test('production HTTPS transport uses socket idle timeout, preserving active SSE beyond request duration',async t=>{
  const {directRequest}=await import('../src/artwork/see-through.mjs');
  assert.equal(typeof directRequest,'function');let options,timeout,expire,destroyed;
  const req=new EventEmitter();req.setTimeout=(ms,callback)=>{timeout=ms;expire=callback;return req;};req.destroy=error=>{destroyed=error;req.emit('error',error);};
  t.mock.method(https,'request',(url,opts,callback)=>{options=opts;req.end=()=>callback({statusCode:200});return req;});
  const controller=new AbortController();await directRequest('https://fixture.invalid/events',{signal:controller.signal,timeoutMs:45000});
  assert.equal(options.signal,controller.signal);assert.equal(timeout,45000);assert.equal(destroyed,undefined);
  expire();assert.match(destroyed.message,/IDLE_TIMEOUT/);
});

test('one layer with many semantic labels cannot impersonate independent eye and mouth pixels',async t=>{
  const s=await setup(t),r=coarse();r.parts[0].tags=['face','neck','hair','front','back','eye','white','iris','lash','upper','lower','left','brow','mouth','open','line'];
  const b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(r)});assert.equal(b.status,'blocked');assert.ok(b.checks.some(c=>c.name==='independent-deformation-materials'&&c.status==='failed'));
});
test('difference is an actual diagnostic raster and never an identity acceptance score',async t=>{
  const s=await setup(t),b=await buildArtwork(s.input,{...s.ctx,artworkBackend:fake(coarse())}),m=JSON.parse(await fs.readFile(path.join(s.taskRoot,b.artworkManifestPath)));
  const diff=decodePng(await fs.readFile(path.join(s.taskRoot,m.previews.difference)));assert.equal(diff.width,2);assert.equal(diff.height,2);assert.ok(diff.data.some(v=>v!==0));assert.equal(m.previews.comparison.mappingVerified,false);assert.ok(b.checks.some(c=>c.name==='identity-preservation'&&c.status==='not_run'));
});
test('cancelled operation does not submit any external work',async t=>{
  const s=await setup(t),controller=new AbortController();controller.abort(new Error('test-cancel'));let calls=0;await assert.rejects(()=>buildArtwork(s.input,{...s.ctx,signal:controller.signal,artworkBackend:{...fake(coarse()),submit:async()=>{calls++;}}}),/test-cancel/);assert.equal(calls,0);
});
test('download origin and cached PSD tampering are refused without remote resubmission',async t=>{
  const s=await setup(t),job='c'.repeat(32);let downloads=0;const stateDir=path.join(s.taskRoot,'artwork/backend');
  const backend=createSeeThroughBackend({stateDir,request:async url=>{url=String(url);if(url.endsWith('/upload'))return response(200,['/tmp/a.png']);if(url.endsWith('/call/inference'))return response(200,{event_id:job});if(url.endsWith(job))return response(200,'event: complete\ndata: [{"path":"/tmp/b.psd","url":"https://other.example/out.psd"},[]]\n\n');downloads++;throw new Error('must not download');}});
  await backend.submit(backendRequest());assert.equal((await backend.query(job)).code,'BACKEND_FILE_ORIGIN_INVALID');assert.equal(downloads,0);
  // A separate operation has a valid persisted PSD receipt, then a changed cache.
  const second=createSeeThroughBackend({stateDir:path.join(stateDir,'second'),request:async url=>{url=String(url);if(url.endsWith('/upload'))return response(200,['/tmp/a.png']);if(url.endsWith('/call/inference'))return response(200,{event_id:job});if(url.endsWith(job))return response(200,'event: complete\ndata: [{"path":"/tmp/b.psd"},[]]\n\n');return response(200,psdFixture());}});
  await second.submit(backendRequest());assert.equal((await second.query(job)).status,'completed');await fs.writeFile(path.join(stateDir,'second',`${sha256('test-op')}.psd`),'tampered');assert.equal((await second.recover({operationKey:'test-op'})).code,'BACKEND_CACHE_CHANGED');
});

test('completed Flash pixels survive local artwork repairs; unchanged structural failures are not regenerated',async t=>{
  const {input,ctx,taskRoot}=await setup(t);let submitted=0,queried=0;
  const source={width:60,height:60,data:Buffer.alloc(60*60*4)};
  for(let y=0;y<60;y++)for(let x=0;x<60;x++)source.data.set([(x*32+y*17)%211,(x*33+y*25)%243,(y*17+x*19)%241,255],(y*60+x)*4);
  const png=encodePng(source);await fs.writeFile(path.join(taskRoot,input.sourceImage.path),png);
  Object.assign(input.sourceImage,{width:60,height:60,sha256:sha256(png)});input.inputSha256=sha256(png);
  const part={id:'fixture-neck',providerLabel:'neck',png:encodePng(cropPng(source,{left:25,top:12,width:12,height:10}))};
  const result=()=>({status:'completed',jobId:'fixture-remote',result:{canvas:{width:60,height:60},parts:[part]}});
  const backend={id:'runninghub-standard-flash',version:'fixture',modelVersion:'fixture',submit:async()=>{submitted++;return result();},query:async id=>{assert.equal(id,'fixture-remote');queried++;return result();}};
  const run=()=>buildArtwork(input,{...ctx,artworkBackend:backend});
  const first=await run();assert.equal(first.unresolved.at(-1).code,'ARTWORK_QUALITY_FAILED');
  const stageFile=path.join(taskRoot,'artwork/stage.json');
  first.processorSha256='pre-fix';const oldBytes=Buffer.from(JSON.stringify(first));await fs.writeFile(stageFile,oldBytes);
  const repaired=await run();assert.equal(repaired.priorAssemblySha256,sha256(oldBytes));
  const saved=path.join(taskRoot,'artwork/repair-history',sha256(oldBytes));
  assert.deepEqual(await fs.readFile(path.join(saved,'stage.json')),oldBytes);
  const again=await run();assert.equal(again.processorSha256,repaired.processorSha256);
  assert.deepEqual([submitted,queried],[1,1]);
});

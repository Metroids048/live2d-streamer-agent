import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir,writeFile,readFile,rm,realpath,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {sha256} from '../src/artwork/files.mjs';
import {flashRequestFromQuote,createRunningHubLayeredBackend} from '../src/artwork/runninghub-layered.mjs';
import {prepareFlashIntake,approveFlashCommand,validateUploadedFlashQuote} from '../src/pipeline/flash-intake.mjs';
import {encodePng} from '../src/artwork/png.mjs';
import {registerHooks} from 'node:module';
import {runImagePipeline} from '../src/pipeline/index.mjs';
import {Store} from '../src/store.mjs';

const session={isAuthorizedSender:true,gatewayClientScopes:['operator.approvals'],sessionId:'s',sessionKey:'agent:live2d-streamer:local'};
const cdn='https://rh-images.xiaoyaoyou.com/controlled/source.png?sign=test-only-x';
const png=encodePng({width:1,height:1,data:Buffer.from([3,5,7,255])});
const origin='https://www.runninghub.cn',route='/openapi/v2/seedream-v5-flash/layer-decomposition';
const reply=(data,status=200)=>({status,body:[Buffer.from(JSON.stringify(data))]});
async function setup(t,options={}) {
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'avatar-flash-')));t.after(()=>rm(root,{recursive:true,force:true}));
  const id=randomUUID(),output=path.join(root,'outputs',id);
  await mkdir(path.join(output,'intake'),{recursive:true});
  const job={id,candidateId:randomUUID(),revision:1,output,status:'blocked'};
  const input={taskId:id,candidateId:job.candidateId,revision:1,status:'completed',rights:{allowDerivatives:true},
    inputSha256:sha256('original jpeg bytes'),sourceImage:{path:'intake/normalized.png',mimeType:'image/png',sha256:sha256(png)},
    descriptionSha256:sha256('new image, wave, chest bow'),brief:{intent:{actions:[{id:'wave'}],clothingVariants:[{id:'chest_bow'}]}}};
  await writeFile(path.join(output,'intake/normalized.png'),png);await writeFile(path.join(output,'intake/stage.json'),JSON.stringify(input));
  const calls=[],maker={root,store:{read:async key=>key==='make-'+id?job:undefined},
    making:async(s,ctx)=>{assert.equal(s,id);assert.equal(ctx.sessionKey,session.sessionKey);assert.equal(ctx.sessionId,session.sessionId);},
    run:async(action,args)=>{assert.equal(action,'make');assert.equal(args.resume_job_id,id);return {ok:true,status:'queued'};}};
  const request=async(url,opts)=>{
    calls.push({url,opts});assert.equal(opts.headers.Authorization,'Bearer offline-fixture');assert.equal(opts.method,'POST');
    if(url===origin+'/openapi/v2/media/upload/binary'){
      assert.ok(opts.body.includes(png));assert.ok(opts.headers['Content-Type'].startsWith('multipart/form-data;'));
      if(options.dropUpload)throw new Error('connection closed');
      return reply({code:0,data:{type:'image',size:png.length,download_url:options.url??cdn,fileName:'source.png'}});
    }
    assert.equal(url,origin+'/openapi/v2/price-preview/seedream-v5-flash/layer-decomposition');
    const body=JSON.parse(opts.body);assert.equal(body.imageUrl,cdn);assert.match(body.prompt,/袖口/);assert.match(body.prompt,/蝴蝶结/);
    if(options.denyPrice)return reply({error:'denied'},403);
    if(options.dropPrice)throw new Error('unobserved');
    return reply({errorCode:'',currency:'CNY',estimatedPrice:0.12,priceText:'每张 ¥0.12/张',...options.quote});
  };
  const base={root,job,input,request,apiKey:'offline-fixture',policy:{allowUploadForQuote:true}};
  const run=async(extra={})=>{const result=await prepareFlashIntake({...base,...extra});job.error=result.blocked;return result;};
  const command=(kind,quote='',ctx=session)=>approveFlashCommand(maker,{...ctx,args:id+(quote?' '+quote:'')},kind);
  async function consent(){assert.equal((await run()).blocked.code,'FLASH_UPLOAD_CONSENT_REQUIRED');assert.equal((await command('upload')).continueAgent,true);}
  return {job,root,input,calls,base,run,command,consent};
}
test('different native character: scoped transfer, priced bytes and owner-approved single inference',async t=>{
  const f=await setup(t);
  const first=await f.run();assert.equal(first.blocked.code,'FLASH_UPLOAD_CONSENT_REQUIRED');assert.equal(f.calls.length,0);
  assert.equal((await f.command('upload','',{...session,sessionId:'other'})).continueAgent,undefined);
  assert.equal((await f.command('upload','',{...session,isAuthorizedSender:false})).continueAgent,undefined);
  await f.consent();assert.equal((await f.run({apiKey:undefined})).blocked.code,'BACKEND_AUTH_REQUIRED');
  const pending=await f.run(),q=pending.blocked.quote;
  assert.equal(pending.blocked.code,'FLASH_QUOTE_APPROVAL_REQUIRED');assert.equal(q.unitFen,12);assert.equal(q.estimatedTotalFen,204);
  assert.ok(pending.blocked.message.includes('/avatarpay '+f.job.id+' '+q.quoteId));assert.equal(q.providerHardCapVerified,false);
  assert.doesNotMatch(JSON.stringify(pending),/https:|test-only-x|offline-fixture/);
  assert.equal((await f.command('pay','0'.repeat(64))).continueAgent,undefined);
  assert.equal((await f.command('pay',q.quoteId,{...session,senderIsOwner:true,gatewayClientScopes:['operator.read']})).continueAgent,undefined);
  assert.equal((await f.run()).blocked.code,'FLASH_QUOTE_APPROVAL_REQUIRED');
  assert.equal((await f.command('pay',q.quoteId)).continueAgent,true);
  const ready=await f.run();assert.equal(ready.budgetAuthorized,true);assert.equal(f.calls.length,2);
  const recipe=flashRequestFromQuote(ready.flashQuote,f.input.inputSha256);
  assert.equal(recipe.uploadedSha256,sha256(png));assert.notEqual(recipe.uploadedSha256,recipe.inputSha256);
  assert.deepEqual(Buffer.from(JSON.stringify(recipe.body)),f.calls[1].opts.body);
  assert.throws(()=>validateUploadedFlashQuote({...ready.flashQuote,estimatedPrice:0.01},f.input.inputSha256));
  const resumed=await f.run({policy:{maxUnitFen:1},operation:{jobId:'8811223344'}});
  assert.equal(resumed.budgetAuthorized,false);assert.deepEqual(resumed.flashQuote,ready.flashQuote);assert.equal(f.calls.length,2);
  const projectFiles=await readdir(f.job.output,{recursive:true,withFileTypes:true});
  for(const file of projectFiles.filter(x=>x.isFile()))assert.doesNotMatch((await readFile(path.join(file.parentPath,file.name))).toString('latin1'),/test-only-x|offline-fixture/);
  const wire=[];
  const backend=createRunningHubLayeredBackend({stateDir:path.join(f.job.output,'artwork/backend'),apiKey:'offline-fixture',flashQuote:ready.flashQuote,budgetAuthorized:true,
    request:async(url,opts)=>{wire.push({url,opts});if(url===cdn){assert.equal(opts.headers.Authorization,undefined);return {status:200,body:[png]};}
      assert.equal(url,origin+route);assert.deepEqual(opts.body,f.calls[1].opts.body);return reply({taskId:'12345678901',status:'RUNNING',errorCode:''});}});
  const started=await backend.submit({operationKey:'local-one',cacheKey:'local-cache',inputSha256:f.input.inputSha256,rights:f.input.rights,source:{mimeType:'image/png',bytes:png,width:1,height:1,sha256:sha256(png)}});
  assert.equal(started.jobId,'12345678901');assert.equal(wire.length,2);
});
test('local policy limit, unknown price basis, old job, modified source and unknown POST never grant or silently re-submit',async t=>{
  const f=await setup(t);
  assert.equal((await f.run({operation:{status:'unknown'}})).blocked.code,'FLASH_ORIGINAL_RECEIPT_REQUIRED');
  assert.equal((await f.run({policy:{}})).blocked.code,'FLASH_UPLOAD_POLICY_REQUIRED');
  await f.consent();const result=await f.run({policy:{allowUploadForQuote:true,maxEstimatedTotalFen:203}});
  assert.equal(result.blocked.code,'FLASH_PRICE_OUT_OF_POLICY');assert.equal(result.blocked.quote.estimatedTotalFen,204);
  assert.equal((await f.command('pay',result.blocked.quote.quoteId)).continueAgent,undefined);assert.equal(f.calls.length,2);
  const changed=await f.run({input:{...f.input,descriptionSha256:'a'.repeat(64)}});assert.equal(changed.blocked.code,'FLASH_QUOTE_MISMATCH');assert.equal(f.calls.length,2);
  for(const opt of [{dropUpload:true},{dropPrice:true},{url:'https://untrusted.example/image.png'}]){
    const broken=await setup(t,opt);await broken.consent();
    const result=await broken.run();assert.match(result.blocked.code,/^FLASH_(?:UPLOAD|PRICE)_RECEIPT_UNKNOWN$/);
    const posts=broken.calls.length;assert.equal((await broken.run()).blocked.code,result.blocked.code);assert.equal(broken.calls.length,posts);
  }
  const unknown=await setup(t,{quote:{priceText:'按秒计价'}});await unknown.consent();
  assert.equal((await unknown.run()).blocked.quote.billingUnit,'unverified');
  const altered=await setup(t);await altered.consent();await writeFile(path.join(altered.job.output,'intake/normalized.png'),Buffer.alloc(10));
  assert.equal((await altered.run()).blocked.code,'FLASH_INPUT_MISMATCH');assert.equal(altered.calls.length,0);
});
test('confirmed credential refusal allows a newly authorized price check; keeps original successful upload',async t=>{
  const opt={denyPrice:true},f=await setup(t,opt);
  await f.consent();const denied=await f.run();assert.equal(denied.blocked.code,'FLASH_BACKEND_ACCESS_DENIED');
  assert.match(denied.blocked.message,/HTTP 403/);assert.equal(f.calls.length,2);
  opt.denyPrice=false;assert.equal((await f.run()).blocked.code,'FLASH_BACKEND_ACCESS_DENIED');assert.equal(f.calls.length,2);
  await f.command('upload');assert.equal((await f.run()).blocked.code,'FLASH_QUOTE_APPROVAL_REQUIRED');
  assert.equal(f.calls.length,3);assert.equal(f.calls.filter(x=>x.url.endsWith('/upload/binary')).length,1);
});
test('gateway registers approval as a scoped user command, absent from model tools',async()=>{
  const sdk='data:text/javascript,'+encodeURIComponent('export const definePluginEntry=v=>v,saveMediaBuffer=()=>{},readMediaBuffer=()=>{},resolveMediaBufferPath=()=>{},readSessionTranscriptEvents=()=>{},appendAssistantMirrorMessageByIdentity=()=>{};');
  const hooks=registerHooks({resolve(id,ctx,next){return id.startsWith('openclaw/plugin-sdk/')?{url:sdk,shortCircuit:true}:next(id,ctx);}});
  let plugin;try {({default:plugin}=await import('../openclaw-plugin/index.mjs'));}finally{hooks.deregister();}
  const commands=[],names=[],services=[];
  plugin.register({on(){},registerService(service){services.push(service.id);},registerCommand(c){commands.push(c);},registerTool(factory){names.push(...factory({agentId:'live2d-streamer'}).map(t=>t.name));}});
  assert.deepEqual(services,['live2d-automatic-delivery']);
  const pay=commands.find(c=>c.name==='avatarpay');assert.deepEqual(pay.requiredScopes,['operator.approvals']);assert.equal(pay.requireAuth,true);
  assert.ok(commands.find(c=>c.name==='avatarupload').requireAuth);assert.ok(!names.some(n=>/pay|upload|approve/.test(n)));
});
test('production coordinator does not reuse a different candidate’s Hachi payment or wave permission',async t=>{
  const f=await setup(t),store=new Store(f.root);f.job.steps=[];
  const other={taskId:randomUUID(),candidateId:randomUUID(),revision:1,codexWaveEdit:true};
  let artworkCalls=0;
  const deps={root:f.root,store,vision:{},prepare:async()=>f.input,artworkRequest:f.base.request,
    artworkCredentials:{runninghub:'offline-fixture'},artworkPolicy:{enabled:true,provider:'runninghub',route:'seedream-v5-flash/layer-decomposition',
      flashAuthorization:other,budgetAuthorized:true,flashIntake:{allowUploadForQuote:true}},
    artwork:async(input,ctx)=>{artworkCalls++;assert.equal(ctx.waveAuthorization,undefined);assert.equal(ctx.artworkBackend.id,'runninghub-standard-flash');
      return {status:'blocked',unresolved:[{code:'FIXTURE_STOP',message:'Offline wiring fixture.'}]};}};
  const run=()=>runImagePipeline(f.job,deps);
  await run();assert.equal(f.job.error.code,'FLASH_UPLOAD_CONSENT_REQUIRED');assert.equal(f.calls.length,0);
  await f.command('upload');await run();assert.equal(f.job.error.code,'FLASH_QUOTE_APPROVAL_REQUIRED');assert.equal(artworkCalls,0);
  await f.command('pay',f.job.error.quote.quoteId);await run();assert.equal(artworkCalls,1);assert.equal(f.calls.length,2);
  const job=await store.read('make-'+f.job.id);assert.doesNotMatch(JSON.stringify(job),/test-only-x|offline-fixture/);
});

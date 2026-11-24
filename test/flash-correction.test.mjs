import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {readJson,sha256,writeBound,writeJson} from '../src/artwork/files.mjs';
import {encodePng} from '../src/artwork/png.mjs';
import {runImagePipeline} from '../src/pipeline/index.mjs';
import {Maker} from '../src/maker.mjs';
import {inspectFlashCorrection,canResumeFailedFlash,correctionOperation} from '../src/pipeline/flash-correction.mjs';

const png=encodePng({width:2,height:1,data:Buffer.from([2,4,5,128,8,9,1,255])}),raw=Buffer.from('original attachment before normalization');
const publicUrl='https://example.org/authorized.png',cdn='https://rh-images.xiaoyaoyou.com/source.png?signature=private-fixture';
const oldId='11111111111111',newId='22222222222222',route='seedream-v5-flash/layer-decomposition';
async function fixture(t,{rate=.11,drop=true}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(tmpdir(),'flash-correction-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const maker=new Maker(root),session={sessionId:'offline',sessionKey:'agent:live2d-streamer:test'},id=randomUUID(),output=path.join(root,'outputs',id);
  const job={id,kind:'single_image',candidateId:randomUUID(),revision:1,output,session:maker.store.session(session),steps:[]};await fs.mkdir(output,{recursive:true});
  const input={schemaVersion:1,stage:'intake',status:'completed',taskId:id,candidateId:job.candidateId,revision:1,parentRevision:null,inputSha256:sha256(raw),
    descriptionSha256:sha256('wave and same person'),sourceImage:{path:'intake/normalized.png',sha256:sha256(png),width:2,height:1,mimeType:'image/png'},
    brief:{intent:{eyes:{blink:true},mouth:{speech:true}}},rights:{allowDerivatives:true},artifacts:[],checks:[],warnings:[],unresolved:[]};
  const params={imageUrl:publicUrl,prompt:'保持同一分层配方',resolution:'auto',outputFormat:'png'};
  const quote={host:'www.runninghub.cn',path:'/openapi/v2/price-preview/'+route,httpStatus:200,errorCode:'',currency:'CNY',estimatedPrice:.11,inputSha256:input.inputSha256,params,paramsSha256:sha256(JSON.stringify(params))};
  await writeBound(output,input.sourceImage.path,png);await writeJson(output,'intake/stage.json',input);
  await writeJson(root,'config/quote.json',quote);
  const auth={taskId:id,candidateId:job.candidateId,revision:1,codexWaveEdit:true,quotePath:'config/quote.json'};
  const policy={provider:'runninghub',enabled:true,budgetAuthorized:true,route,flashAuthorization:auth,pollIntervalMs:1000,maxWaitMs:10000};
  const calls={old:0,corrected:0,upload:0,price:0,query:0},reply=data=>({status:200,body:[Buffer.isBuffer(data)?data:Buffer.from(JSON.stringify(data))]});
  const request=async(url,opts)=>{
    if(url===publicUrl)return reply(raw);
    if(url===cdn){assert.equal(opts.headers.Authorization,undefined);return reply(png);}
    if(url.endsWith('/binary')){calls.upload++;assert.ok(opts.body.includes(png));return reply({code:0,data:{type:'image',size:png.length,download_url:cdn}});}
    if(url.includes('/price-preview/')){calls.price++;assert.deepEqual(JSON.parse(opts.body),{...params,imageUrl:cdn});return reply({errorCode:'',currency:'CNY',estimatedPrice:rate,priceText:'每张 ¥'+rate+'/张'});}
    if(url.endsWith('/query')){calls.query++;const j=JSON.parse(opts.body).taskId;return reply({taskId:j,status:'FAILED',errorCode:'1013',errorMessage:'File download timed out',results:[],usage:{consumeMoney:null}});}
    assert.ok(url.endsWith('/'+route));
    if(JSON.parse(opts.body).imageUrl===publicUrl){calls.old++;return reply({taskId:oldId,status:'QUEUED',errorCode:''});}
    assert.deepEqual(JSON.parse(opts.body),{...params,imageUrl:cdn});calls.corrected++;if(drop)throw Error('lost before response');return reply({taskId:newId,status:'QUEUED',errorCode:''});
  };
  const run=()=>runImagePipeline(job,{root,store:maker.store,vision:{},prepare:async()=>input,artworkPolicy:policy,artworkCredentials:{runninghub:'offline-key'},artworkRequest:request});
  await run();assert.equal(job.status,'failed');
  const op=await readJson(output,'artwork/operation.json'),receipt='artwork/backend/'+sha256(op.operationKey)+'.json';
  const permit={failedJobId:op.jobId,failedOperationKey:op.operationKey,allowUpload:true,maxUnitFen:11,maxOutputImages:17,maxEstimatedTotalFen:187};
  auth.uploadCorrection=permit;await writeJson(root,'config/project.json',{singleImage:{artwork:policy}});
  return {root,job,input,output,op,receipt,permit,policy,calls,maker,session,run};
}
test('native same-session correction archives public failure and submits one freshly re-priced upload; unknown never posts again',async t=>{
  const f=await fixture(t),original=await readJson(f.output,f.receipt),marker=f.receipt.replace('.json','-inference.json'),claim=await readJson(f.output,marker);
  assert.equal(await canResumeFailedFlash(f.root,f.job),true);
  let launches=0;f.maker.launch=async()=>{launches++;};
  assert.equal((await f.maker.run('make',{resume_job_id:f.job.id},{...f.session,sessionId:'else'})).code,'SESSION_MISMATCH');
  const resumed=await f.maker.run('make',{resume_job_id:f.job.id},f.session);assert.equal(resumed.status,'queued');assert.equal(launches,1);
  await f.run();assert.equal(f.job.error.code,'EXTERNAL_RESULT_UNKNOWN');
  await f.run();assert.equal(f.job.error.code,'EXTERNAL_RESULT_UNKNOWN');assert.deepEqual(f.calls,{old:1,corrected:1,upload:1,price:1,query:1});
  const corrected=await readJson(f.output,correctionOperation);assert.notEqual(corrected.operationKey,f.op.operationKey);assert.equal(corrected.inputSha256,f.op.inputSha256);
  assert.deepEqual(await readJson(f.output,'artwork/operation.json'),f.op);assert.deepEqual(await readJson(f.output,marker),claim);assert.deepEqual(await readJson(f.output,f.receipt),original);
  assert.equal((await readJson(f.output,'artwork/failed-public-flash-stage.json')).status,'failed');
  assert.doesNotMatch(JSON.stringify(f.job),/private-fixture|offline-key/);
});
test('only a matching terminal public URL timeout with no output permits correction; excessive rate never starts a paid attempt',async t=>{
  const f=await fixture(t,{rate:.12}),proof=()=>inspectFlashCorrection({root:f.root,job:f.job,input:f.input,policy:f.policy});
  assert.ok(await proof());const record=await readJson(f.output,f.receipt);
  for(const patch of [{providerStatus:'RUNNING'},{jobId:newId},{downloads:[{path:'x'}]},{queryReceipt:{...record.queryReceipt,errorCode:'1012'}}]) {
    await writeJson(f.output,f.receipt,{...record,...patch});assert.equal(await proof(),null);
  }
  await writeJson(f.output,f.receipt,record);
  const cached=f.receipt.replace('.json','-layer-1.png');await writeBound(f.output,cached,png);assert.equal(await proof(),null);await fs.unlink(path.join(f.output,cached));
  for(const patch of [{failedJobId:newId},{allowUpload:false},{maxOutputImages:18},{maxUnitFen:12},{maxEstimatedTotalFen:190}]){
    f.policy.flashAuthorization.uploadCorrection={...f.permit,...patch};assert.equal(await proof(),null);
  }
  f.policy.flashAuthorization.uploadCorrection=f.permit;await f.run();await f.run();assert.equal(f.job.error.code,'FLASH_PRICE_OUT_OF_POLICY');
  assert.equal(f.job.error.quote.estimatedTotalFen,204);assert.equal(await readJson(f.output,correctionOperation),null);
  assert.deepEqual(f.calls,{old:1,corrected:0,upload:1,price:1,query:1});
});
test('a second confirmed 1013 after correction is terminal and no third submission can be scheduled',async t=>{
  const f=await fixture(t,{drop:false});await f.run();assert.equal(f.job.status,'failed');
  const op=await readJson(f.output,correctionOperation);assert.equal(op.jobId,newId);assert.equal(op.status,'failed');
  assert.equal(await canResumeFailedFlash(f.root,f.job),false);f.maker.launch=()=>{throw Error('must keep terminal');};
  assert.equal((await f.maker.resume(f.job.id,f.session)).status,'failed');
  await f.run();assert.deepEqual(f.calls,{old:1,corrected:1,upload:1,price:1,query:2});
});

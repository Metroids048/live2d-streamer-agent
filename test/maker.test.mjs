import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Psd2Live} from '../src/psd2live.mjs';
import {Maker} from '../src/maker.mjs';
import {ImageInbox} from '../src/pipeline/attachments.mjs';
import {nativeIntakeRequest} from '../src/pipeline/native-intake.mjs';

async function root(t) {
  const p=await fs.mkdtemp(path.join(os.tmpdir(),'live2d-maker-'));t.after(()=>fs.rm(p,{recursive:true,force:true}));
  await fs.mkdir(path.join(p,'.local'));await fs.mkdir(path.join(p,'config'));
  await fs.writeFile(path.join(p,'.local/psd2live-token'),'test-only');return p;
}
test('background jobs are waited for without resubmitting the edit',async t=>{
  const p=await root(t),calls=[];let waits=0;
  const client=new Psd2Live(p,{fetcher:async(url,options)=>{
    const m=JSON.parse(options.body);calls.push(m);
    if(m.method==='notifications/initialized') return new Response(null,{status:202});
    let result={protocolVersion:'2025-03-26'};
    if(m.method==='tools/call') {
      assert.equal('wait_ms' in m.params.arguments,false,'queries must not send the background-only wait option');
      const op=m.params.arguments.operation;
      const data=op==='rig_generate'?{id:'job-1',terminal:false,status:'running'}:
        (++waits===1?{id:'job-1',terminal:false,status:'running'}:{id:'job-1',terminal:true,status:'completed',result:{state:'new-state'}});
      result={structuredContent:{ok:true,data}};
    }
    return new Response(JSON.stringify({jsonrpc:'2.0',id:m.id,result}),{headers:{'Content-Type':'application/json','Mcp-Session-Id':'test-session'}});
  }});
  const jobs=[];assert.deepEqual((await client.call('rig_generate',{state:'old'},{onJob:j=>jobs.push(j.id)})).data,{state:'new-state'});
  assert.deepEqual(jobs,['job-1']);assert.equal(waits,2);
  assert.equal(calls.filter(m=>m.params?.arguments?.operation==='rig_generate').length,1);
});
test('unknown mutation outcome is surfaced and never retried',async t=>{
  const p=await root(t);let mutations=0;
  const client=new Psd2Live(p,{fetcher:async(url,options)=>{
    const m=JSON.parse(options.body);
    if(m.method==='notifications/initialized')return new Response(null,{status:202});
    if(m.method==='tools/call'){mutations++;throw new Error('socket closed');}
    return new Response(JSON.stringify({id:m.id,result:{}}),{headers:{'Content-Type':'application/json','Mcp-Session-Id':'test-session'}});
  }});
  await assert.rejects(client.call('expression_put',{state:'s'}),{code:'MAKER_CONNECTION_UNKNOWN'});assert.equal(mutations,1);
});
test('raster export publishes its job before an unreadable native job_wait response',async()=>{
  const client=new Psd2Live('/unused'),calls=[],jobs=[];
  client.rpc=async(method,{arguments:args})=>{
    calls.push(args.operation);
    if(args.operation==='project_export_target'){
      assert.equal(args.wait_ms,0);
      return {structuredContent:{ok:true,data:{id:'job-video',terminal:false,status:'running'}}};
    }
    assert.equal(args.operation,'job_wait');assert.equal(args.wait_ms,undefined);
    assert.deepEqual(jobs,['job-video']);assert.equal(args.request.id,'job-video');
    return {isError:true,structuredContent:{ok:false,error:{message:'Operation job_wait returned an invalid result'}}};
  };
  await assert.rejects(client.call('project_export_target',{},{onJob:j=>jobs.push(j.id)}),
    e=>e.details.operation==='job_wait');
  assert.deepEqual(calls,['project_export_target','job_wait']);
});
test('lost response body leaves the submitted operation unknown',async t=>{
  const p=await root(t);let edits=0;
  const client=new Psd2Live(p,{fetcher:async(url,options)=>{
    const m=JSON.parse(options.body);
    if(m.method==='notifications/initialized')return new Response(null,{status:202});
    if(m.method==='tools/call') {
      edits++;return {ok:true,headers:new Headers(),text:async()=>{throw new Error('body interrupted');}};
    }
    return new Response(JSON.stringify({id:m.id,result:{}}),{headers:{'Content-Type':'application/json'}});
  }});
  await assert.rejects(client.call('project_export_model',{state:'s'}),{code:'MAKER_CONNECTION_UNKNOWN'});
  assert.equal(edits,1);
});
test('catalog inspection does not start the engine; changed source is refused',async t=>{
  const p=await root(t),source=path.join(p,'sample.psd');await fs.writeFile(source,'original');
  await fs.writeFile(path.join(p,'config/materials.json'),JSON.stringify({materials:[{id:'m',file:'sample.psd',sha256:createHash('sha256').update('original').digest('hex'),licenseReviewed:true}]}));
  const maker=new Maker(p);const before=await fs.readdir(path.join(p,'.local'));
  assert.equal((await maker.materials()).materials[0].valid,true);
  assert.deepEqual(await fs.readdir(path.join(p,'.local')),before);
  await fs.writeFile(source,'changed');
  assert.equal((await maker.run('make',{material_id:'m'},{sessionKey:'test',callId:'one'})).code,'MATERIAL_NOT_APPROVED');
  assert.equal((await fs.readdir(path.join(p,'.local'))).some(n=>n.startsWith('make-')),false);
});
test('native review validation preserves actionable field errors',async t=>{
  const p=await root(t),maker=new Maker(p);
  maker.resume=async()=>{throw Object.assign(new Error('observations[0].to 必须大于 from'),{
    code:'RIG_REVIEW_INVALID',details:{invalidFields:[{path:'observations[0].to',rule:'positive_interval'}]}});};
  const result=await maker.run('make',{resume_job_id:'same-task'},{sessionKey:'test',callId:'review'});
  assert.equal(result.code,'RIG_REVIEW_INVALID');
  assert.equal(result.message,'observations[0].to 必须大于 from');
  assert.deepEqual(result.invalidFields,[{path:'observations[0].to',rule:'positive_interval'}]);
});
test('review_only is accepted only with a resumed task and actual visual review',async t=>{
  const p=await root(t),maker=new Maker(p),calls=[];
  maker.resume=async(...args)=>{calls.push(args);return {ok:true};};
  for(const params of [
    {material_id:'m',review_only:true},
    {resume_job_id:'same-task',review_only:true},
    {resume_job_id:'same-task',visual_review:{},review_only:'true'},
  ])assert.equal((await maker.run('make',params,{sessionKey:'test'})).code,'INPUT_INVALID');
  assert.equal(calls.length,0);
  assert.equal((await maker.run('make',{resume_job_id:'same-task',visual_review:{},review_only:true},{sessionKey:'test'})).ok,true);
  assert.equal(calls[0][3],true);
});
test('native single-image dispatch accepts null selectors and stores the attachment turn verbatim',async t=>{
  const p=await fs.realpath(await root(t)),maker=new Maker(p),inbox=new ImageInbox(p);
  const ctx={agentId:'live2d-streamer',sessionKey:'agent:live2d-streamer:test',sessionId:'test',callId:'native'};
  const message=[{role:'user',content:[{type:'image',mimeType:'image/png',data:Buffer.from('test image').toString('base64')}]}];
  const [image]=await inbox.capture(message,ctx,'转头和挥手。');
  await inbox.capture(message,ctx);
  maker.launch=async()=>{};
  const result=await maker.run('make',{image_ref:image.imageRef,description:'模型改写',rights:{source:'fixture'},material_id:null,
    resume_job_id:null,visual_review:null,review_only:false},ctx);
  assert.equal(result.ok,true);
  assert.equal(result.stage,'queued');
  assert.equal(result.inputSha256,image.sha256);
  assert.equal((await maker.store.read('make-'+result.jobId)).request.description,'转头和挥手。');
});
test('native fast receipt claims only an explicit request with one inline image in the owning dashboard session',()=>{
  const sessionKey='agent:live2d-streamer:dashboard:sample';
  const description='请把这张原创角色图做成 Live2D 虚拟主播。我允许本项目使用、修改并交付这张图。全程只在本机处理。';
  const ctx={AgentId:'live2d-streamer',Provider:'webchat',CommandTurn:{kind:'normal'},SessionKey:sessionKey,RawBody:description};
  const image={type:'image',mimeType:'image/png',data:'data'};
  const event={ctx,sessionKey,runId:'turn',images:[image],sendPolicy:'allow'};
  assert.deepEqual(nativeIntakeRequest(event),{image,description,sessionKey,callId:'native:turn'});
  for(const patch of [
    {sessionKey:sessionKey+'-foreign'}, {images:[image,image]}, {suppressUserDelivery:true},
    {ctx:{...ctx,MediaPaths:['offloaded-image']}},
    {ctx:{...ctx,RawBody:description.replace('请把','请先不要把')}},
    {ctx:{...ctx,RawBody:description.replace('虚拟主播。','虚拟主播？')}},
    {ctx:{...ctx,RawBody:description.replace('我允许','我不允许')}},
  ])assert.equal(nativeIntakeRequest({...event,...patch}),undefined);
});
test('automatic rigging recovery queues once after an owned terminal save failure',async t=>{
  const p=await fs.realpath(await root(t)),maker=new Maker(p),launches=[];
  maker.launch=async job=>launches.push(job);
  const id='job',ctx={sessionKey:'agent:live2d-streamer:dashboard:sample',sessionId:'sample'};
  const identity={taskId:id,candidateId:'candidate',revision:2,parentRevision:1,inputSha256:'source',descriptionSha256:'brief'};
  const output=path.join(p,'openclaw-workspace','outputs',id,'revisions','r0002');
  const rig=path.join(output,'rigging');await fs.mkdir(rig,{recursive:true});
  const error={code:'ENOSPC',message:'No space left on device'};
  const stage={...identity,stage:'rigging',status:'failed',unresolved:[error]};
  await fs.writeFile(path.join(rig,'stage.json'),JSON.stringify(stage));
  const failed={operation:'project_save_as',jobId:'job-save',projectId:'project',request:{state:'original:1:2'},error,
    terminalReceipt:{id:'job-save',terminal:true,status:'failed',project_id:'project',input_state:'foreign:1:2',
      error:{code:'io_error',message:error.message}}};
  const journal={identity,failed,projectId:failed.projectId,state:failed.request.state};
  const saveJournal=()=>fs.writeFile(path.join(rig,'state.json'),JSON.stringify(journal));
  await saveJournal();
  await maker.store.write('maker-active',{id});
  await maker.store.write('make-'+id,{id,kind:'single_image',candidateId:identity.candidateId,revision:2,parentRevision:1,
    stage:'rigging',status:'failed',notifyAutomatically:true,session:maker.store.session(ctx),sessionContext:ctx,output,error,
    source:{inputSha256:identity.inputSha256,descriptionSha256:identity.descriptionSha256},pipeline:{artwork:{local:{externalSubmitted:false}}}});
  await maker.recoverAutomaticReview();
  assert.equal(launches.length,0);
  failed.terminalReceipt.input_state=journal.state;await saveJournal();
  await maker.recoverAutomaticReview();await maker.recoverAutomaticReview();
  assert.equal(launches.length,1);
  assert.equal(launches[0].status,'queued');
  assert.deepEqual(launches[0].riggingStorageRecovery.previousError,error);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(output,launches[0].riggingStorageRecovery.receiptPath))),stage);
});
test('completed local artwork rejected by visual review releases dispatch without releasing unknown operations',async t=>{
  const output=await fs.realpath(await root(t)),maker=new Maker(output),dir=path.join(output,'artwork');
  await fs.mkdir(dir);
  const job={id:'first',candidateId:'candidate',revision:1,kind:'single_image',status:'blocked',stage:'artwork',output,
    error:{code:'ARTWORK_VISUAL_REVIEW_FAILED'},pipeline:{artwork:{local:{provider:'local-layer-layout',externalSubmitted:false,receiptStatus:'completed'}}}};
  await fs.writeFile(path.join(dir,'operation.json'),JSON.stringify({status:'completed',backend:{id:'local-layer-layout'}}));
  await fs.writeFile(path.join(dir,'stage.json'),JSON.stringify({taskId:job.id,candidateId:job.candidateId,revision:1,stage:'artwork',status:'blocked'}));
  assert.equal(await maker.mayYield(job),true);
  assert.equal(await maker.mayYield({...job,candidateId:'other'}),false);
  assert.equal(await maker.mayYield({...job,pending:{operation:'unknown'}}),false);
  assert.equal(await maker.mayYield({...job,pid:process.pid}),false);
  const rejected={...job,error:{code:'ARTWORK_QUALITY_FAILED'}};
  assert.equal(await maker.mayYield(rejected),false);
  await fs.writeFile(path.join(dir,'stage.json'),JSON.stringify({taskId:job.id,candidateId:job.candidateId,revision:1,stage:'artwork',status:'blocked',unresolved:[rejected.error]}));
  assert.equal(await maker.mayYield(rejected),true);
  assert.equal(await maker.mayYield({...rejected,pending:{operation:'unknown'}}),false);
  await maker.store.write('engine-lease',{id:'other-job'});
  assert.equal(await maker.mayYield(job),false);
});
test('a proven local wave mesh collapse releases dispatch without overwriting the failed candidate',async t=>{
  const output=await fs.realpath(await root(t)),maker=new Maker(output),dir=path.join(output,'rigging');
  await fs.mkdir(dir);
  const owner={taskId:'first',candidateId:'candidate',revision:1};
  const error={code:'CONTINUOUS_WAVE_TRIANGLE_COLLAPSE'};
  const job={id:owner.taskId,candidateId:owner.candidateId,revision:1,kind:'single_image',status:'blocked',stage:'rigging',output,error,
    pipeline:{artwork:{local:{provider:'local-layer-layout',externalSubmitted:false,receiptStatus:'completed'}}}};
  await fs.writeFile(path.join(dir,'stage.json'),JSON.stringify({...owner,stage:'rigging',status:'blocked'}));
  await fs.writeFile(path.join(dir,'state.json'),JSON.stringify({identity:owner,projectId:'project',state:'version',pending:null}));
  const failure=path.join(dir,'failure.json');
  await fs.writeFile(failure,JSON.stringify({...error,pending:{operation:'unknown'}}));
  assert.equal(await maker.mayYield(job),false);
  await fs.writeFile(failure,JSON.stringify({...error,pending:null}));
  assert.equal(await maker.mayYield(job),true);
  assert.equal(await maker.mayYield({...job,candidateId:'other'}),false);
  assert.deepEqual(JSON.parse(await fs.readFile(failure,'utf8')),{...error,pending:null});
});
test('a local dynamics recipe rejection releases dispatch only before any editor write',async t=>{
  const output=await fs.realpath(await root(t)),maker=new Maker(output),dir=path.join(output,'dynamics');
  await fs.mkdir(dir);
  const error={code:'DYNAMICS_EXPRESSION_INCOMPLETE'};
  const job={id:'first',candidateId:'candidate',revision:1,kind:'single_image',status:'blocked',stage:'dynamics',output,
    error,pipeline:{artwork:{local:{provider:'local-layer-layout',externalSubmitted:false,receiptStatus:'completed'}}}};
  const stage={taskId:job.id,candidateId:job.candidateId,revision:1,stage:'dynamics',status:'blocked',unresolved:[error]};
  await fs.writeFile(path.join(dir,'stage.json'),JSON.stringify(stage));
  await fs.writeFile(path.join(dir,'dynamics-manifest.json'),JSON.stringify({...stage,exportStatus:'not_run'}));
  assert.equal(await maker.mayYield(job),true);
  assert.equal(await maker.mayYield({...job,candidateId:'other'}),false);
  assert.equal(await maker.mayYield({...job,pending:{operation:'project_export_model'}}),false);
  await fs.writeFile(path.join(dir,'engine-journal.json'),'{}');
  assert.equal(await maker.mayYield(job),false);
});
test('a Dashboard request to send the finished files here enables background delivery',async t=>{
  const p=await fs.realpath(await root(t)),maker=new Maker(p),inbox=new ImageInbox(p);
  const ctx={agentId:'live2d-streamer',sessionKey:'agent:live2d-streamer:dashboard:fixture',sessionId:'test'};
  const description='把图做成半身虚拟主播。请在这里给我 VTubeLeaf 能直接导入的模型包和分层 PSD。';
  const message=[{role:'user',content:[{type:'image',mimeType:'image/png',data:Buffer.from('test image').toString('base64')}]}];
  const [image]=await inbox.capture(message,ctx,description);
  maker.launch=async()=>{};
  const result=await maker.makeImage({imageRef:image.imageRef,description:'模型改写',rights:{source:'fixture'}},ctx);
  const job=await maker.store.read('make-'+result.jobId);
  assert.equal(job.request.description,description);
  assert.equal(job.notifyAutomatically,true);
  assert.match(result.message,/后台会把结果发到本会话/);
});

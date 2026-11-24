import * as fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {acquireEngineLease} from '../src/pipeline/lease.mjs';
import {ROOT} from '../src/controller.mjs';
import {Store} from '../src/store.mjs';
import {Psd2Live} from '../src/psd2live.mjs';
import {Maker,alive,claimQueuedJob} from '../src/maker.mjs';
import {inspectModel,findModels} from '../src/model.mjs';
import {finishPreview,ffmpeg} from '../src/preview.mjs';
import {createStageEngine,PinnedPsd2Live} from '../src/pipeline/production-engine.mjs';
import {advanceModelPipeline} from '../src/pipeline/model-stages.mjs';
import {runImagePipeline} from '../src/pipeline/index.mjs';
import {runningHubCredential} from '../src/pipeline/runninghub-credential.mjs';
import {engineLocation} from '../src/pipeline/engine-location.mjs';
import {prepareRigRuntime} from '../src/pipeline/rig-runtime.mjs';
import {reopenEditable} from '../src/packaging/reopen-editor.mjs';
import {buildHdPreview} from '../src/packaging/hd-preview.mjs';
import {attachmentLimitForRevision} from '../src/packaging/distribution.mjs';

import {prepareReviewedRigRepair} from '../src/pipeline/reviewed-rig-repair.mjs';
import * as rigRecipe from '../src/rigging/recipe.mjs';

const id=process.argv[2];if(!/^[a-f0-9-]{36}$/.test(id??'')) throw new Error('Invalid job');
const store=new Store(ROOT),job=await claimQueuedJob(store,id);
if(!job)process.exit(0);
let location,runtime;
try {await prepareReviewedRigRepair(ROOT,job,rigRecipe.RIG_REPAIR_PROFILE);location=await engineLocation(ROOT,job);runtime=await prepareRigRuntime(ROOT,job,location);}
catch(e){job.status='blocked';job.error={code:e.code??'RIG_REPAIR_CHECKPOINT',message:e.message};await store.write('make-'+id,job);process.exit(1);}
const isolated=location.args.length>0;
const client=job.kind==='single_image'?new PinnedPsd2Live(ROOT,{connectionDir:location.dir}):new Psd2Live(ROOT);
const serviceStore=new Store(ROOT,location.dir);
const persist=()=>store.write('make-'+id,job);
const write=(name,data)=>fs.writeFile(path.join(job.output,name),JSON.stringify(data,null,2)+'\n');
const call=async(op,request={})=>(await client.call(op,request)).data;
let legacyLease;
async function step(name,operation,request={},withState=true) {
  if(withState) {
    const state=await call('workspace_inspect',{scope:'project'});
    request={...request,project_id:state.project_id,state:state.state};
    if(name==='import'&&(state.loaded!==false||state.busy!==false))throw Object.assign(new Error('专用编辑器已有工程或仍忙，未导入其他角色'),{code:'ENGINE_PROJECT_OCCUPIED'});
    if(job.projectId && state.project_id!==job.projectId) throw new Error('制作工作区已切到其他工程，停止写入');
  }
  request.request_id=id+'-'+name;
  job.stage=name;job.pending={operation,request};await persist();
  const pending={operation,requestId:request.request_id,jobId:null};await legacyLease.update({pending});
  let result;
  try {
    result=await client.call(operation,request,{onJob:async j=>{await legacyLease.update({pending:{...pending,jobId:j.id}});job.pending.jobId=j.id;await persist();}});
  }catch(e){if(['MAKER_REJECTED','MAKER_JOB_FAILED'].includes(e.code))await legacyLease.update({pending:null});throw e;}
  await legacyLease.update({pending:null});
  job.steps.push({name,operation,result:result.data,finishedAt:new Date().toISOString()});delete job.pending;await persist();
  await write('制作过程.json',job.steps);return result;
}
async function ensureEngine({recoverOnly=false}={}) {
  async function available(){
    if(isolated){
      const state=await serviceStore.read('psd2live-service');
      if(!state)return false;
      if(state.taskId!==id||state.candidateId!==job.candidateId||state.revision!==job.revision)
        throw Object.assign(new Error('制作服务与候选身份不符'),{code:'ENGINE_LEASE_IDENTITY'});
      if(runtime&&state.argsSha256!==runtime.argsSha256)throw Object.assign(new Error('原制作服务的运行组件与本配方不符，保留原进程'),{code:'ENGINE_BUILD_MISMATCH'});
      if(!Number.isInteger(state.port)||state.port<1||state.port>65535||!state.pid||!alive(state.pid))return false;
      client.endpoint='http://127.0.0.1:'+state.port+'/mcp';
    }
    try {await call('workspace_list_operations',{limit:1});return true;} catch(e) {
      if(['MAKER_CONNECTION_UNKNOWN','ENOENT'].includes(e.code))return false;throw e;
    }
  }
  if(await available())return;
  if(recoverOnly)throw Object.assign(new Error('原引擎未响应；作业号属于原进程，未启动替代服务'),{code:'ENGINE_SUBMISSION_UNKNOWN'});
  const service=await serviceStore.read('psd2live-service');
  if(!service?.pid||!alive(service.pid)){
    await fs.mkdir(location.dir,{recursive:true,mode:0o700});
    if(await fs.realpath(location.dir)!==location.dir)throw new Error('制作目录不能是符号链接');
    const log=await fs.open(path.join(location.dir,'psd2live-service.log'),'a',0o600);
    try{
      const child=spawn(process.execPath,[path.join(ROOT,'scripts/psd2live-service.mjs'),...location.args,...(runtime?(location.args.length===3?['',runtime.argsFile]:[runtime.argsFile]):[])],{cwd:ROOT,detached:true,stdio:['ignore',log.fd,log.fd]});
      child.unref();
    }finally{await log.close();}
  }
  for(let n=0;n<30;n++) {
    await new Promise(r=>setTimeout(r,500));
    if(await available())return;
  }
  throw Object.assign(new Error('制作引擎启动未完成，保留原任务，请检查服务日志'),{code:'ENGINE_UNAVAILABLE'});
}
try {
  await persist();
  if(job.kind==='single_image') {
    const withEngine=createStageEngine({root:ROOT,client,ensureEngine,location,runtime});
    await runImagePipeline(job,{root:ROOT,store,artworkCredentialResolver:runningHubCredential,
      modelStages:async(source,ctx)=>{
        try {return await advanceModelPipeline(source,{...ctx,withEngine,...(runtime?{engineRuntimePatch:runtime.engineRuntimePatch}:{}),
          localAttachmentMaxBytes:attachmentLimitForRevision(job),requireFinalPreviewReview:true,
          buildHdPreview:input=>buildHdPreview({root:ROOT,...input}),
          reopenEditable:(clean,manifest,opts)=>reopenEditable(ROOT,clean,manifest,{...opts,pinnedRuntime:runtime})});}
        catch(e) {
          if(!['ENGINE_BUSY','ENGINE_LEASE_LOST','ENGINE_PROJECT_OCCUPIED','ENGINE_SUBMISSION_UNKNOWN','ENGINE_LEASE_IDENTITY',
            'MAKER_CONNECTION_UNKNOWN','MAKER_NO_REPLY','ENGINE_UNAVAILABLE','ENGINE_BUILD_MISMATCH','BUSY'].includes(e.code))throw e;
          return {stage:['rigging','dynamics'].includes(job.stage)?job.stage:'rigging',
            status:['ENGINE_SUBMISSION_UNKNOWN','MAKER_NO_REPLY','MAKER_CONNECTION_UNKNOWN'].includes(e.code)?'awaiting_external_result':'blocked',
            error:{code:e.code,message:e.message}};
        }
      }});
    console.log(JSON.stringify({id,status:job.status,stage:job.stage,error:job.error}));
    process.exit(0);
  }
  const catalog=await new Maker().materials(),material=catalog.materials.find(m=>m.id===job.materialId&&m.valid);
  if(!material) throw new Error('输入素材校验失败');
  job.source=material;await persist();
  legacyLease=await acquireEngineLease(ROOT,{taskId:id,candidateId:id,revision:1,parentRevision:null,inputSha256:material.sha256,
    descriptionSha256:createHash('sha256').update('registered-psd:'+material.id).digest('hex'),stage:'registered-psd'});
  await ensureEngine();
  await step('import','project_import_psd',{path:path.join(ROOT,material.file)});
  const imported=await call('workspace_inspect',{scope:'project'});job.projectId=imported.project_id;await persist();
  await step('rig','workspace_apply_edits',{summary:'半身演示：嘴眼与小幅转头',edits:[
    {operation:'settings_update',request:{changes:{headStrength:0.45,bodyStrength:0.35,seeThroughEyes:false,seeThroughBrows:false}}},
    {operation:'rig_generate',request:{}}
  ]});
  const overview=await call('workspace_overview',{limit:500});await write('角色结构.json',overview);
  const expressions=await call('expression_list');await write('表情.json',expressions);
  // This clip is authored animation, clearly separate from the later camera/microphone acceptance recording.
  const params=overview.parameters?.items??overview.parameters??[];
  const present=new Set(params.map(p=>p.id));
  const curves=[];
  function curve(parameter,points) {if(present.has(parameter))curves.push({parameter,keys:points.map(([time,value])=>({time,value}))});}
  curve('ParamMouthOpenY',[[0,0],[.25,.65],[.5,.1],[.75,.8],[1,.05],[1.3,.5],[1.6,0],[3,0],[3.3,.4],[3.6,0],[6,0]]);
  for(const p of ['ParamEyeLOpen','ParamEyeROpen'])curve(p,[[0,1],[1.85,1],[1.95,0],[2.1,1],[4.85,1],[4.95,0],[5.1,1],[6,1]]);
  curve('ParamAngleX',[[0,0],[2.1,0],[2.7,-10],[3.3,0],[4,10],[4.6,0],[6,0]]);
  curve('ParamAngleY',[[0,0],[4.4,0],[4.9,-8],[5.4,8],[6,0]]);
  if(curves.length<5) throw new Error('自动绑定缺少嘴、双眼或转头参数，保留工程供检查');
  await step('preview-motion','motion_put',{clip:{id:'preview6s',name:'六秒制作预览（非真人实录）',loop:true,duration:6,fps:24,curves}});
  await step('save','project_save_as',{path:path.join(job.output,'角色.psd2live')});
  await step('model','project_export_model',{output_directory:path.join(job.output,'model')});
  await step('preview','project_export_target',{target:'gif',output_directory:path.join(job.output,'preview'),settings:{clip:'preview6s',fps:'15',size:'768',background:'FF273342'}});
  await step('preview-video','project_export_target',{target:'mp4',output_directory:path.join(job.output,'preview'),settings:{clip:'preview6s',fps:'24',size:'1024',background:'FF273342',ffmpeg}});
  const preview=await finishPreview(path.join(job.output,'preview'),material.previewCrop);
  const modelFiles=await findModels(path.join(job.output,'model'));
  const inspections=await Promise.all(modelFiles.map(inspectModel));await write('文件检查.json',inspections);
  if(!inspections.length||inspections.some(m=>!m.ok)) throw new Error('导出文件引用检查未通过');
  job.status='completed';job.stage='exported';job.completedAt=new Date().toISOString();
  const previewDirectory=path.join(job.output,'preview');
  const previews=preview.previews;
  if(!previews.length) throw new Error('制作预览未生成，不能标记交付完成');
  job.artifacts={project:path.join(job.output,'角色.psd2live'),models:modelFiles,previewDirectory,previews,cover:preview.cover};
  job.acceptance={exportFiles:'passed',render:'pending_visual_review',vtsReload:'not_verified',cameraTracking:'not_verified',bilibili:'not_verified',userAccepted:false};
  await write('制作记录.json',{...job,session:undefined,callId:undefined,pid:undefined});
  await persist();console.log(JSON.stringify({status:job.status,id,artifacts:job.artifacts}));
} catch(e) {
  job.status=['MAKER_CONNECTION_UNKNOWN','MAKER_NO_REPLY'].includes(e.code)?'outcome_unknown':'failed';
  job.error={code:e.code??'MAKE_FAILED',message:e.message};await persist();
  console.error(JSON.stringify({id,status:job.status,stage:job.stage,error:job.error}));process.exitCode=1;
} finally {if(legacyLease)await legacyLease.release();}

import * as fs from 'node:fs/promises';
import path from 'node:path';
import {engineRun,originalCopy,outputDirectory,receiptDigest} from './engine-run.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {Fault} from '../rpc.mjs';
import {ffmpeg} from '../preview.mjs';
import {decodePng} from '../rigging/geometry.mjs';
import {digest,listFiles,relativePath,taskFile,writeJson,sameJson} from './files.mjs';
import {matchingMotionClip} from './export-check.mjs';
import {planDynamicsPreview,previewClip,previewRasterSize} from './preview-plan.mjs';
import {dynamicsState,commitDynamics,identityKeys} from './preview-state.mjs';

const exec=promisify(execFile);
export const previewCriteria=['same-candidate-appearance','expression-sequence','mouth-eye-head-combination',
  'motion-cancel-preserves-expression','preview-reset-baseline','physics-slow-fast-reverse-settle'];

export async function inspectDynamicsPreviewPending(ctx) {
  const root=await fs.realpath(ctx.taskRoot),journal=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/preview/engine-journal.json'),'utf8'));
  if(['taskId','candidateId','revision','parentRevision'].some(k=>journal[k]!==ctx[k]))
    throw new Fault('DYNAMICS_IDENTITY_MISMATCH','试演检查点身份不符');
  const p=journal.pending;
  if(!p)return {status:'no_pending',captureStatus:journal.status};
  const reference={operation:p.operation,requestId:p.request.request_id,jobId:p.jobId};
  if(!p.jobId||!ctx.engine?.call)return {status:'awaiting_external_result',...reference};
  const job=(await ctx.engine.call('job_get',{id:p.jobId},{wait:false,unwrap:false})).data;
  if(job.id!==p.jobId)throw new Fault('DYNAMICS_JOB_MISMATCH','查询回执与原job不符');
  return {...reference,status:job.terminal?'blocked':'awaiting_external_result',jobStatus:job.status,terminal:job.terminal===true,
    reason:'仅查询原任务；生产 worker 依据原轨迹、工程及视频回执判断能否接续'};
}

export async function captureDynamicsPreview(bundle,ctx,options={}) {
  let startedAtUtc=new Date().toISOString();
  const {root,current,manifest}=await dynamicsState(bundle,ctx,{allowPrevious:true});
  const dir=path.join(root,'dynamics/preview'),journalFile=path.join(dir,'engine-journal.json');
  if(current.previewCapture) {
    if(bundle.projectPath!==current.projectPath||bundle.modelPath!==current.modelPath)
      throw new Fault('DYNAMICS_IDENTITY_MISMATCH','预览重入的模型/工程路径不符');
    if(!ctx.recoverDynamics||current.previewCapture.status!=='awaiting_external_result')return current;
  }
  if(JSON.stringify(current)!==JSON.stringify(bundle))throw new Fault('DYNAMICS_STALE_BUNDLE','采集须使用当前动态候选');
  if(!['blocked','awaiting_external_result'].includes(current.status)||manifest.exportStatus!=='exported'||current.engineVersion!=='3.6.7'||
    !current.checks.some(c=>c.name==='dynamics.export-and-reopen'&&c.status==='passed'))
    throw new Fault('DYNAMICS_PREVIEW_NOT_READY','需要已真实导出重开的动态候选');
  if(!ctx.engine?.call)throw new Fault('ENGINE_BUSY','采集需要00注入持04独占租约的引擎');
  const recipe=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/recipe.json'),'utf8'));
  const map=current.brief?null:JSON.parse(await fs.readFile(await taskFile(root,current.parameterMapPath),'utf8'));
  const brief=current.brief??{intent:map.requested};
  let plan=planDynamicsPreview(recipe,brief,options);
  const source=await taskFile(root,current.projectPath),model=await taskFile(root,current.modelPath);
  const sourceSha=await digest(source),modelSha=await digest(model);
  if(manifest.parentProject&&await digest(await taskFile(root,manifest.parentProject.path))!==manifest.parentProject.sha256)
    throw new Fault('DYNAMICS_PARENT_CHANGED','父版工程已变化，停止采集');
  let recovery=false;
  try {await fs.mkdir(dir);}catch(e) {
    if(e.code!=='EEXIST')throw e;
    if(!ctx.recoverDynamics||await fs.realpath(dir)!==dir)throw new Fault('EXTERNAL_RESULT_UNKNOWN','已有试演目录，先核原作业');
    recovery=true;
  }
  const sourceInfo={projectPath:current.projectPath,projectSha256:sourceSha,modelPath:current.modelPath,modelSha256:modelSha};
  let journal={schemaVersion:2,...Object.fromEntries(identityKeys.map(k=>[k,current[k]])),status:'running',startedAtUtc,source:sourceInfo,steps:[],pending:null};
  if(recovery) {
    journal=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/preview/engine-journal.json'),'utf8'));
    if(journal.schemaVersion!==2||identityKeys.some(k=>current[k]!==journal[k])||Object.keys(sourceInfo).some(k=>sourceInfo[k]!==journal.source?.[k]))
      throw new Fault('DYNAMICS_RECEIPT_UNVERIFIED','试演来源或原检查点不符');
    startedAtUtc=journal.startedAtUtc;
  }else await writeJson(journalFile,journal,{exclusive:true});
  const initialPending=journal.pending?.request.request_id;
  const original=structuredClone(current);
  if(current.previewCapture?.status==='awaiting_external_result'){
    delete current.previewCapture;current.status='blocked';
    current.unresolved=current.unresolved.filter(i=>i.code!=='EXTERNAL_RESULT_UNKNOWN');
  }
  const run=engineRun({root,journal,file:journalFile,ctx,project:current.engineProjectId??current.projectId,
    state:current.engineRevision??current.engineState,preview:true});
  const {step,inspect}=run;
  let openedScratch=false,restored=false,committedFiles;
  const restore=async(discardScratch=false)=>{
    await step('return-candidate','project_open',{path:source,...(discardScratch?{discard_unsaved:true}:{})});restored=true;
    current.projectId=current.engineProjectId=run.project;current.engineState=current.engineRevision=run.state;
  };
  try {
    if(journal.failure)throw new Fault(journal.failure.code,journal.failure.message);
    const trajectory=path.join(dir,'trajectory.json');
    let clip;
    if(journal.trajectorySha) {
      if(await fs.realpath(trajectory)!==trajectory||await digest(trajectory)!==journal.trajectorySha)throw new Fault('DYNAMICS_CHECKPOINT_CHANGED','已采集时间线被更改');
      const {clip:saved,...savedPlan}=JSON.parse(await fs.readFile(trajectory,'utf8'));
      if(plan.trackingClock&&!savedPlan.trackingClock||plan.expressionClock&&!savedPlan.expressionClock) {
        plan=planDynamicsPreview(recipe,brief,{...options,
          ...(!savedPlan.trackingClock?{continuousTracking:false}:{}),
          ...(!savedPlan.expressionClock?{expressionFades:false}:{})});
      }
      if(JSON.stringify(savedPlan)!==JSON.stringify(plan))throw new Fault('DYNAMICS_CHECKPOINT_CHANGED','同版试演方案改变');
      clip=saved;
    }else {
      if(run.replaying)throw new Fault('DYNAMICS_CHECKPOINT_CHANGED','原轨迹缺少文件绑定');
      await inspect();
      clip=await previewClip(plan,recipe,async(m,time)=>{
        await inspect();
        const r=(await ctx.engine.call('motion_sample',{id:m.id,time,loop:m.loop??true})).data;
        if(r.state!==run.state||r.id!==m.id||Math.abs(r.time-time)>1e-6)
          throw new Fault('DYNAMICS_ENGINE_MISMATCH','动作采样不属于当前状态');
        return r.values;
      });
      await sameJson(trajectory,{...plan,clip});
      journal.trajectorySha=await digest(trajectory);await writeJson(journalFile,journal);
    }
    const scratch=path.join(dir,'verification.psd2live');
    await originalCopy(source,scratch,recovery,[...journal.steps,journal.pending].some(s=>s?.name==='save-scratch'));
    await step('open-scratch','project_open',{path:scratch});openedScratch=true;
    await step('put-verification-clip','motion_put',{clip});
    if(!run.replaying) {
      await inspect();
      const read=(await ctx.engine.call('motion_get',{id:clip.id})).data;
      if(!matchingMotionClip(read.clip,clip))throw new Fault('DYNAMICS_PREVIEW_INVALID','试演时间线实际读回不符');
    }
    await step('save-scratch','project_save_as',{path:scratch});
    const output=path.join(dir,'render');await outputDirectory(output,recovery);
    // Keep the exact render size of an already submitted operation during reconciliation.
    const submitted=[...journal.steps,journal.pending].find(s=>s?.name==='export-native-preview');
    const size=submitted?.request.settings?.size==='1024'?'1024':String(previewRasterSize(recipe,plan.frameCount));
    const exported=await step('export-native-preview','project_export_target',{target:'mp4',output_directory:output,
      settings:{clip:clip.id,fps:String(plan.fps),size,physics:'true',background:'FF273342',ffmpeg}});
    if(exported.target!=='mp4'||exported.directory!==output||!Array.isArray(exported.losses)||
      exported.losses.some(l=>l.feature?.toLowerCase()==='physics'||l.error))
      throw new Fault('DYNAMICS_PREVIEW_PHYSICS_LOSS','引擎未确认携带实际物理或报告导出错误；保留losses，不将其当作物理样片');
    const all=await listFiles(output),videos=all.filter(p=>p.endsWith('.mp4'));
    if(videos.length!==1)throw new Fault('DYNAMICS_PREVIEW_INVALID','需要唯一实际导出视频');
    const video=videos[0];
    const decoded=await exec(ffmpeg,['-hide_banner','-nostdin','-v','info','-i',video,'-map','0:v:0','-fps_mode','passthrough',
      '-progress','pipe:1','-nostats','-f','null','-'],{signal:ctx.signal,maxBuffer:1024*1024});
    const counts=[...decoded.stdout.matchAll(/^frame=(\d+)$/gm)],count=Number(counts.at(-1)?.[1]);
    if(count!==plan.frameCount)throw new Fault('DYNAMICS_PREVIEW_INVALID','实际视频解码帧数与完整时间线不符');
    const cover=path.join(dir,'cover.png');
    // The cover is local derived media. Compare the original frame on recovery, including a crash during return-candidate.
    const frame=await exec(ffmpeg,['-v','error','-nostdin','-i',video,'-frames:v','1','-c:v','png','-f','image2pipe','pipe:1'],
      {encoding:'buffer',signal:ctx.signal,maxBuffer:16*1024*1024});
    try{await fs.writeFile(cover,frame.stdout,{flag:'wx'});}catch(e){
      if(e.code!=='EEXIST'||!recovery||await fs.realpath(cover)!==cover||!(await fs.readFile(cover)).equals(frame.stdout))throw e;
    }
    const image=decodePng(await fs.readFile(cover));
    if(await digest(source)!==sourceSha||await digest(model)!==modelSha||
      manifest.parentProject&&await digest(await taskFile(root,manifest.parentProject.path))!==manifest.parentProject.sha256)
      throw new Fault('DYNAMICS_PARENT_CHANGED','候选或父版在采集中改变');
    await restore();await run.complete();
    const report={schemaVersion:1,...journal.source,sourceCopySha256:sourceSha,exported,startedAtUtc,
      completedAtUtc:new Date().toISOString(),elapsedMs:Math.max(0,Date.now()-Date.parse(startedAtUtc)),
      engineSteps:journal.steps.map(({name,operation,elapsedMs})=>({name,operation,elapsedMs})),
      method:plan.method,limitations:plan.limitations,frameCount:count,fps:plan.fps,duration:count/plan.fps,
      width:image.width,height:image.height,decoded:true,originalCandidateReopened:restored,
      runtime:'not_run',human:'not_run',userAcceptance:'not_run'};
    try {await writeJson(path.join(dir,'capture-report.json'),report,{exclusive:true});}
    catch(e){if(e.code!=='EEXIST'||!recovery)throw e;
      const saved=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/preview/capture-report.json'),'utf8'));
      const stable=({completedAtUtc,elapsedMs,...v})=>v;
      if(JSON.stringify(stable(saved))!==JSON.stringify(stable(report)))throw new Fault('DYNAMICS_CHECKPOINT_CHANGED','原试演报告不符');
    }
    manifest.preview={kind:'parameter-animation',videoPath:relativePath(root,video),coverPath:relativePath(root,cover),
      videoSha256:await digest(video),modelSha256:modelSha,projectSha256:sourceSha,
      captureReportPath:'dynamics/preview/capture-report.json',trajectoryPath:'dynamics/preview/trajectory.json',
      duration:report.duration,fps:plan.fps,frameCount:count,
      requiredCriteria:[...previewCriteria,...recipe.motions.filter(m=>m.id!=='dyn_idle').map(m=>'additional-motion:'+m.id),
        ...Object.keys(recipe.appearanceGroups??{}).map(id=>'appearance-toggle-restore:'+id)],
      limitations:plan.limitations};
    current.previewCapture={status:'captured',reportPath:manifest.preview.captureReportPath};
    current.checks.push({name:'dynamics.preview-capture',layer:'automated',status:'passed',
      note:'原生独立渲染物理、同源副本、完整视频解码和父版哈希；视觉及运行器仍待实际观察'});
    journal.status='captured';await writeJson(journalFile,journal);
    committedFiles=[scratch,trajectory,cover,video,path.join(dir,'capture-report.json')].map(p=>relativePath(root,p));
  } catch(e) {
    // A known failed capture can return to the unchanged source; unknown edits must keep the original task.
    if(openedScratch&&!restored&&!journal.pending&&!recovery)try {await restore(true);}catch(restoreError) {
      journal.restoreError={code:restoreError.code,message:restoreError.message};
    }
    const unknown=!!journal.pending;
    if(recovery&&unknown&&original.previewCapture&&initialPending===journal.pending.request.request_id)return original;
    current.status=unknown?'awaiting_external_result':'blocked';
    current.previewCapture={status:unknown?'awaiting_external_result':'failed',code:e.code??'DYNAMICS_PREVIEW_FAILED'};
    current.unresolved.push({code:unknown?'EXTERNAL_RESULT_UNKNOWN':e.code??'DYNAMICS_PREVIEW_FAILED',message:e.message,
      ...(journal.pending?{operation:journal.pending.operation,jobId:journal.pending.jobId,requestId:journal.pending.request.request_id}:{})});
    journal.status=current.previewCapture.status;journal.error={code:e.code,message:e.message};
    journal.elapsedMs=Math.max(0,Date.now()-Date.parse(startedAtUtc));await writeJson(journalFile,journal);
    // Failed/partial media remain recovery evidence; they are never registered as a usable preview.
    const event=recovery?'failure-'+receiptDigest(journal.pending?.request.request_id??'terminal')+'.json':'failure.json';
    await sameJson(path.join(dir,event),{status:journal.status,error:journal.error,restored,restoreError:journal.restoreError});
    committedFiles=['dynamics/preview/'+event];
  }
  let destination='dynamics/preview';
  if(recovery) {
    destination+='/receipt-'+receiptDigest(journal.pending?.request.request_id??journal.status);
    await outputDirectory(path.join(root,destination),true);
  }
  return await commitDynamics(root,current,manifest,destination,committedFiles,ctx);
}

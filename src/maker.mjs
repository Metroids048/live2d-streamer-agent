import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Store} from './store.mjs';
import {Fault,fail} from './rpc.mjs';
import {ROOT} from './controller.mjs';
import {reviewAvailable,recordNativeReview} from './pipeline/native-review.mjs';
import {localRepairCriteria} from './artwork/local-repair.mjs';
import {hasReviewedRigRepair} from './pipeline/reviewed-rig-repair.mjs';
import {RIG_REPAIR_PROFILE} from './rigging/recipe.mjs';
import {canResumeFailedFlash} from './pipeline/flash-correction.mjs';
import {flashUsage} from './pipeline/flash-usage.mjs';
import {ImageInbox} from './pipeline/attachments.mjs';
import {verifyRequestedControls} from './packaging/controls.mjs';
import {inspectModel} from './packaging/model.mjs';
import {json as packagingJson} from './packaging/files.mjs';
import {isSaveStorageFailure} from './rigging/engine.mjs';
import {emotionPresets} from './rigging/streamer-presets.mjs';
import {prepareCachedReplay} from './pipeline/cached-replay.mjs';
import {passedFinalPreviewReview} from './packaging/final-preview-review.mjs';
import {buildHdPreview} from './packaging/hd-preview.mjs';

export const alive=pid=>{try {process.kill(pid,0);return true;}catch{return false;}};

// Parent dispatch and child admission use the same short store lock. A
// delayed or duplicated child may never start the same queued job twice.
export async function claimQueuedJob(store,id) {
  const deadline=Date.now()+15000;
  for(;;) {
    try {
      return await store.lock(async()=>{
        const job=await store.read('make-'+id);
        if(job?.status!=='queued'||job.pid&&job.pid!==process.pid)return null;
        job.pid=process.pid;job.status='running';
        await store.write('make-'+id,job);return job;
      });
    }catch(e){if(!['BUSY','ENOENT'].includes(e.code)||Date.now()>=deadline)throw e;await delay(100);}
  }
}
export class Maker {
  constructor(root=ROOT) {this.root=root;this.store=new Store(root);}
  async materials() {
    const base=await fs.realpath(this.root);
    const {materials}=JSON.parse(await fs.readFile(path.join(this.root,'config/materials.json'),'utf8'));
    const checked=await Promise.all(materials.map(async m=>{
      try {
        const f=await fs.realpath(path.resolve(this.root,m.file));
        if(!f.startsWith(base+path.sep)) fail('MATERIAL_OUTSIDE_PROJECT','素材必须在当前项目内');
        const hash=createHash('sha256').update(await fs.readFile(f)).digest('hex');
        return {...m,valid:hash===m.sha256&&m.licenseReviewed};
      } catch {return {...m,valid:false};}
    }));
    let ready=false;
    try {await fs.access(path.join(this.root,'.local/tools/psd2live/build/run/jvm.args'));ready=true;}catch{}
    return {ok:true,engine:{name:'PSD2Live',version:'3.6.7',built:ready},materials:checked};
  }
  async making(id,ctx) {
    if(!/^[a-f0-9-]{36}$/.test(id??'')) fail('INVALID_JOB','制作任务 ID 无效');
    const job=await this.store.read('make-'+id);
    if(!job) fail('UNKNOWN_JOB','未找到本项目制作任务');
    if(job.session!==this.store.session(ctx)) fail('SESSION_MISMATCH','制作任务属于另一个会话');
    const delivery=job.completedCandidateDelivery;
    return {ok:true,id:job.id,status:job.status,stage:job.stage,output:job.output,
      startedAt:job.startedAt,completedAt:job.completedAt,source:job.source,
      steps:job.steps.map(({name,operation,finishedAt,startedAt,status,elapsedMs})=>({name,operation,finishedAt,
        ...(startedAt?{startedAt,status,elapsedMs}:{})})),
      pending:job.pending?{operation:job.pending.operation,jobId:job.pending.jobId}:undefined,
      error:job.error,artifacts:job.artifacts,acceptance:job.acceptance,pipeline:job.pipeline,candidateId:job.candidateId,revision:job.revision,
      ...(delivery?{completedCandidateDelivery:{status:delivery.status,revision:delivery.revision,
        parentRevision:delivery.parentRevision,at:delivery.at}}:{}),
      providerUsage:await flashUsage(job),
      ...(reviewAvailable(job)?{visualReview:{startPage:0,tool:'avatar_making',observationMedium:job.stage==='artwork'?'static_pages':'frame_pages',
        message:'使用 visual_page 从0逐页查看同版证据，再由 avatar_make 带原 resume_job_id 及 visual_review 提交实际观察。动态联系图仅用于记录缺陷，不代表连续自审完成，不能据此提交动态通过。'}}:{}),
      workerAlive:job.pid?alive(job.pid):false};
  }
  async mayYield(job) {
    if(!job)return false;
    if(['completed','failed'].includes(job.status))return true;
    if(job.kind!=='single_image'||job.pending||job.pid&&alive(job.pid)||await this.store.read('engine-lease'))return false;
    // A published successor finishes production without erasing the blocked parent receipt.
    if(job.status==='blocked'&&job.completedCandidateDelivery?.status==='published'&&
      job.completedCandidateDelivery.revision>job.revision)return true;
    const local=job.pipeline?.artwork?.local;
    const finishedLocal=local?.provider==='local-layer-layout'&&local.externalSubmitted===false&&local.receiptStatus==='completed';
    const outputJson=async name=>{
      const file=path.join(job.output,name);
      if(await fs.realpath(file)!==file||!(await fs.lstat(file)).isFile())return null;
      return JSON.parse(await fs.readFile(file,'utf8'));
    };
    const ownStage=stage=>stage?.stage===job.stage&&stage.status==='blocked'&&stage.taskId===job.id&&
      stage.candidateId===job.candidateId&&stage.revision===job.revision&&!stage.pending;
    if(finishedLocal&&job.status==='blocked'&&job.stage==='packaging'&&job.error?.code==='DELIVERY_TOO_LARGE') {
      try {
        const [stage,verification]=await Promise.all(['packaging/stage.json','packaging/verification.json'].map(outputJson));
        if(ownStage(stage)&&stage.unresolved?.length===1&&stage.unresolved[0].code===job.error.code&&
          verification?.nativeReopen==='passed'&&verification.identity?.taskId===job.id&&
          verification.identity?.candidateId===job.candidateId&&verification.identity?.revision===job.revision)return true;
      } catch(e) {if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    }
    if(job.status==='blocked'&&job.stage==='artwork'&&['ARTWORK_VISUAL_REVIEW_FAILED','ARTWORK_QUALITY_FAILED'].includes(job.error?.code)) {
      if(finishedLocal) {
        try {
          const [operation,stage]=await Promise.all(['artwork/operation.json','artwork/stage.json'].map(outputJson));
          if(operation?.status==='completed'&&operation.backend?.id==='local-layer-layout'&&
            ownStage(stage)&&(job.error.code==='ARTWORK_VISUAL_REVIEW_FAILED'||
              stage.unresolved?.some(issue=>issue.code===job.error.code)))return true;
        } catch(e) {if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
      }
    }
    if(finishedLocal&&job.status==='blocked'&&['rigging','dynamics'].includes(job.stage)&&
      ['RIG_VISUAL_REVIEW_REQUIRED','RIG_VISUAL_REVIEW_FAILED','DYNAMICS_VISUAL_NOT_RUN','DYNAMICS_VISUAL_REVIEW_FAILED'].includes(job.error?.code)) {
      const rig=job.stage==='rigging';
      try {
        const [stage,journal]=await Promise.all([job.stage+'/stage.json',rig?'rigging/state.json':'dynamics/preview/engine-journal.json'].map(outputJson));
        const owner=rig?journal?.identity:journal;
        if(ownStage(stage)&&journal&&!journal.pending&&owner?.taskId===job.id&&owner?.candidateId===job.candidateId&&owner?.revision===job.revision&&
          (rig?journal.projectId===stage.engineProjectId&&journal.state===stage.engineRevision:journal.status==='captured'))return true;
        } catch(e) {if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    }
    const recoveredRecipeConflict=job.error?.code==='RECIPE_CHANGED_USE_NEW_CANDIDATE'&&
      job.riggingStorageRecovery?.previousError?.code==='ENOSPC';
    if(finishedLocal&&job.status==='blocked'&&job.stage==='rigging'&&
      (recoveredRecipeConflict||['WAVE_NATIVE_GEOMETRY_REJECTED','CONTINUOUS_WAVE_TRIANGLE_COLLAPSE'].includes(job.error?.code))) {
      try {
        const [stage,journal,failure]=await Promise.all(['rigging/stage.json','rigging/state.json','rigging/failure.json'].map(outputJson));
        const owner=journal?.identity;
        if(ownStage(stage)&&journal?.projectId&&journal.state&&!journal.pending&&owner?.taskId===job.id&&
          owner.candidateId===job.candidateId&&owner.revision===job.revision&&
          failure?.code===job.error.code&&failure.pending===null&&
          (!recoveredRecipeConflict||!journal.failed&&journal.recoveries?.at(-1)?.evidence===job.riggingStorageRecovery.evidence&&
            journal.recoveries.at(-1).toState===journal.state))return true;
      } catch(e) {if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    }
    if(finishedLocal&&job.status==='blocked'&&job.stage==='dynamics'&&job.error?.code==='DYNAMICS_EXPRESSION_INCOMPLETE') {
      try {
        const [stage,manifest]=await Promise.all(['dynamics/stage.json','dynamics/dynamics-manifest.json'].map(outputJson));
        if(ownStage(stage)&&ownStage(manifest)&&manifest.exportStatus==='not_run'&&
          stage.unresolved?.some(issue=>issue.code===job.error.code)) {
          try {await fs.lstat(path.join(job.output,'dynamics/engine-journal.json'));}
          catch(e) {if(e.code!=='ENOENT')throw e;return true;}
        }
      } catch(e) {if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    }
    if(finishedLocal&&job.status==='blocked'&&job.stage==='dynamics'&&job.error?.code==='DYNAMICS_PREVIEW_INVALID') {
      try {
        const [stage,journal,failure]=await Promise.all(['dynamics/stage.json','dynamics/preview/engine-journal.json',
          'dynamics/preview/failure.json'].map(outputJson));
        const scratch=journal?.steps?.find(s=>s.name==='open-scratch');
        if(ownStage(stage)&&journal?.taskId===job.id&&journal.candidateId===job.candidateId&&journal.revision===job.revision&&
          journal.status==='failed'&&journal.pending===null&&journal.error?.code===job.error.code&&failure?.error?.code===job.error.code&&
          scratch?.request?.path===path.join(job.output,'dynamics/preview/verification.psd2live')&&
          scratch.files?.some(f=>f.path==='dynamics/preview/verification.psd2live'&&f.sha256===journal.source?.projectSha256)&&
          (failure.restored===true||journal.failure?.name==='return-candidate'&&journal.failure?.jobId===null&&
            journal.failure?.code==='MAKER_JOB_FAILED'&&/unsaved changes/.test(failure.restoreError?.message??'')))return true;
      } catch(e) {if(e.code!=='ENOENT'&&!(e instanceof SyntaxError))throw e;}
    }
    if(job.status!=='blocked'||job.stage!=='artwork'||job.pipeline?.artwork?.submitted!==false)return false;
    // Worker preflight explicitly marks unsubmitted jobs. A real or unknown
    // operation has a durable receipt and must keep its reservation.
    try {await fs.lstat(path.join(job.output,'artwork/operation.json'));return false;}
    catch(e){if(e.code!=='ENOENT')throw e;return true;}
  }
  async makeImage(request,ctx) {
    const session=this.store.session(ctx);
    if(!ctx.sessionId)fail('SESSION_REQUIRED','图片制作需要完整会话身份');
    if(!request.rights||typeof request.rights!=='object')fail('INPUT_INVALID','请提供图片、制作描述与实际授权说明');
    return this.store.lock(async()=>{
      const previous=await this.store.read('maker-active'),prior=previous&&await this.store.read('make-'+previous.id);
      if(ctx.callId&&prior?.callId===ctx.callId&&prior.session===session)return this.making(prior.id,ctx);
      if(previous&&!await this.mayYield(prior))fail('MAKER_BUSY','原制作任务仍在运行、待处理或结果未知，请查询原任务',{jobId:previous.id});
      const id=randomUUID(),output=path.join(this.root,'openclaw-workspace','outputs',id);
      await fs.mkdir(output,{recursive:true});
      // Prove the opaque ref belongs to this session before enqueuing anything.
      let inputSha256;
      try {
        const {description,sha256}=await new ImageInbox(this.root).resolve(request.imageRef,ctx,output);
        inputSha256=sha256;
        if(description!==undefined)request={...request,description};
        if(typeof request.description!=='string'||!request.description.trim()||request.description.length>20000)
          fail('INPUT_INVALID','请提供有效的图片制作描述');
      }
      catch(e){await fs.rm(output,{recursive:true,force:true});throw e;}
      const job={id,kind:'single_image',session,sessionContext:{sessionKey:ctx.sessionKey,sessionId:ctx.sessionId},callId:ctx.callId,request,
        candidateId:randomUUID(),revision:1,parentRevision:null,status:'queued',stage:'queued',output,startedAt:new Date().toISOString(),steps:[]};
      if(/^agent:live2d-streamer:dashboard:[a-z0-9-]+$/.test(ctx.sessionKey)&&
        /自动(?:制作|出包|交付|发布)|无人值守|做好后(?:请)?(?:直接)?(?:在这里|在本会话|在这个对话里)?(?:给我|发|交付)|(?:在这里|在本会话|在这个对话里)(?:直接)?(?:给我|发给我|交付)[^。！？\n]{0,80}(?:模型包|角色包|资源包|工程包|制作包|完整包|分层\s*PSD)/u.test(request.description))job.notifyAutomatically=true;
      await this.store.write('make-'+id,job);await this.store.write('maker-active',{id});
      await this.launch(job);
      return {ok:true,jobId:id,candidateId:job.candidateId,revision:1,status:'queued',stage:'queued',inputSha256,message:
        job.notifyAutomatically?'已接收图片和需求。现在回复任务编号；后台会把结果发到本会话。':'已接收图片和需求，后台将继续处理。现在回复任务编号；在本会话询问进度时可继续查询原任务。'};
    });
  }
  async launch(job) {
    const log=await fs.open(path.join(job.output,'制作日志.txt'),'a',0o600);
    try {
      const child=spawn(process.execPath,[path.join(this.root,'scripts/make-worker.mjs'),job.id],{cwd:this.root,detached:true,stdio:['ignore',log.fd,log.fd]});
      await once(child,'spawn');child.unref();job.pid=child.pid;
      await this.store.write('make-'+job.id,job);
    }finally {await log.close();}
  }
  async recoverPresetPreflight(id,ctx) {
    return this.store.lock(async()=>{
      const active=await this.store.read('maker-active'),job=await this.store.read('make-'+id);
      const emotion=/^表情没有独立的情绪参数：dyn_([a-z0-9_]+)$/.exec(job?.error?.message??'')?.[1];
      if(active?.id!==id||job?.id!==id||job.kind!=='single_image'||!job.notifyAutomatically||
        job.session!==this.store.session(ctx)||job.stage!=='packaging'||job.status!=='failed'||
        job.error?.code!=='REFERENCE_INVALID'||!emotionPresets.some(p=>p.id===emotion)||
        job.pending||job.artifacts||job.packagingRecovery||job.pid&&alive(job.pid)||
        job.pipeline?.artwork?.local?.externalSubmitted!==false||job.pipeline?.dynamics?.status!=='completed'||
        await this.store.read('engine-lease'))return;
      const root=path.join(this.root,'openclaw-workspace','outputs',id);
      if(job.output!==root||await fs.realpath(root)!==root)return;
      const current=path.join(root,'packaging'),archive=path.join(root,'packaging-preset-preflight-rejected');
      const entries=async dir=>{
        try {if(await fs.realpath(dir)===dir)return await fs.readdir(dir);return [];}
        catch(e){if(e.code==='ENOENT')return null;throw e;}
      };
      const [present,previous,hd]=await Promise.all([entries(current),entries(archive),entries(path.join(root,'packaging-hd-preview'))]);
      if(hd||present&&previous)return;
      const rejected=present?'packaging':'packaging-preset-preflight-rejected';
      if((present??previous)?.join()!=='stage.json')return;
      const [stage,dynamics]=await Promise.all([packagingJson(root,rejected+'/stage.json'),packagingJson(root,'dynamics/stage.json')]);
      const owned=value=>value?.taskId===id&&value.candidateId===job.candidateId&&value.revision===job.revision&&
        value.parentRevision===job.parentRevision&&!value.pending;
      if(!owned(stage)||!owned(dynamics)||stage.stage!=='packaging'||dynamics.stage!=='dynamics'||
        stage.status!=='failed'||dynamics.status!=='completed'||dynamics.brief?.streamerPresets!==true||
        stage.inputSha256!==dynamics.inputSha256||stage.descriptionSha256!==dynamics.descriptionSha256||
        stage.deliveryFiles?.length||stage.unresolved?.length!==1||stage.unresolved[0].code!==job.error.code||
        stage.unresolved[0].message!==job.error.message)return;
      const [map,manifest,model]=await Promise.all([packagingJson(root,dynamics.parameterMapPath),
        packagingJson(root,dynamics.dynamicsManifestPath),inspectModel(root,dynamics.modelPath)]);
      await verifyRequestedControls(root,dynamics,map,manifest,model);
      if(present)await fs.rename(current,archive);
      job.packagingRecovery={previousError:job.error,at:new Date().toISOString(),receiptPath:path.join(archive,'stage.json')};
      job.status='queued';job.resumedAt=job.packagingRecovery.at;delete job.pid;delete job.error;
      await this.store.write('make-'+id,job);await this.launch(job);
    });
  }
  async recoverPackageStorage(id,ctx) {
    return this.store.lock(async()=>{
      const active=await this.store.read('maker-active'),job=await this.store.read('make-'+id);
      if(active?.id!==id||job?.id!==id||job.kind!=='single_image'||!job.notifyAutomatically||
        job.session!==this.store.session(ctx)||job.stage!=='packaging'||job.status!=='failed'||
        job.error?.code!=='ENOSPC'||job.pending||job.artifacts||job.storageRecovery||
        job.pid&&alive(job.pid)||job.pipeline?.artwork?.local?.externalSubmitted!==false||
        job.pipeline?.dynamics?.status!=='completed'||await this.store.read('engine-lease'))return;
      const root=path.join(this.root,'openclaw-workspace','outputs',id);
      if(job.output!==root||await fs.realpath(root)!==root)return;
      const space=await fs.statfs(root,{bigint:true});
      if(space.bavail*space.bsize<512n*1024n*1024n)return;
      const current='packaging',archive='packaging-storage-rejected';
      const present=await fs.lstat(path.join(root,current)).then(()=>true,e=>{
        if(e.code==='ENOENT')return false;throw e;
      });
      const rejected=present?current:archive;
      const [stage,dynamics]=await Promise.all([
        packagingJson(root,rejected+'/stage.json'),packagingJson(root,'dynamics/stage.json')
      ]);
      const owned=value=>value?.taskId===id&&value.candidateId===job.candidateId&&value.revision===job.revision&&
        value.parentRevision===job.parentRevision&&!value.pending;
      if(!owned(stage)||!owned(dynamics)||stage.stage!=='packaging'||dynamics.stage!=='dynamics'||
        stage.status!=='failed'||dynamics.status!=='completed'||stage.inputSha256!==dynamics.inputSha256||
        stage.descriptionSha256!==dynamics.descriptionSha256||stage.deliveryFiles?.length||
        stage.unresolved?.length!==1||stage.unresolved[0].code!==job.error.code||
        stage.unresolved[0].message!==job.error.message)return;
      if(present)await fs.rename(path.join(root,current),path.join(root,archive));
      job.storageRecovery={previousError:job.error,at:new Date().toISOString(),receiptPath:path.join(root,archive,'stage.json')};
      job.status='queued';job.resumedAt=job.storageRecovery.at;delete job.pid;delete job.error;
      await this.store.write('make-'+id,job);await this.launch(job);
    });
  }
  async recoverRiggingStorage(id,ctx) {
    return this.store.lock(async()=>{
      const active=await this.store.read('maker-active'),job=await this.store.read('make-'+id);
      if(active?.id!==id||job?.id!==id||job.kind!=='single_image'||!job.notifyAutomatically||
        job.session!==this.store.session(ctx)||job.stage!=='rigging'||job.status!=='failed'||
        job.error?.code!=='ENOSPC'||job.pending||job.artifacts||job.riggingStorageRecovery||
        job.pid&&alive(job.pid)||job.pipeline?.artwork?.local?.externalSubmitted!==false||
        await this.store.read('engine-lease'))return;
      const base=path.join(this.root,'openclaw-workspace','outputs',id);
      if(!Number.isSafeInteger(job.revision)||job.revision<1)return;
      const root=job.revision===1?base:path.join(base,'revisions','r'+String(job.revision).padStart(4,'0'));
      if(job.output!==root||await fs.realpath(root)!==root)return;
      const space=await fs.statfs(root,{bigint:true});
      if(space.bavail*space.bsize<1024n*1024n*1024n)return;
      const [stage,journal]=await Promise.all([packagingJson(root,'rigging/stage.json'),packagingJson(root,'rigging/state.json')]);
      const owned=value=>value?.taskId===id&&value.candidateId===job.candidateId&&value.revision===job.revision&&
        value.parentRevision===job.parentRevision&&value.inputSha256===job.source?.inputSha256&&
        value.descriptionSha256===job.source?.descriptionSha256;
      if(!owned(stage)||!owned(journal.identity)||stage.stage!=='rigging'||stage.status!=='failed'||
        stage.pending||journal.pending||stage.unresolved?.at(-1)?.code!=='ENOSPC')return;
      let evidence;
      if(journal.failed) {
        if(!isSaveStorageFailure(journal.failed,journal.failed.terminalReceipt)||
          journal.failed.projectId!==journal.projectId||journal.failed.request.state!==journal.state||
          job.error.message!==journal.failed.error?.message)return;
      } else {
        const recovered=journal.recoveries?.at(-1);
        if(recovered?.kind!=='committed-history-reopen'||recovered.toState!==journal.state||
          recovered.archive?.projectId!==journal.projectId||!recovered.evidence)return;
        const proof=await packagingJson(root,recovered.evidence+'/result.json');
        if(proof.status!=='recovered'||proof.projectId!==journal.projectId||proof.state!==journal.state||
          proof.lastStepKey!==recovered.lastStepKey||proof.archiveSha256!==recovered.archive.sha256)return;
        evidence=recovered.evidence;
      }
      const rejected='rigging-storage-rejected.json';
      try {await fs.copyFile(path.join(root,'rigging/stage.json'),path.join(root,rejected),fs.constants.COPYFILE_EXCL);}
      catch(error) {
        if(error.code!=='EEXIST'||JSON.stringify(await packagingJson(root,rejected))!==JSON.stringify(stage))throw error;
      }
      job.riggingStorageRecovery={previousError:job.error,at:new Date().toISOString(),receiptPath:rejected,evidence};
      job.status='queued';job.resumedAt=job.riggingStorageRecovery.at;delete job.pid;delete job.error;
      await this.store.write('make-'+id,job);await this.launch(job);
    });
  }
  async replayCached(id,expectedRevision,ctx,refined) {
    if(!/^[a-f0-9-]{36}$/.test(id??'')||!ctx.sessionId||!Number.isSafeInteger(expectedRevision)||
      refined&&(!Number.isSafeInteger(refined.revision)||refined.revision<=expectedRevision||!/^[a-f0-9]{64}$/.test(refined.artworkSha256??'')))
      fail('INVALID_JOB','需要原任务编号、父版编号和完整原会话身份');
    return this.store.lock(async()=>{
      const job=await this.store.read('make-'+id);
      if(!job||job.session!==this.store.session(ctx))fail('SESSION_MISMATCH','请在原制作会话继续');
      if(job.cachedReplay?.parentRevision===expectedRevision&&(!refined||
        job.revision===refined.revision&&job.cachedReplay.refinedArtworkSha256===refined.artworkSha256))return this.making(id,ctx);
      if(job.kind!=='single_image'||job.status!=='completed'||job.revision!==expectedRevision||
        !job.notifyAutomatically||job.pending||job.pid&&alive(job.pid))
        fail('CACHE_REPLAY_NOT_READY','指定父版尚未完成，或当前已经有更新的修订');
      const active=await this.store.read('maker-active');
      if(await this.store.read('engine-lease')||active&&active.id!==id&&!await this.mayYield(await this.store.read('make-'+active.id)))
        fail('MAKER_BUSY','已有制作任务占用引擎，保留原任务');
      let parentRevision=job.revision;
      if(refined) {
        const revisions=path.join(this.root,'openclaw-workspace','outputs',id,'revisions');
        const at=revision=>path.join(revisions,'r'+String(revision).padStart(4,'0'));
        const output=at(refined.revision);
        const stage=await packagingJson(output,'artwork/stage.json');
        const own=b=>b.taskId===id&&b.candidateId===job.candidateId&&
          b.inputSha256===job.source.inputSha256&&b.descriptionSha256===job.source.descriptionSha256;
        parentRevision=stage.parentRevision;
        if(!own(stage)||stage.revision!==refined.revision||!Number.isSafeInteger(parentRevision)||
          parentRevision<=0||parentRevision>=refined.revision)
          fail('CACHE_REPLAY_MISMATCH','精修候选不属于本原任务');
        const ancestor=await packagingJson(at(parentRevision),'artwork/stage.json');
        if(!own(ancestor)||ancestor.revision!==parentRevision)
          fail('CACHE_REPLAY_MISMATCH','精修候选父版不属于本原任务');
        const refinedJob={...job,revision:refined.revision,parentRevision};
        if(!await passedFinalPreviewReview(output,refinedJob))
          fail('FINAL_PREVIEW_REVIEW_REQUIRED','精修续跑需要该版最终原片的原速验收回执');
        const dynamics=await packagingJson(output,'dynamics/stage.json');
        if(!own(dynamics)||dynamics.revision!==refined.revision||dynamics.parentRevision!==parentRevision||
          dynamics.status!=='completed'||dynamics.unresolved?.length)
          fail('CACHE_REPLAY_NOT_READY','精修续跑需要同版已通过的动态检查点');
        const manifest=await packagingJson(output,dynamics.dynamicsManifestPath);
        const hd=await buildHdPreview({root:this.root,taskRoot:output,dynamics,manifest});
        const video=hd.artifacts.find(a=>a.path===hd.videoPath);
        if(!hd.reused||!await passedFinalPreviewReview(output,refinedJob,{...video,videoPath:hd.videoPath,duration:hd.frameCount/hd.fps}))
          fail('FINAL_PREVIEW_REVIEW_REQUIRED','精修续跑的已审成片与当前模型、动作或物理不符');
      }
      const archived=path.join(job.output,'completed-job-before-cache-replay.json');
      try {await fs.writeFile(archived,JSON.stringify(job,null,2)+'\n',{flag:'wx',mode:0o600});}
      catch(e) {if(e.code!=='EEXIST'||JSON.stringify(JSON.parse(await fs.readFile(archived,'utf8')))!==JSON.stringify(job))throw e;}
      const {output,revision,cache}=await prepareCachedReplay(this.root,job,refined&&{...refined,parentRevision});
      const next={id,kind:job.kind,session:job.session,sessionContext:job.sessionContext,notifyAutomatically:true,
        candidateId:job.candidateId,revision,parentRevision,request:job.request,source:job.source,
        output,status:'queued',stage:'queued',steps:[],startedAt:new Date().toISOString(),cachedReplay:cache};
      await this.store.write('make-'+id,next);await this.store.write('maker-active',{id});await this.launch(next);
      return {ok:true,jobId:id,candidateId:next.candidateId,revision,status:'queued'};
    });
  }
  async recoverFinalPreview(job) {
    const isPending=j=>j?.status==='blocked'&&j.stage==='packaging'&&j.error?.code==='FINAL_PREVIEW_REVIEW_REQUIRED'&&
      j.pipeline?.packaging?.finalPreviewReview?.status==='pending'&&!j.pending&&!(j.pid&&alive(j.pid));
    if(!isPending(job)||!await passedFinalPreviewReview(job.output,job,job.pipeline.packaging.finalPreviewReview))return;
    return this.store.lock(async()=>{
      const current=await this.store.read('make-'+job.id),active=await this.store.read('maker-active');
      if(active?.id!==job.id||current?.revision!==job.revision||current.output!==job.output||!isPending(current)||
        !await passedFinalPreviewReview(current.output,current,current.pipeline.packaging.finalPreviewReview))return;
      current.status='queued';current.resumedAt=new Date().toISOString();delete current.pid;
      await this.store.write('make-'+current.id,current);await this.launch(current);
    });
  }
  async recoverAutomaticReview() {
    const active=await this.store.read('maker-active');
    if(!active?.id)return;
    const job=await this.store.read('make-'+active.id);
    const ctx=job?.sessionContext;
    // Recover only proven local checkpoints. Never repeat an unknown submission.
    if(job?.id!==active.id||job.kind!=='single_image'||!job.notifyAutomatically||
      job.pending||job.pid&&alive(job.pid)||
      !ctx?.sessionId||!/^agent:live2d-streamer:dashboard:[a-z0-9-]+$/.test(ctx.sessionKey)||
      job.session!==this.store.session(ctx))return;
    if(job.status==='blocked'&&job.stage==='packaging'&&job.error?.code==='FINAL_PREVIEW_REVIEW_REQUIRED')
      return this.recoverFinalPreview(job);
    if(job.status==='failed'&&job.stage==='packaging')return job.error?.code==='ENOSPC'?
      this.recoverPackageStorage(job.id,ctx):this.recoverPresetPreflight(job.id,ctx);
    if(job.status==='failed'&&job.stage==='rigging'&&job.error?.code==='ENOSPC')
      return this.recoverRiggingStorage(job.id,ctx);
    if(job.status!=='running'||job.stage!=='dynamics'||!job.pid)return;
    const {pipeline}=job;
    if(pipeline?.artwork?.local?.externalSubmitted!==false||await this.store.read('engine-lease'))return;
    const read=async rel=>{
      const file=path.join(job.output,rel);
      if(await fs.realpath(file)!==file||!(await fs.lstat(file)).isFile())return null;
      return JSON.parse(await fs.readFile(file,'utf8'));
    };
    const [stage,journal]=await Promise.all([
      read('dynamics/stage.json'),read('dynamics/preview/engine-journal.json')
    ]).catch(e=>{if(e.code==='ENOENT')return [];throw e;});
    const owned=value=>value?.taskId===job.id&&value.candidateId===job.candidateId&&value.revision===job.revision&&!value.pending;
    if(!owned(stage)||stage.status!=='blocked'||stage.previewCapture?.status!=='captured'||
      !stage.unresolved?.some(issue=>issue.code==='DYNAMICS_VISUAL_NOT_RUN')||!owned(journal)||journal.status!=='captured')return;
    return this.resume(job.id,ctx);
  }
  async resume(id,ctx,visualReview,reviewOnly=false) {
    if(!/^[a-f0-9-]{36}$/.test(id??''))fail('INVALID_JOB','制作任务 ID 无效');
    return this.store.lock(async()=>{
      const job=await this.store.read('make-'+id);
      if(!job)fail('UNKNOWN_JOB','未找到本项目制作任务');
      if(job.session!==this.store.session(ctx))fail('SESSION_MISMATCH','制作任务属于另一个会话');
      if(job.kind!=='single_image')fail('RESUME_UNSUPPORTED','此入口仅继续原单图候选，不重做登记PSD任务');
      const active=await this.store.read('maker-active');
      if(active&&active.id!==id&&!await this.mayYield(await this.store.read('make-'+active.id)))fail('MAKER_BUSY','另一制作任务持有调度，请先查询原任务',{jobId:active.id});
      if(job.status==='completed'||job.pid&&alive(job.pid))return this.making(id,ctx);
      const correction=job.status==='failed'&&await canResumeFailedFlash(this.root,job);
      if(job.status==='failed'&&!correction)return this.making(id,ctx);
      if(!correction&&!['queued','awaiting_external_result','blocked','needs_input','running'].includes(job.status))fail('RESUME_UNSUPPORTED','此状态不能继续，需先补齐原任务输入');
      if(visualReview!==undefined) {
        const reviewed=await recordNativeReview(job,visualReview);
        if(reviewed.status!=='completed'||reviewOnly) {
          job.status=reviewed.status==='completed'?'blocked':reviewed.status;
          const issue=reviewed.unresolved.at(-1);
          job.error=reviewed.status==='completed'
            ?{code:'VISUAL_REVIEW_RECORDED',message:'本阶段审查已保存；等待明确继续原候选，尚未完成全部制作。'}
            :{code:issue?.code??'VISUAL_REVIEW_FAILED',message:issue?.message??'审查未通过'};
          if(reviewOnly)job.pipeline={...job.pipeline,[job.stage]:{...job.pipeline?.[job.stage],status:reviewed.status}};
          await this.store.write('make-'+id,job);
          if(reviewOnly)return {...await this.making(id,ctx),reviewRecorded:{stage:job.stage,status:reviewed.status}};
          if(!localRepairCriteria(reviewed).length&&!await hasReviewedRigRepair(job,reviewed,RIG_REPAIR_PROFILE))return this.making(id,ctx);
        }
      }
      // Keep the immutable input/candidate and external operation receipts. The
      // stage modules recover the original operation or revalidate saved input;
      // unresolved user decisions stay unresolved and unknown calls are not repeated.
      job.status='queued';job.resumedAt=new Date().toISOString();delete job.pid;
      await this.store.write('make-'+id,job);await this.store.write('maker-active',{id});await this.launch(job);
      return {ok:true,jobId:id,candidateId:job.candidateId,revision:job.revision,status:'queued',message:'已继续原候选；沿原回执查询，不重复提交未知生成。请用 avatar_making 查询。'};
    });
  }
  async make(materialId,ctx) {
    const session=this.store.session(ctx);
    return this.store.lock(async()=>{
      const previous=await this.store.read('maker-active');
      if(previous) {
        const job=await this.store.read('make-'+previous.id);
        if(ctx.callId&&job?.callId===ctx.callId&&job.session===session) return this.making(job.id,ctx);
        if(job && !['completed','failed'].includes(job.status)) fail('MAKER_BUSY','原制作任务仍在运行或结果未知，请先查询原任务',{jobId:job.id});
      }
      const catalog=await this.materials(),material=catalog.materials.find(m=>m.id===materialId);
      if(!material?.valid) fail('MATERIAL_NOT_APPROVED','素材尚未登记许可、缺失或哈希不符');
      if(!catalog.engine.built) fail('MAKER_NOT_BUILT','PSD2Live 本机构建尚未完成');
      const id=randomUUID(),output=path.join(this.root,'openclaw-workspace','outputs',id);
      const job={id,session,callId:ctx.callId,materialId,status:'queued',stage:'queued',output,startedAt:new Date().toISOString(),steps:[]};
      await fs.mkdir(output,{recursive:true});
      await this.store.write('make-'+id,job);await this.store.write('maker-active',{id});
      await this.launch(job);
      return {ok:true,jobId:id,status:'queued',output,message:'已接单；请用 avatar_making 查询真实导出结果。'};
    });
  }
  async run(action,p,ctx) {
    try {
      if(action==='materials') return await this.materials();
      if(action==='make') {
        if([p.material_id,p.image_ref,p.resume_job_id].filter(Boolean).length!==1)fail('INPUT_INVALID','请选择登记素材、单图制作或继续原任务中的一种');
        if(p.visual_review!=null&&!p.resume_job_id)fail('INPUT_INVALID','审查只接入原任务');
        if(p.review_only!=null&&typeof p.review_only!=='boolean'||p.review_only===true&&(!p.resume_job_id||p.visual_review==null))
          fail('INPUT_INVALID','review_only 仅可与原 resume_job_id 及实际 visual_review 一起使用');
        if(p.resume_job_id)return await this.resume(p.resume_job_id,ctx,p.visual_review??undefined,p.review_only===true);
        return p.image_ref?await this.makeImage({imageRef:p.image_ref,description:p.description,rights:p.rights},ctx):await this.make(p.material_id,ctx);
      }
      if(action==='making') return await this.making(p.job_id,ctx);
      fail('UNKNOWN_ACTION','未知制作操作');
    } catch(e) {return {ok:false,code:e.code??'MAKER_INTERNAL',message:e instanceof Fault||e.code==='RIG_REVIEW_INVALID'?e.message:'制作操作失败，请检查本机配置',...e.details};}
  }
}

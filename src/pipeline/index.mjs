import * as fs from 'node:fs/promises';
import path from 'node:path';
import {prepareInput} from '../intake/index.mjs';
import {buildArtwork,createSeeThroughBackend,createRunningHubLayeredBackend} from '../artwork/index.mjs';
import {FLASH_ROUTE,flashRequestFromQuote} from '../artwork/runninghub-layered.mjs';
import {readJson} from '../artwork/files.mjs';
import {archiveFlashFailure,correctionOperation,inspectFlashCorrection} from './flash-correction.mjs';
import {prepareFlashIntake} from './flash-intake.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {ImageInbox} from './attachments.mjs';
import {createCodexVision} from './codex-vision.mjs';
import {advanceModelPipeline} from './model-stages.mjs';
import {loadLocalArtwork,LOCAL_ARTWORK_ID} from '../artwork/local-artwork.mjs';
import {flatPortraitIntake,loadFlatPortrait,wantsFlatPortrait} from '../artwork/flat-portrait.mjs';
import {loadAnimePortrait,wantsAnimePortrait} from '../artwork/anime-portrait.mjs';
import {reviewAnimeArtwork} from './anime-artwork-review.mjs';
import {reviewAnimeRender} from './anime-render-review.mjs';
import {analyzeVisibleAnimeParts,refineVisibleEyes} from '../artwork/anime-semantic-masks.mjs';
import {loadRefinedArtworkCheckpoint,reuseReplayReview,verifyReplayCache} from './cached-replay.mjs';

// Shared production path. Stage modules keep their exclusive ownership.
export async function runImagePipeline(job,{root,store,vision,prepare=prepareInput,artwork=buildArtwork,artworkBackend,artworkPolicy,artworkCredentials={},artworkCredentialResolver,artworkRequest,engine,modelStages=advanceModelPipeline}={}) {
  const recordTiming=async (name,operation,start,status)=>{
    job.steps.push({name,operation,status,startedAt:start.at,finishedAt:new Date().toISOString(),
      elapsedMs:Math.round(performance.now()-start.tick)});
    await store.write('make-'+job.id,job);
  };
  const checkpoint=async patch=>{
    job.pipeline??={};job.pipeline[patch.stage??job.stage]=patch;
    if(patch.operation)job.pending={operation:'codex_visual_intake',...patch.operation};
    else if(patch.operationKey)job.pending={operation:patch.stage,...patch};
    await store.write('make-'+job.id,job);
  };
  if(job.cachedReplay)await verifyReplayCache(job);
  const refinedReplay=Object.hasOwn(job.cachedReplay??{},'refinedArtworkSha256');
  const flat=!job.cachedReplay&&!job.localArtwork&&wantsFlatPortrait(job.request?.description);
  const anime=!job.localArtwork&&!flat&&wantsAnimePortrait(job.request?.description);
  const localComplex=Boolean(job.cachedReplay)||!job.localArtwork&&!flat&&job.notifyAutomatically&&/全程在本机|只在本机|仅在本机|不要外发/u.test(job.request?.description??'');
  // A saved response still goes through Intake's exact image/text validation.
  // Do not start or poll a remote provider for a local-only request.
  const hasLocalBrief=localComplex&&Boolean(await readJson(job.output,'intake/vision-response.json'));
  const backend=job.localArtwork||localComplex?{}:flat?flatPortraitIntake(job.output):vision??createCodexVision({taskRoot:job.output});
  const ctx={root,taskRoot:job.output,taskId:job.id,candidateId:job.candidateId,revision:job.revision,parentRevision:job.parentRevision??null,
    ...(job.riggingStorageRecovery?{riggingStorageRecovery:job.riggingStorageRecovery}:{}),
    normalizeOnly:localComplex&&!hasLocalBrief,
    checkpoint,progress:async p=>{job.stage=p.stage;await store.write('make-'+job.id,job);},
    resolveImage:(ref,{taskRoot})=>new ImageInbox(root).resolve(ref,job.sessionContext,taskRoot),
    engine,recordTiming,describeImage:backend.describeImage,
    stageCompleted:stage=>{job.pipeline[stage]={status:'completed',bundlePath:stage+'/stage.json'};},
    recoverDescription:backend.recoverDescription?async request=>{const r=await backend.recoverDescription(request);return r?.status==='completed'?r.response:null;}:undefined};
  job.stage='intake';await store.write('make-'+job.id,job);
  const intakeStart={at:new Date().toISOString(),tick:performance.now()};
  const input=await prepare(job.request,ctx);
  job.pipeline??={};job.pipeline.intake={status:input.status,bundlePath:'intake/stage.json'};
  await recordTiming('intake','prepareInput',intakeStart,input.status);
  if(refinedReplay&&input.status!=='completed') {
    job.status='blocked';job.error={code:'CACHE_REPLAY_MISMATCH',message:'精修续跑缺少已完成的原始图文检查点'};
    await store.write('make-'+job.id,job);
    return input;
  }
  if(localComplex&&input.status==='normalized') {
    job.source={kind:'single_image',inputSha256:input.inputSha256,normalizedSha256:input.sourceImage.sha256,descriptionSha256:input.descriptionSha256,rights:input.rights};
    job.stage='artwork';job.status='running';delete job.pending;
    await store.write('make-'+job.id,job);
    const start={at:new Date().toISOString(),tick:performance.now()};
    let diagnostic,error;
    try {
      const masks=await analyzeVisibleAnimeParts(root,job.output,input);
      diagnostic={receiptPath:masks.receiptPath,parts:masks.parts.map(part=>part.id),cacheHit:masks.cacheHit};
      const detail=await refineVisibleEyes(job.output,input,masks).catch(()=>null);
      if(detail)diagnostic.eyeDetails={receiptPath:detail.receiptPath,parts:detail.parts.map(part=>part.semantic)};
      const observed=detail?.parts.length?`，并生成 ${detail.parts.length} 个待校验的眼口细节候选`:'';
      error={code:'LOCAL_COMPLEX_ARTWORK_INCOMPLETE',message:`本机分出 ${masks.parts.length} 类可见部件${observed}。完整闭眼和开闭口素材、遮挡下的发际与肩袖，以及挥手关节定位还未完成。当前素材无法进入正式绑定。`};
    } catch(e) {
      error={code:'LOCAL_SEMANTIC_MASKS_UNAVAILABLE',message:'本机复杂图分割未取得可用结果，原图与需求已保留。'};
      await fs.writeFile(path.join(job.output,'artwork-diagnostic-error.json'),
        JSON.stringify({code:e.code??'LOCAL_PROCESS_ERROR',detail:e.stderr?.trim().split('\n').at(-1)??e.message})+'\n',{mode:0o600});
    }
    job.status='blocked';job.error=error;job.pipeline.artwork={status:'blocked',submitted:false,diagnostic,error};
    await recordTiming('artwork','localSemanticMasks',start,diagnostic?'diagnostic_completed':'blocked');
    return {...input,status:'blocked',stage:'artwork',error};
  }
  if(input.status!=='completed') {
    job.status=input.status;
    const questions=(input.unresolved??[]).map(({code,message})=>({code,message})).filter(i=>i.message);
    job.error=input.error??{code:'INPUT_UNRESOLVED',message:questions.map(i=>i.message).join('；')||'图片制作需求仍有待处理项'};
    if(questions.length)job.error={...job.error,unresolved:questions};
    if(!['submitted','unknown'].includes(input.operation?.status))delete job.pending;
    await store.write('make-'+job.id,job);return input;
  }
  delete job.pending;delete job.error;
  if(refinedReplay) {
    const artworkStart={at:new Date().toISOString(),tick:performance.now()};
    const result=await loadRefinedArtworkCheckpoint(job,input,ctx);
    job.stage='artwork';job.status='running';
    job.pipeline.artwork={status:result.status,bundlePath:'artwork/stage.json',refinedArtworkSha256:job.cachedReplay.refinedArtworkSha256};
    await recordTiming('artwork','load_refined_artwork_checkpoint',artworkStart,result.status);
    return finishArtwork(result);
  }
  job.source={kind:'single_image',inputSha256:input.inputSha256,normalizedSha256:input.sourceImage.sha256,descriptionSha256:input.descriptionSha256,rights:input.rights};
  job.stage='artwork';job.status='running';await store.write('make-'+job.id,job);
  if(artworkPolicy===undefined) {
    try {artworkPolicy=JSON.parse(await fs.readFile(path.join(root,'config/project.json'),'utf8')).singleImage?.artwork;}
    catch(e) {if(e.code!=='ENOENT')throw e;}
  }
  let operationPath='artwork/operation.json',operation=await readJson(job.output,operationPath);
  const corrected=await readJson(job.output,correctionOperation);
  let localBlocked,localBackend;
  if(job.localArtwork||flat||anime||localComplex) {
    const started={at:new Date().toISOString(),tick:performance.now()};
    try {
      if(corrected||operation&&operation.backend?.id!==LOCAL_ARTWORK_ID)throw new Error('已有其他后台作业，必须保留原回执');
      localBackend=anime||localComplex?await loadAnimePortrait(root,job.output,input,{localOnly:localComplex,cacheOnly:Boolean(job.cachedReplay)}):
        flat?await loadFlatPortrait(job.output,input):await loadLocalArtwork(job.output,job.localArtwork,input);
      artworkBackend=localBackend;
    } catch(e){localBlocked={code:anime||localComplex?'ANIME_ARTWORK_INCOMPLETE':'LOCAL_ARTWORK_BINDING_INVALID',message:e.message};}
    if(anime||localComplex)await recordTiming('artwork','compile_source_layers',started,localBlocked?'blocked':'completed');
  }
  if(operation)job.pending={operation:'artwork',operationKey:operation.operationKey,jobId:operation.jobId,status:operation.status};
  const savedBackend=operation?.backend?.id;
  const storedProviders={'runninghub-standard-flash':'runninghub','runninghub-layered-app':'runninghub','see-through-gradio':'see-through'};
  const selectedProvider=savedBackend?storedProviders[savedBackend]:artworkPolicy?.provider;
  const runningHub=!artworkBackend&&selectedProvider==='runninghub';
  const pollIntervalMs=artworkPolicy?.pollIntervalMs??5000,maxWaitMs=artworkPolicy?.maxWaitMs??120000;
  // An existing provider operation must recover with its recorded adapter.
  const flash=runningHub&&(savedBackend?savedBackend==='runninghub-standard-flash':artworkPolicy?.route===FLASH_ROUTE);
  // The default native rig authors wave, plus the built-in idle/reset behaviors.
  // Keep saved provider operations recoverable and preserve the original brief.
  const unboundActions=flash&&!operation&&!corrected
    ? (input.brief?.intent?.actions??[]).filter(a=>a.source==='user'&&!['wave','idle','breath','reset','待机','呼吸'].includes(a.id))
    : [];
  let flashQuote,blocked,waveAuthorization;
  let budgetAuthorized=artworkPolicy?.budgetAuthorized===true;
  if(job.localArtwork||flat||anime||localComplex)blocked=localBlocked; // Never authorize or fall back to an external backend.
  else if(artworkPolicy?.enabled!==true)blocked={code:'ARTWORK_BACKEND_PAUSED',message:artworkPolicy?.reason??'尚未登记可用的拆分补绘后台；输入分析已保存，不提交生成'};
  else if(unboundActions.length)blocked={code:'DYNAMICS_ACTION_UNAVAILABLE',
    message:`当前原生单图流程缺少动作绑定配方：${unboundActions.map(a=>a.label).join('、')}。已保留需求，本次未向素材提供方上传或提交。`,actions:unboundActions};
  else if(!flash&&!operation&&input.brief?.externalApprovalNotes?.length)blocked={
    code:'ARTWORK_EXTERNAL_APPROVAL_REQUIRED',message:'已保留外发与费用限制。当前素材后台没有本候选的授权，尚未提交。'};
  else if(!artworkBackend&&!['runninghub','see-through'].includes(selectedProvider))blocked={code:'ARTWORK_BACKEND_UNSUPPORTED',message:'未配置受支持的拆分后台；不回退到其他提供方'};
  else if(runningHub) {
    if(!artworkCredentials.runninghub&&artworkCredentialResolver) {
      artworkCredentials={...artworkCredentials,runninghub:await artworkCredentialResolver()};
    }
    if(!savedBackend&&artworkPolicy.route&&artworkPolicy.route!==FLASH_ROUTE)blocked={code:'ARTWORK_BACKEND_UNSUPPORTED',message:'未识别 RunningHub 配方'};
    if(flash) {
      const auth=artworkPolicy.flashAuthorization;
      const scoped=auth&&auth.taskId===job.id&&auth.candidateId===job.candidateId&&auth.revision===job.revision;
      if(corrected||scoped&&auth.uploadCorrection&&operation?.status==='failed') {
        const proof=await inspectFlashCorrection({root,job,input,policy:artworkPolicy,operation});
        if(!proof)blocked={code:'FLASH_CORRECTION_IDENTITY_MISMATCH',message:'未核实本候选原 Flash 文件下载超时的终态回执和纠正授权，保留已有作业。'};
        else if(!corrected&&!budgetAuthorized)blocked={code:'BACKEND_BUDGET_NOT_AUTHORIZED',message:'本候选尚未授权上传纠正与同配方生成。'};
        else {
          await archiveFlashFailure(job.output,proof);
          operationPath=correctionOperation;ctx.artworkOperationPath=operationPath;operation=corrected;
          if(operation)job.pending={operation:'artwork',operationKey:operation.operationKey,jobId:operation.jobId,status:operation.status};
          else delete job.pending;
          const prepared=await prepareFlashIntake({root,job,input,policy:{allowUploadForQuote:true,maxUnitFen:11,maxEstimatedTotalFen:187},
            correction:proof,apiKey:artworkCredentials.runninghub,request:artworkRequest,operation});
          ({flashQuote,budgetAuthorized,blocked}=prepared);waveAuthorization=auth;
        }
      } else if(scoped) {
        try {flashQuote=await readJson(root,auth.quotePath);flashRequestFromQuote(flashQuote,input.inputSha256);waveAuthorization=auth;}
        catch {blocked={code:'FLASH_QUOTE_MISMATCH',message:'原图或配方与本次标准 Flash 报价不匹配'};}
      } else {
        const prepared=await prepareFlashIntake({root,job,input,policy:artworkPolicy.flashIntake,apiKey:artworkCredentials.runninghub,request:artworkRequest,operation});
        ({flashQuote,budgetAuthorized,blocked}=prepared);
      }
    }
    if(!Number.isInteger(pollIntervalMs)||pollIntervalMs<1000||pollIntervalMs>60000||!Number.isInteger(maxWaitMs)||maxWaitMs<10||maxWaitMs>600000)blocked={code:'ARTWORK_WAIT_POLICY_INVALID',message:'查询频率或总等待期限配置无效'};
    else if(!blocked&&!operation) {
      if(!budgetAuthorized)blocked={code:'BACKEND_BUDGET_NOT_AUTHORIZED',message:'等待本应用与配方的可靠报价或费用封顶及预算授权；不上传或生成'};
      else if(!flash&&artworkPolicy.allowUnpinnedModel!==true)blocked={code:'BACKEND_MODEL_UNPINNED',message:'应用模型版本尚未固定；需要明确接受后才能首次提交'};
      else if(!artworkCredentials.runninghub)blocked={code:'BACKEND_AUTH_REQUIRED',message:'尚未向制作进程注入内存凭据'};
    }
  }
  if(blocked) {
    if(blocked.code==='BACKEND_AUTH_REQUIRED')blocked={...blocked,message:'请在本机为制作进程配置 RUNNINGHUB_API_KEY，或在登录钥匙串添加项目 live2d-streamer.runninghub、账户 live2d-streamer，随后继续本任务。'};
    job.status='blocked';job.error=blocked;
    job.pipeline.artwork={status:'blocked',...(operation?{receiptPreserved:true}:{submitted:false}),error:job.error};
    await fs.writeFile(path.join(job.output,'输入链路状态.json'),JSON.stringify({taskId:job.id,candidateId:job.candidateId,intake:input.status,artwork:'blocked',nextStage:'artwork',modelComplete:false},null,2)+'\n');
    await store.write('make-'+job.id,job);return input;
  }
  if(flash)ctx.artworkLabelVision=createCodexVision({taskRoot:job.output,scope:'layer_labels'});
  if(waveAuthorization)ctx.waveAuthorization=waveAuthorization;
  else if(flash&&artworkPolicy.useIncludedChatGptWaveForRequestedGesture===true&&input.brief?.intent?.actions?.some(a=>a.id==='wave'&&a.source==='user')) {
    ctx.waveAuthorization={taskId:job.id,candidateId:job.candidateId,revision:job.revision,codexWaveEdit:true,includedOnly:true};
  }
  ctx.artworkBackend=artworkBackend??(runningHub?createRunningHubLayeredBackend({stateDir:path.join(job.output,'artwork/backend'),apiKey:artworkCredentials.runninghub,flashQuote,
    budgetAuthorized,allowUnpinnedModel:artworkPolicy.allowUnpinnedModel===true,layers:artworkPolicy.layers??4,seed:artworkPolicy.seed??'40081411804039',
    pollIntervalMs,...(artworkRequest?{request:artworkRequest}:{})}):createSeeThroughBackend({stateDir:path.join(job.output,'artwork/backend')}));
  let result,timer;const controller=runningHub?new AbortController():null;
  const artworkStart={at:new Date().toISOString(),tick:performance.now()};
  if(controller){ctx.signal=controller.signal;timer=setTimeout(()=>controller.abort(new Error('ARTWORK_WAIT_EXPIRED')),maxWaitMs);}
  try {
    result=await artwork(input,ctx);
    if(runningHub) {
      // Only a durable running task is polled. Never restart submission on timeout/unknown.
      while(result.status==='awaiting_external_result'&&['ARTWORK_PENDING','CODEX_WAVE_PENDING'].includes(result.unresolved?.at(-1)?.code)) {
        const saved=JSON.parse(await fs.readFile(path.join(job.output,operationPath),'utf8'));
        if(!saved.jobId||saved.status!==(result.unresolved.at(-1).code==='CODEX_WAVE_PENDING'?'completed':'running'))break;
        await delay(pollIntervalMs,undefined,{signal:ctx.signal});
        result=await artwork(input,ctx);
      }
    } else if(result.status==='awaiting_external_result') {
      // Legacy SSE resumes the original receipt once; it never creates another event.
      const saved=JSON.parse(await fs.readFile(path.join(job.output,operationPath),'utf8'));
      if(saved.status==='running'&&saved.jobId)result=await artwork(input,ctx);
    }
  } catch(e) {
    if(!controller?.signal.aborted)throw e;
    result={status:'awaiting_external_result',unresolved:[{code:'ARTWORK_WAIT_EXPIRED',message:'本次等待已到期；保留原任务回执供恢复查询，远端未取消且结果仍待确认'}]};
  } finally {clearTimeout(timer);delete ctx.signal;}
  if((job.cachedReplay||anime&&!localComplex)&&result.unresolved?.some(i=>i.code==='ARTWORK_VISUAL_REVIEW_REQUIRED')) {
    const started={at:new Date().toISOString(),tick:performance.now()};
    try {result=job.cachedReplay?await reuseReplayReview(job,'artwork'):await reviewAnimeArtwork(result,ctx);}
    catch(e) {
      result={...result,unresolved:[{code:e.code??'ANIME_ARTWORK_REVIEW_UNAVAILABLE',message:'同版静态审查未能确认，拆层和审查回执已保留：'+e.message}]};
    }
    await recordTiming('artwork',job.cachedReplay?'cached_static_artwork_review':'codex_static_artwork_review',started,result.status);
  }
  job.pipeline.artwork={status:result.status,bundlePath:'artwork/stage.json'};
  if(localBackend) {
    const saved=await readJson(job.output,operationPath);
    const manifest=result.artworkManifestPath&&await readJson(job.output,result.artworkManifestPath);
    if(saved?.backend?.id===LOCAL_ARTWORK_ID&&saved.status==='completed')delete job.pending;
    job.pipeline.artwork.local={provider:LOCAL_ARTWORK_ID,manifestSha256:(job.localArtwork??localBackend.marker).manifestSha256,externalSubmitted:false,
      ...(flat||anime||localComplex?{automaticDecomposition:true,processorSha256:localBackend.recipe.processorSha256}:{}),
      receiptStatus:saved?.status??null,missingSemantics:manifest?.missingSemantics??[]};
  }
  await recordTiming('artwork','buildArtwork_including_provider_wait',artworkStart,result.status);
  return finishArtwork(result);

  async function finishArtwork(result) {
    if(result.status!=='completed') {
      job.status=result.status;
      const issue=result.unresolved?.at(-1);job.error={code:issue?.code??'ARTWORK_UNRESOLVED',message:issue?.message??'拆分补绘未完成；没有生成模型包'};
    } else {
      delete job.pending;
      if(job.cachedReplay&&!refinedReplay)ctx.reviewRenderedStage=bundle=>reuseReplayReview(job,bundle.stage);
      else if(anime&&!localComplex)ctx.reviewRenderedStage=bundle=>reviewAnimeRender(bundle,job,root);
      const model=await modelStages(result,ctx);
      job.status=model.status;job.stage=model.stage;job.error=model.error;
      const finalPreviewReview=model.bundle?.finalPreviewReview;
      job.pipeline[model.stage]={status:model.status,
        ...(finalPreviewReview&&model.status==='blocked'&&finalPreviewReview.status!=='passed'
          ?{finalPreviewReview}:{bundlePath:model.stage+'/stage.json',...(finalPreviewReview?{finalPreviewReview}:{})})};
      if(model.status==='completed') {
        job.artifacts={packageBundlePath:'packaging/stage.json',packagePath:model.bundle.packagePath,deliveryFiles:model.bundle.deliveryFiles};
        job.completedAt=new Date().toISOString();
        job.acceptance={packageFiles:'passed',runtime:'not_verified',cameraTracking:'not_verified',userAccepted:false};
      }
    }
    await fs.writeFile(path.join(job.output,'输入链路状态.json'),JSON.stringify({taskId:job.id,candidateId:job.candidateId,intake:input.status,artwork:result.status,nextStage:job.stage,modelComplete:job.status==='completed'},null,2)+'\n');
    await store.write('make-'+job.id,job);return result;
  }
}

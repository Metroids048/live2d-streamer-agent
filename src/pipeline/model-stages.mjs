import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Fault} from '../rpc.mjs';
import {buildRig} from '../rigging/index.mjs';
import {buildDynamics,captureDynamicsPreview} from '../dynamics/index.mjs';
import {buildPackage} from '../packaging/index.mjs';

const keys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
export async function savedStage(stage,input,ctx,expectedSha256) {
  const directory=path.join(ctx.taskRoot,stage),file=path.join(directory,'stage.json');
  let bytes;
  try {
    if(await fs.realpath(directory)!==directory||await fs.realpath(file)!==file)throw new Fault('REFERENCE_INVALID','阶段路径含链接');
    bytes=await fs.readFile(file);
  } catch(e) {if(e.code==='ENOENT')return null;throw e;}
  if(expectedSha256&&createHash('sha256').update(bytes).digest('hex')!==expectedSha256)
    throw new Fault('CACHE_REPLAY_MISMATCH','精修素材检查点已改变');
  const bundle=JSON.parse(bytes);
  if(bundle.schemaVersion!==1||bundle.stage!==stage||keys.some(k=>bundle[k]!==input[k]))
    throw new Fault('PIPELINE_IDENTITY_MISMATCH','已保存阶段不属于当前候选，保留原记录');
  if(bundle.status==='completed') {
    if(!Array.isArray(bundle.artifacts)||!Array.isArray(bundle.checks)||!Array.isArray(bundle.unresolved)||bundle.unresolved.length||bundle.checks.some(c=>['failed','blocked'].includes(c.status)))
      throw new Fault('REFERENCE_INVALID','已保存阶段仍有未处理阻点');
    for(const a of bundle.artifacts) {
      if(typeof a.path!=='string'||path.isAbsolute(a.path)||a.path.split(/[\\/]/).some(p=>p==='..'||p==='.'||!p))throw new Fault('REFERENCE_INVALID','阶段文件路径无效');
      const file=path.join(ctx.taskRoot,a.path);
      if(await fs.realpath(file)!==file||!(await fs.lstat(file)).isFile())throw new Fault('REFERENCE_INVALID','阶段文件不是本任务普通文件');
      const data=await fs.readFile(file);
      if(data.length!==a.bytes||createHash('sha256').update(data).digest('hex')!==a.sha256)throw new Fault('REFERENCE_INVALID','已保存阶段文件哈希已改变');
    }
  }
  return bundle;
}

// Stage boundaries stay explicit. No editor handle means no model mutation;
// visual review is recorded by each module's review API, never auto-passed here.
export async function advanceModelPipeline(artwork,ctx,{
  rig=buildRig,dynamics=buildDynamics,preview=captureDynamicsPreview,packageModel=buildPackage,
  loadStage=savedStage
}={}) {
  if(artwork.stage!=='artwork'||artwork.status!=='completed')
    throw new Fault('ARTWORK_NOT_READY','只有已完成的真实分层素材才能进入建模');
  const available=typeof ctx.withEngine==='function'||typeof ctx.engine?.call==='function';
  const timed=async(stage,operation,work)=>{
    if(!ctx.recordTiming)return work();
    const start={at:new Date().toISOString(),tick:performance.now()};
    let status='failed';
    try {const value=await work();status=value?.status??'returned';return value;}
    finally {await ctx.recordTiming(stage,operation,start,status);}
  };
  const invoke=async(stage,input,work)=>{
    const context=stage==='dynamics'?{...ctx,recoverDynamics:true}:ctx;
    const operation=work===preview?'capture_preview':stage==='rigging'?'build_rig':'export_dynamics';
    return ctx.withEngine?ctx.withEngine(stage,input,context,c=>timed(stage,operation,()=>work(input,c))):
      timed(stage,operation,()=>work(input,context));
  };
  let current=artwork;
  for(const [stage,build] of [['rigging',rig],['dynamics',dynamics],['packaging',packageModel]]) {
    let next=await timed(stage,'check_saved_stage',async()=>{
      const value=await loadStage(stage,artwork,ctx);
      return value??null;
    });
    if(next&&(next.schemaVersion!==1||next.stage!==stage||keys.some(k=>next[k]!==artwork[k])))
      throw new Fault('PIPELINE_IDENTITY_MISMATCH','已保存阶段不属于当前候选');
    if(stage==='dynamics'&&next?.status==='awaiting_external_result') {
      if(!available)return {stage,status:next.status,bundle:next,error:{code:'ENGINE_LEASE_PENDING',message:'恢复查询仍需同候选引擎'}};
      next=next.previewCapture?.status==='awaiting_external_result'
        ?await invoke(stage,next,preview):await invoke(stage,current,dynamics);
    }
    else if(!next||next.status==='awaiting_external_result'||stage==='rigging'&&
      next.status==='failed'&&next.unresolved?.at(-1)?.code==='ENOSPC'&&ctx.riggingStorageRecovery) {
      if(stage!=='packaging'&&!available)return {stage,status:'blocked',bundle:current,
        error:{code:'ENGINE_LEASE_PENDING',message:'等待总控注入本候选独占引擎租约；没有生成完整模型包'}};
      await ctx.progress?.({stage});
      next=stage==='packaging'?await timed(stage,'package_and_verify',()=>build(current,ctx)):await invoke(stage,current,build);
    }
    else if(stage==='packaging'&&next.status==='completed'&&ctx.buildHdPreview) {
      // buildPackage reads and verifies a published directory before any rendering.
      // Re-entry must apply the current delivery contract to historical packages.
      next=await timed(stage,'recheck_existing_package',()=>build(current,ctx));
    }
    if(!next||next.schemaVersion!==1||next.stage!==stage||keys.some(k=>next[k]!==artwork[k]))
      throw new Fault('PIPELINE_IDENTITY_MISMATCH','下游返回了其他候选或阶段');
    // A saved dynamics export may still need its first capture after recovery.
    // Reuse it without rebuilding or replaying an existing/unknown capture.
    if(stage==='dynamics'&&next.status==='blocked'&&
      next.unresolved?.length===1&&next.unresolved[0].code==='DYNAMICS_VISUAL_NOT_RUN'&&!next.previewCapture) {
      if(!available)return {stage,status:'blocked',bundle:next,
        error:{code:'ENGINE_LEASE_PENDING',message:'恢复预览仍需本候选04独占引擎租约'}};
      next=await invoke(stage,next,preview);
      if(!next||next.schemaVersion!==1||next.stage!==stage||keys.some(k=>next[k]!==artwork[k]))
        throw new Fault('PIPELINE_IDENTITY_MISMATCH','预览返回了其他候选或阶段');
    }
    const reviewRequired=stage==='rigging'?'RIG_VISUAL_REVIEW_REQUIRED':'DYNAMICS_VISUAL_NOT_RUN';
    if(ctx.reviewRenderedStage&&stage!=='packaging'&&next.status==='blocked'&&
      next.unresolved?.length===1&&next.unresolved[0].code===reviewRequired) {
      try {
        next=await timed(stage,'review_native_render',()=>ctx.reviewRenderedStage(next));
      } catch(e) {
        return {stage,status:'blocked',bundle:next,error:{code:reviewRequired,
          message:'同版自动审查未取得结论，保留原生预览与工程：'+e.message}};
      }
      if(!next||next.schemaVersion!==1||next.stage!==stage||keys.some(k=>next[k]!==artwork[k]))
        throw new Fault('PIPELINE_IDENTITY_MISMATCH','审查返回了其他候选或阶段');
    }
    if(next.status!=='completed') {
      const issue=next.unresolved?.at(-1);
      return {stage,status:next.status,bundle:next,error:{code:issue?.code??'STAGE_UNRESOLVED',message:issue?.message??'当前阶段尚未完成'}};
    }
    ctx.stageCompleted?.(stage);
    current=next;
  }
  return {stage:'packaging',status:'completed',bundle:current};
}

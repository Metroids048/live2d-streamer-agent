import * as fs from 'node:fs/promises';
import path from 'node:path';
import {engineRun,originalCopy,outputDirectory,receiptDigest} from './engine-run.mjs';
import {Fault} from '../rpc.mjs';
import {compileDynamicsRecipe,RECIPE_VERSION} from './recipe.mjs';
import {artifact,digest,listFiles,relativePath,taskFile,verifyArtifacts,writeJson,sameJson} from './files.mjs';
import {inspectDynamicsExport,matchingMotionClip} from './export-check.mjs';

export {compileDynamicsRecipe} from './recipe.mjs';
export {inspectDynamicsExport} from './export-check.mjs';
export {createControlState,planControl,confirmControlPlan,reconcileControl} from './control.mjs';
export {captureDynamicsPreview,inspectDynamicsPreviewPending} from './preview.mjs';
export {recordDynamicsReview} from './review.mjs';

const identityKeys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
const validRevision=value=>typeof value==='string'&&value.length>0||typeof value==='number'&&Number.isFinite(value);

// Query only: never opens a project, repeats an edit, marks completion or resumes the next step.
export async function inspectDynamicsPending(ctx) {
  const root=await fs.realpath(ctx.taskRoot),file=await taskFile(root,'dynamics/engine-journal.json');
  const journal=JSON.parse(await fs.readFile(file,'utf8'));
  if(['taskId','candidateId','revision'].some(k=>journal[k]!==ctx[k]))throw new Fault('DYNAMICS_IDENTITY_MISMATCH','检查点不属于本任务候选');
  const pending=journal.pending;
  if(!pending)return {status:'no_pending',failure:journal.failure?{code:journal.failure.code,message:journal.failure.message}:null};
  const reference={operation:pending.operation,requestId:pending.request.request_id,jobId:pending.jobId};
  if(!pending.jobId||!ctx.engine?.call)return {status:'awaiting_external_result',...reference,reason:'需要总控核查原请求/任务，禁止再次提交'};
  const job=(await ctx.engine.call('job_get',{id:pending.jobId},{wait:false,unwrap:false})).data;
  if(job.id!==pending.jobId)throw new Fault('DYNAMICS_JOB_MISMATCH','查询回执与原job不符');
  return {...reference,status:job.terminal?'blocked':'awaiting_external_result',jobStatus:job.status,terminal:job.terminal===true,
    reason:job.terminal?'原任务已有终态；生产 worker 可核原作业、同版工程和文件后接续':'原任务仍在运行，保留租约和检查点'};
}

export async function buildDynamics(rig,ctx) {
  if(rig?.schemaVersion!==1||rig.stage!=='rigging')throw new Fault('DYNAMICS_INPUT_INVALID','需要03的RigBundle v1');
  if(!identityKeys.every(k=>Object.hasOwn(rig,k))||!['inputSha256','descriptionSha256'].every(k=>/^[a-f0-9]{64}$/.test(rig[k]))||
    !validRevision(rig.revision)||!(rig.parentRevision===null||validRevision(rig.parentRevision))||
    !['artifacts','checks','warnings','unresolved'].every(k=>Array.isArray(rig[k])))
    throw new Fault('DYNAMICS_INPUT_INVALID','缺少完整来源身份或Bundle数组');
  for(const k of ['taskId','candidateId','revision'])if((k!=='revision'&&typeof ctx?.[k]!=='string')||ctx?.[k]!==rig[k])
    throw new Fault('DYNAMICS_IDENTITY_MISMATCH','阶段身份与父版不符');
  if(ctx.parentRevision!==rig.parentRevision)throw new Fault('DYNAMICS_IDENTITY_MISMATCH','父候选不符');
  const root=await fs.realpath(ctx.taskRoot);
  if(rig.status==='completed') {
    await verifyArtifacts(root,rig.artifacts);
    for(const key of ['projectPath','psdPath','modelPath','parameterMapPath']) {
      await taskFile(root,rig[key]);
      if(!rig.artifacts.some(a=>a.path===rig[key]))throw new Fault('REFERENCE_INVALID','父版关键文件未绑定哈希：'+key);
    }
  }
  const directory=path.join(root,'dynamics'),stageFile=path.join(directory,'stage.json');
  let recovery=false,legacyFirst=false,previous;
  try {await fs.mkdir(directory);}
  catch(e) {
    if(e.code!=='EEXIST')throw e;
    if((await fs.lstat(directory)).isSymbolicLink()||await fs.realpath(directory)!==directory)throw new Fault('REFERENCE_INVALID','动态输出目录不得为软链接');
    try {previous=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/stage.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
    if(previous) {
      if(!identityKeys.every(k=>previous[k]===rig[k]))throw new Fault('DYNAMICS_IDENTITY_MISMATCH','已有动态候选不符');
      await verifyArtifacts(root,previous.artifacts);
      if(!ctx.recoverDynamics||previous.status!=='awaiting_external_result')return previous;
    }
    if(!ctx.recoverDynamics)throw new Fault('EXTERNAL_RESULT_UNKNOWN','已有动态候选/检查点，先核原操作，不原地重跑');
    recovery=true;
  }
  const bundle={...rig,...Object.fromEntries(identityKeys.map(k=>[k,rig[k]])),stage:'dynamics',status:'blocked',
    artifacts:[...(rig.artifacts??[])],checks:[...(rig.checks??[])],warnings:[...(rig.warnings??[])],unresolved:[...(rig.unresolved??[])],
    dynamicsManifestPath:'dynamics/dynamics-manifest.json'};
  const manifest={schemaVersion:1,recipeVersion:RECIPE_VERSION,...Object.fromEntries(identityKeys.map(k=>[k,rig[k]])),
    stage:'dynamics',status:'blocked',exportStatus:'not_run',engineVersion:rig.engineVersion,
    expressions:[],motions:[],physics:[],control:{adapter:'required',runtimeStatus:'not_run',
      stateStorage:'private; bind sessionKey+sessionId+modelId+modelSha256',
      transitions:['neutral → happy → angry → restore','expression and idle may coexist','A+B rejected','cancel motion preserves expression','disconnect → reconcile before retry'],
      reset:'release only resource tokens owned by this operation; never write global zeros or RemoveAllExpressions',
      requiredCapabilities:['readState','scopedResourceRelease'],unsupported:'exact restore is unsupported without native state and scoped release'},
    checks:[],warnings:[],unresolved:[]};
  let journal={schemaVersion:2,...Object.fromEntries(identityKeys.map(k=>[k,rig[k]])),steps:[],pending:null};
  const journalFile=path.join(directory,'engine-journal.json');
  if(recovery) {
    journal=JSON.parse(await fs.readFile(await taskFile(root,'dynamics/engine-journal.json'),'utf8'));
    // Old completed rows did not persist the request body. Only the first interrupted open
    // can be proven from a v1 journal, the immutable recipe, the source copy and the job itself.
    legacyFirst=journal.schemaVersion===1&&previous?.status==='awaiting_external_result'&&
      ['taskId','candidateId','revision'].every(k=>journal[k]===rig[k])&&
      journal.steps?.length===0&&!journal.failure&&journal.pending?.name==='open-clone'&&journal.pending.operation==='project_open'&&
      previous.artifacts.some(a=>a.path==='dynamics/recipe.json')&&rig.artifacts.every(a=>previous.artifacts.some(b=>a.path===b.path&&a.sha256===b.sha256));
    if(!legacyFirst&&(journal.schemaVersion!==2||identityKeys.some(k=>journal[k]!==rig[k])))
      throw new Fault('DYNAMICS_RECEIPT_UNVERIFIED','旧检查点缺完整来源或写入轨迹，保留原作业');
  }
  const check=(name,layer,status,note)=>({name,layer,status,...(note?{note}:{})});
  const finish=async()=>{
    for(const layer of ['visual','runtime','human','user_acceptance'])if(!bundle.checks.some(c=>c.name==='dynamics.'+layer))
      bundle.checks.push(check('dynamics.'+layer,layer,'not_run'));
    manifest.status=bundle.status;manifest.checks=bundle.checks.filter(c=>c.name.startsWith('dynamics.'));
    manifest.warnings=bundle.warnings;manifest.unresolved=bundle.unresolved;
    if(recovery)bundle.dynamicsManifestPath='dynamics/manifest-'+receiptDigest(journal.pending?.request.request_id??bundle.status)+'.json';
    await sameJson(path.join(root,bundle.dynamicsManifestPath),manifest);
    bundle.artifacts.push(await artifact(root,bundle.dynamicsManifestPath,'dynamics-manifest'));
    await writeJson(stageFile,bundle);await ctx.checkpoint?.({stage:'dynamics',status:bundle.status,bundle});return bundle;
  };
  let recipe;
  try {
    if(rig.status!=='completed') {bundle.unresolved.push({code:'RIG_NOT_READY',message:'03尚未交付可用真实绑定'});return await finish();}
    const map=JSON.parse(await fs.readFile(await taskFile(root,rig.parameterMapPath),'utf8'));
    const parentProjectId=rig.projectId??rig.engineProjectId;
    if(identityKeys.some(k=>map[k]!==rig[k])||map.projectId!==parentProjectId)
      throw new Fault('DYNAMICS_IDENTITY_MISMATCH','参数表身份/工程与RigBundle不符');
    recipe=compileDynamicsRecipe(map,rig.brief??map.brief??{intent:map.requested});
    for(const p of recipe.parameters.filter(p=>p.available))for(const e of p.motionEvidence??[])for(const key of ['defaultImage','posedImage']) {
      if(!rig.artifacts.some(a=>a.path===e[key]))throw new Fault('REFERENCE_INVALID','03形变图未绑定候选哈希');
      await taskFile(root,e[key]);
    }
    await sameJson(path.join(directory,'recipe.json'),recipe);
    bundle.artifacts.push(await artifact(root,'dynamics/recipe.json','dynamics-recipe'));
    manifest.ownership=recipe.ownership;manifest.warnings=recipe.warnings;
    bundle.warnings.push(...recipe.warnings);bundle.unresolved.push(...recipe.unresolved);
    bundle.checks.push(check('dynamics.moving-shapes','automated',recipe.unresolved.length?'blocked':'passed','仅核03映射证据，不代替实际视觉'));
    if(recipe.unresolved.length)return await finish();
    if(!ctx.engine?.call) {bundle.unresolved.push({code:'ENGINE_BUSY',message:'需要00注入持04独占租约的引擎'});return await finish();}
    if(rig.engineVersion!=='3.6.7'||!parentProjectId)throw new Fault('DYNAMICS_ENGINE_MISMATCH','需要固定3.6.7与03实际projectId');
    const engine=ctx.engine;
    const query=async(operation,request={})=>(await engine.call(operation,request)).data;
    const first=journal.steps[0]??journal.pending;
    const emptyState=ctx.emptyDynamicsState??(first?.name==='open-clone'&&first.request?.project_id===null?first.request.state:undefined);
    const runner=engineRun({root,journal,file:journalFile,ctx,project:emptyState?null:parentProjectId,
      state:emptyState??rig.engineState??rig.engineRevision??map.state});
    if(journal.failure)throw new Fault(journal.failure.code,journal.failure.message);
    const {step,inspect}=runner;
    if(!runner.replaying)await inspect();
    const parent=await taskFile(root,rig.projectPath),parentSha=await digest(parent),clone=path.join(directory,'character.psd2live');
    const bindings={parentSha,recipeSha:bundle.artifacts.at(-1).sha256};
    if(recovery&&!legacyFirst&&(journal.bindings?.parentSha!==parentSha||journal.bindings?.recipeSha!==bindings.recipeSha))
      throw new Fault('DYNAMICS_RECEIPT_UNVERIFIED','父工程或打算执行的动态配方已改变');
    if(!recovery){journal.bindings=bindings;await writeJson(journalFile,journal,{exclusive:true});}
    await originalCopy(parent,clone,recovery,[...journal.steps,journal.pending].some(s=>s?.name==='save-clone'));
    if(legacyFirst){
      // The matching request, native archive HEAD and actual live engine still get checked in step().
      Object.assign(journal,{schemaVersion:2,...Object.fromEntries(identityKeys.map(k=>[k,rig[k]])),bindings});
    }
    manifest.parentProject={path:rig.projectPath,sha256:parentSha};
    await step('open-clone','project_open',{path:clone});
    // Only the cloned document changes. No rig_generate or parameter creation here.
    await step('export-settings','settings_update',{changes:{exportMotions:true,exportIncludePhysics:true,
      physicsFrontHair:false,physicsBackHair:false,physicsEyeJelly:false,
      motionBasic:false,motionIdle:false,motionBlink:false,motionNod:false,motionShake:false,motionSkeleton:false}});
    for(const g of recipe.physics)await step('physics-'+g.id,'physics_put',g);
    await step('physics-config','physics_config',{fps:recipe.physicsFps,order:recipe.physics.map(g=>g.id)});
    // PSD2Live's editor uses enum names (ADD); the persisted recipe and Cubism exp3 use Add.
    // These are the built-in mood IDs on a generated 3.6.7 rig. Replacing them avoids
    // duplicate localized display names when the requested name is the built-in “生气”.
    const moodIds={dyn_happy:'smile',dyn_smile:'smile',dyn_angry:'angry',dyn_surprise:'surprised'};
    const engineExpressions=recipe.expressions.map(e=>({...e,id:moodIds[e.id]??e.id,entries:e.entries.map(v=>({...v,blend:v.blend.toUpperCase()}))}));
    for(const [i,expression] of engineExpressions.entries())await step('expression-'+recipe.expressions[i].id,'expression_put',{expression});
    for(const clip of recipe.motions)await step('motion-'+clip.id,'motion_put',{clip});
    await step('save-clone','project_save_as',{path:clone});
    const modelDirectory=path.join(directory,'model');await outputDirectory(modelDirectory,recovery);
    await step('export-model','project_export_model',{output_directory:modelDirectory});
    const files=await listFiles(modelDirectory),models=files.filter(p=>p.endsWith('.model3.json'));
    if(models.length!==1)throw new Fault('DYNAMICS_EXPORT_INVALID','动态导出需要唯一model3入口');
    const modelPath=relativePath(root,models[0]);
    const indexed=await inspectDynamicsExport(root,modelPath,recipe);
    Object.assign(manifest,indexed,{exportStatus:'exported',physics:recipe.physics.map(g=>({id:g.id,inputs:g.inputs,outputs:g.outputs})),
      projectPath:'dynamics/character.psd2live',parameterMapPath:rig.parameterMapPath,psdPath:rig.psdPath});
    // Reopen the actual portable archive and read back the authored resources.
    await step('reopen-clone','project_open',{path:clone});
    const readback={expressions:await query('expression_list'),motions:[],physics:await query('workspace_inspect',{scope:'physics'})};
    for(const m of recipe.motions)readback.motions.push(await query('motion_get',{id:m.id}));
    for(const e of engineExpressions) {
      const actual=readback.expressions.expressions?.find(v=>v.id===e.id);
      if(!actual||JSON.stringify(actual.entries)!==JSON.stringify(e.entries))throw new Fault('DYNAMICS_REOPEN_INVALID','工程重开后表情不符');
    }
    for(const m of recipe.motions) {
      const actual=readback.motions.find(r=>r.clip?.id===m.id)?.clip;
      if(!actual||!matchingMotionClip(actual,m))
        throw new Fault('DYNAMICS_REOPEN_INVALID','工程重开后动作不符');
    }
    for(const g of recipe.physics)if(!readback.physics.groups?.some(p=>p.id===g.id&&p.active))throw new Fault('DYNAMICS_REOPEN_INVALID','工程重开后物理未生效');
    await sameJson(path.join(directory,'readback.json'),readback);
    if(await digest(parent)!==parentSha)throw new Fault('DYNAMICS_PARENT_CHANGED','父工程在本轮意外变化，停止交接');
    bundle.projectPath=manifest.projectPath;bundle.modelPath=modelPath;
    const last=await runner.complete();bundle.projectId=bundle.engineProjectId=last.project_id;bundle.engineState=bundle.engineRevision=last.state;
    for(const file of [clone,...files,path.join(directory,'readback.json')])bundle.artifacts.push(await artifact(root,relativePath(root,file),file===clone?'editable-project':file.endsWith('.model3.json')?'model':'dynamics-resource'));
    bundle.checks.push(check('dynamics.export-and-reopen','automated','passed','实际调用导出/重开并核索引；不代表观感/运行器验收'));
    bundle.unresolved.push({code:'DYNAMICS_VISUAL_NOT_RUN',message:'需同版中性/开心/生气/恢复及物理快停、组合连续样片核验；结构成功不能代替视觉'});
  } catch(e) {
    // Only an explicit rejected/terminal failure proves that an edit is not still running.
    const unknown=!!journal.pending;
    if(recovery&&previous&&unknown&&previous.unresolved.at(-1)?.requestId===journal.pending.request.request_id)return previous;
    bundle.status=unknown?'awaiting_external_result':'failed';
    bundle.unresolved.push({code:unknown?'EXTERNAL_RESULT_UNKNOWN':e.code??'DYNAMICS_FAILED',message:e.message,
      ...(journal.pending?{operation:journal.pending.operation,requestId:journal.pending.request.request_id,jobId:journal.pending.jobId}: {})});
  }
  return await finish();
}

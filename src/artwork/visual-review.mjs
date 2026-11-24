// Model observations of actual PNG pages. The provider's visual checks are never inferred from file counts.
import * as fs from 'node:fs/promises';
import {isDeepStrictEqual} from 'node:util';
import {artifact,readJson,safePath,sha256,writeJson} from './files.mjs';
import {Fault} from '../rpc.mjs';
import {correctionOperation} from '../pipeline/flash-correction.mjs';
import {identityKeys} from '../pipeline/lease.mjs';

const ok=(v,msg)=>{if(!v)throw new Fault('ARTWORK_REVIEW_NOT_READY',msg);};
const same=(a,b)=>identityKeys.every(k=>Object.hasOwn(a,k)&&a[k]===b[k]);
const issue='ARTWORK_VISUAL_REVIEW_REQUIRED';
export async function artworkReviewDescriptor(bundle,ctx,{checkAll=false}={}) {
  const root=ctx.taskRoot;
  ok(bundle.stage==='artwork' && bundle.status==='blocked' && same(bundle,ctx) && bundle.unresolved.length===1 &&
    bundle.unresolved[0].code===issue && !bundle.visualReview,'只有结构检查全部通过且等待首次视觉判读的同版候选可审查');
  const artifacts=new Map(bundle.artifacts.map(a=>[a.path,a]));
  ok(artifacts.size===bundle.artifacts.length,'重复工件');
  const checked=async p=>{
    const row=artifacts.get(p);ok(row,'未登记工件：'+p);
    const a=await artifact(root,p,row.role);ok(a.sha256===row.sha256&&a.bytes===row.bytes,'工件发生变化：'+p);
    return await safePath(root,p);
  };
  if(checkAll)for(const p of artifacts.keys())await checked(p);
  await checked(bundle.artworkManifestPath);await checked(bundle.layoutPath);
  const m=await readJson(root,bundle.artworkManifestPath),layout=await readJson(root,bundle.layoutPath);
  const operation=await readJson(root,correctionOperation)??await readJson(root,'artwork/operation.json');
  ok(m?.schemaVersion===1 && same(m,bundle) && m.status==='blocked' && m.layoutPath===bundle.layoutPath &&
    operation?.status==='completed' && /^[0-9a-f]{64}$/.test(m.cacheKey) && m.cacheKey===operation.cacheKey && m.operationKey===operation.operationKey &&
    m.operationKey===sha256([ctx.taskId,ctx.candidateId,ctx.revision,m.cacheKey].join(':')) &&
    m.jobId===(operation.jobId??null) && Boolean(m.backend?.id) && isDeepStrictEqual(m.backend,operation.backend) &&
    operation.inputSha256===ctx.inputSha256 && operation.descriptionSha256===ctx.descriptionSha256,
    '分层清单或后台回执与当前版本不符');
  ok(m.missingSemantics?.length===0 && m.sourceMapping?.verified===true &&
    m.sourceSha256===bundle.sourceImage?.sha256 && artifacts.get(bundle.sourceImage.path)?.sha256===m.sourceSha256,
    '仍有缺层、原画坐标未确认或源图发生变化');
  const ref=bundle.artifacts.filter(a=>a.role==='artwork_reference');
  ok(ref.length===1 && ref[0].sha256===m.sourceSha256,'参考图不是本候选原图');
  ok(layout?.format==='psd2live-layout' && layout.version===1 && Array.isArray(m.parts) && m.parts.length>1 &&
    layout.layers?.length===m.parts.length+1 && new Set(m.parts.map(p=>p.layoutLayerId)).size===m.parts.length &&
    layout.layers.some(l=>l.id==='source-reference'&&l.reference&&l.visible===false&&'artwork/'+l.image?.path===ref[0].path) &&
    m.parts.every(part=>artifacts.get(part.path)?.sha256===part.sha256 &&
      layout.layers.some(l=>l.id===part.layoutLayerId && 'artwork/'+l.image?.path===part.path)), '部件或 Layout 与已登记像素不符');
  const checks=m.checks, states=m.previews?.materialStates;
  ok(Array.isArray(checks) && ['png-layout-integrity','deformation-materials'].every(name=>checks.some(c=>c.name===name&&c.layer==='automated'&&c.status==='passed')) &&
    checks.every(c=>c.layer!=='automated'||c.status==='passed') &&
    !bundle.checks.some(c=>c.status==='failed'||c.status==='blocked') && checks.every(c=>bundle.checks.some(b=>isDeepStrictEqual(b,c))),
    '不得用模型审查覆盖失败的自动或视觉检查');
  const reference=ref[0].path, composite=m.previews.composite, withoutHair=m.previews.occlusionDiagnostic, face='artwork/face-closeup.png';
  const paths={'identity-preservation':[reference,composite,face],'occlusion-completion':[withoutHair,face],
    'default-composite':[reference,composite]};
  const wants=(field,id)=>bundle.brief?.intent?.[field]?.some(v=>v.id===id);
  // Only report switches requested by this candidate. In ordinary mouth/blink jobs still inspect the corresponding material states.
  for(const [criterion,required] of [['half-blink',bundle.brief?.intent?.eyes?.blink],['open-mouth',bundle.brief?.intent?.mouth?.speech],
    ['closed-mouth',m.recipe?.productionProfile&&bundle.brief?.intent?.mouth?.speech],['raised-hand',wants('actions','wave')&&!m.recipe?.productionProfile?.continuousWave],
    ['continuous-arm-source',wants('actions','wave')&&m.recipe?.productionProfile?.continuousWave],['removed-chest-bow',wants('clothingVariants','chest_bow')]]) {
    if(required || checks.some(c=>c.layer==='visual'&&c.name===criterion))paths[criterion]=[composite,states?.[criterion]];
  }
  const faceSheet='artwork/face-material-comparison.png';
  if(artifacts.has(faceSheet))for(const key of ['identity-preservation','occlusion-completion','half-blink','open-mouth'])if(paths[key])paths[key].push(faceSheet);
  const visual=checks.filter(c=>c.layer==='visual');
  ok(visual.length>0 && visual.every(c=>Object.hasOwn(paths,c.name) && c.status==='not_run'),'发现未知或已判读视觉检查');
  const stills=[...new Set(Object.values(paths).flat())];
  for(const p of stills)ok(typeof p==='string'&&artifacts.has(p),'缺少真实诊断图：'+String(p));
  const openIsNeutral=paths['closed-mouth']&&artifacts.get(composite).sha256===artifacts.get(states?.['open-mouth'])?.sha256;
  const statePaths=Object.entries(paths).filter(([k])=>!['identity-preservation','occlusion-completion','default-composite',...(openIsNeutral?['open-mouth']:[])].includes(k)).map(([,v])=>v.filter(p=>p!==faceSheet).at(-1));
  // An identical image cannot demonstrate the requested state; actual alignment/appearance remains a visual judgment.
  ok(new Set([composite,withoutHair,...statePaths].map(p=>artifacts.get(p).sha256)).size===2+statePaths.length,
    '移层或动作前后像素完全相同，不能用重复图片作证');
  return {manifest:m,stills,paths,criteria:Object.keys(paths),checked};
}

export async function recordArtworkReview(bundle,review,ctx) {
  const root=ctx.taskRoot,stage='artwork/stage.json',bytes=await fs.readFile(await safePath(root,stage));
  ok(sha256(bytes)===review.stageSha256,'审查开始后候选阶段已改变');
  const current=JSON.parse(bytes);
  ok(same(current,bundle),'候选身份已改变');
  const {manifest,paths,criteria}=await artworkReviewDescriptor(current,ctx,{checkAll:true});
  const obs=review.observations;
  ok(/^[a-z0-9][a-z0-9_-]{0,63}$/.test(review.id??'') && review.reviewer?.kind==='model' && Array.isArray(obs) &&
    obs.length===criteria.length && new Set(obs.map(o=>o.criterion)).size===criteria.length, '逐项模型审查不完整');
  for(const criterion of criteria) {
    const row=obs.find(o=>o.criterion===criterion), permitted=paths[criterion];
    ok(row && ['passed','failed'].includes(row.status) && row.from===0 && row.to===0 &&
      typeof row.note==='string' && row.note.trim().length>=8 && row.note.length<=4000 &&
      Array.isArray(row.evidencePaths) && permitted.every(p=>row.evidencePaths.includes(p)) && row.evidencePaths.every(p=>permitted.includes(p)),
      '静态判读需逐项填写观察与本项真实 PNG 路径：'+criterion);
  }
  const passed=obs.every(o=>o.status==='passed'), identity=Object.fromEntries(identityKeys.map(k=>[k,current[k]]));
  const record={...identity,id:review.id,reviewer:review.reviewer,stageSha256:review.stageSha256,sourceManifestPath:current.artworkManifestPath,
    ...(review.reusedObservation?{reusedObservation:review.reusedObservation}:{}),
    status:passed?'passed':'failed',observations:obs,evidence:[...new Set(Object.values(paths).flat())].map(p=>({path:p,sha256:current.artifacts.find(a=>a.path===p).sha256}))};
  // Commit the new manifest and observation as additional immutable artifacts; atomically point stage.json to both last.
  const folder='artwork/reviews/'+sha256(JSON.stringify(record)), reviewPath=folder+'/review.json', manifestPath=folder+'/artwork-manifest.json';
  async function immutable(file,value) {
    const dst=await safePath(root,file,{mkdirParents:true}), data=Buffer.from(JSON.stringify(value,null,2)+'\n');
    try{await fs.writeFile(dst,data,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST'||!(await fs.readFile(dst)).equals(data))throw e;}
  }
  const judgments=obs.map(o=>({name:o.criterion,layer:'visual',status:o.status,note:o.note,evidence:reviewPath,reviewerKind:'model'}));
  const merge=checks=>[...checks.filter(c=>!(c.layer==='visual'&&criteria.includes(c.name))),...judgments];
  const visualReview={path:reviewPath,status:record.status,reviewerKind:'model'};
  await immutable(reviewPath,record);
  await immutable(manifestPath,{...manifest,status:passed?'completed':'blocked',checks:merge(manifest.checks),visualReview});
  const next={...current,status:passed?'completed':'blocked',checks:merge(current.checks),visualReview,artworkManifestPath:manifestPath,
    unresolved:passed?[]:[{stage:'artwork',code:'ARTWORK_VISUAL_REVIEW_FAILED',message:'实际分层图的模型判读未通过，保留本候选和缺陷，禁止进入绑定。'}],
    artifacts:[...current.artifacts,await artifact(root,reviewPath,'artwork_model_visual_review'),await artifact(root,manifestPath,'artwork_reviewed_manifest')]};
  ok(sha256(await fs.readFile(await safePath(root,stage)))===review.stageSha256,'审查期间候选已移动');
  await writeJson(root,stage,next);
  return next;
}

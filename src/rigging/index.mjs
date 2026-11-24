import * as fs from 'node:fs/promises';
import path from 'node:path';
import {findModels,inspectModel} from '../model.mjs';
import {decodePng,alphaGeometry,eyeRimAperture,inspectTopology,pixelDifference,inspectGif} from './geometry.mjs';
import {prepareRigFaceImport} from './import-face.mjs';
import {RigSession,RigError,writeJson} from './engine.mjs';
import {ENGINE_VERSION,ENGINE_COMMIT,RIG_REPAIR_PROFILE,BASE_PARAMETERS,has,eyeRimAxis,fixedHeadDetail,materialGaps,validateMotion,planRefinements,poseSets,previewClip} from './recipe.mjs';
import {controlRecipe,hasRole,roles} from './controls.mjs';
import {applySharedFaceRig} from './shared-face.mjs';
import {applyHeadRangeClamps} from './head-range.mjs';
import {applyAnchoredWave,applyRestingWrist,loadWaveReturnRegistration} from './wave.mjs';
import {applyExpressionRefinement,EXPRESSION_REFINEMENT_VERSION} from './expressions.mjs';
import {refineMouthTopology,MOUTH_TOPOLOGY_VERSION} from './mouth-topology.mjs';
import {applyGestureAxes} from './streamer-presets.mjs';
import {renderIndividualPoses} from './pose-sheet.mjs';
import {digest,identityKeys,safePath,artifact} from './files.mjs';
export {safePath} from './files.mjs';
export {recordRigReview,rigReviewCriteria,rigCriteriaFor} from './review.mjs';

const refinementVersion='hachi-full-refinement-v6';

const issue=(code,message)=>({code,message,stage:'rigging'});
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value;
const parameterSnapshot=parameters=>JSON.stringify(canonical([...parameters].sort((a,b)=>a.id.localeCompare(b.id))));
async function validateArtwork(artwork,ctx) {
  if(artwork?.schemaVersion!==1||artwork.stage!=='artwork')throw new RigError('ARTWORK_BUNDLE_REQUIRED');
  for(const k of identityKeys)if(!Object.hasOwn(artwork,k)||artwork[k]===undefined)throw new RigError('BUNDLE_IDENTITY_MISSING',k);
  for(const k of ['taskId','candidateId','revision','parentRevision'])if(ctx[k]!==artwork[k])throw new RigError('BUNDLE_CONTEXT_MISMATCH',k);
  for(const k of ['inputSha256','descriptionSha256'])if(!/^[a-f0-9]{64}$/.test(artwork[k]))throw new RigError('BUNDLE_HASH_INVALID',k);
  if(!Array.isArray(artwork.artifacts)||!Array.isArray(artwork.checks)||!Array.isArray(artwork.warnings)||!Array.isArray(artwork.unresolved))throw new RigError('BUNDLE_FIELDS_INVALID');
  for(const a of artwork.artifacts) {
    const actual=await artifact(ctx.taskRoot,a.role,a.path);
    if(actual.sha256!==a.sha256||actual.bytes!==a.bytes)throw new RigError('ARTIFACT_HASH_MISMATCH',a.path);
  }
  if(artwork.status!=='completed')throw new RigError('ARTWORK_NOT_READY','02 未交付可用素材。');
  if(artwork.checks.some(c=>c.status==='failed'||c.status==='blocked')||artwork.unresolved.length)throw new RigError('ARTWORK_QUALITY_UNRESOLVED');
  validateMotion(artwork.brief);
  const layoutFile=await safePath(ctx.taskRoot,artwork.layoutPath),manifestFile=await safePath(ctx.taskRoot,artwork.artworkManifestPath);
  for(const p of [artwork.layoutPath,artwork.artworkManifestPath])if(!artwork.artifacts.some(a=>a.path===p))throw new RigError('ARTWORK_MANIFEST_NOT_HASHED',p);
  const layout=JSON.parse(await fs.readFile(layoutFile,'utf8')),manifest=JSON.parse(await fs.readFile(manifestFile,'utf8'));
  if(layout.format!=='psd2live-layout'||layout.version!==1||!Array.isArray(layout.layers)||!layout.layers.length||layout.layers.length>4096)throw new RigError('LAYOUT_INVALID');
  const canvas=layout.canvas;
  if(!canvas||![canvas.width,canvas.height].every(x=>Number.isInteger(x)&&x>0&&x<=8192)||canvas.width*canvas.height>16777216)throw new RigError('LAYOUT_CANVAS_INVALID');
  const ids=new Set(),parts=[];
  for(const layer of layout.layers) {
    if(!/^[A-Za-z0-9_.:#-]{1,96}$/.test(layer.id)||ids.has(layer.id))throw new RigError('LAYOUT_STABLE_UNIQUE_IDS_REQUIRED');ids.add(layer.id);
    if(!Array.isArray(layer.tags)&&!layer.reference)throw new RigError('LAYOUT_TAGS_REQUIRED',layer.id);
    if(layer.tags?.some(t=>typeof t!=='string')||layer.tags?.includes('left')&&layer.tags?.includes('right'))throw new RigError('LAYOUT_SIDE_INVALID',layer.id);
    if(!layer.rect||!['left','top','width','height'].every(k=>Number.isFinite(layer.rect[k]))||layer.rect.width<=0||layer.rect.height<=0)throw new RigError('LAYOUT_RECT_INVALID',layer.id);
    const imageRelative=path.posix.join(path.posix.dirname(artwork.layoutPath),layer.image?.path??'');
    // Validate original path before normalization can erase a traversal segment.
    await safePath(path.dirname(layoutFile),layer.image?.path);
    if(!artwork.artifacts.some(a=>a.path===imageRelative))throw new RigError('LAYER_IMAGE_NOT_HASHED',layer.id);
    const png=decodePng(await fs.readFile(await safePath(ctx.taskRoot,imageRelative)));
    if(png.width!==layer.image.width||png.height!==layer.image.height)throw new RigError('LAYER_IMAGE_DIMENSION_MISMATCH',layer.id);
    if(!layer.reference)parts.push({...layer,tags:layer.tags,geometry:alphaGeometry(png,layer.rect),imagePath:imageRelative});
  }
  if(!parts.length)throw new RigError('LAYOUT_REFERENCE_ONLY');
  // Exact duplicates carrying every role are a copied whole image, not semantic decomposition.
  const hashes=parts.map(p=>artwork.artifacts.find(a=>a.path===p.imagePath).sha256);
  if(parts.length>1&&new Set(hashes).size===1)throw new RigError('LAYOUT_DUPLICATED_WHOLE_IMAGE');
  return {layout,layoutFile,manifest,parts,canvas};
}
async function materialRepair(artwork,root,parts,canvas) {
  const patch=artwork.rigMaterialRepair;
  if(!patch)return null;
  const layer=id=>parts.find(p=>p.id===id);
  const registered=async (file)=>{
    if(!/^artwork\/rig-material\/[a-z0-9-]+\.png$/.test(file??'')||
      !artwork.artifacts.some(a=>a.path===file&&a.role==='rig_material_repair'))throw new RigError('RIG_MATERIAL_REPAIR_INVALID');
    const image=await safePath(root,file);
    return {image,png:decodePng(await fs.readFile(image))};
  };
  if(!Number.isSafeInteger(artwork.parentRevision)||artwork.parentRevision>=artwork.revision||
    !Array.isArray(patch.replacements)||!patch.replacements.length||patch.replacements.length>parts.length||
    new Set(patch.replacements.map(p=>p.layerId)).size!==patch.replacements.length)
    throw new RigError('RIG_MATERIAL_REPAIR_INVALID');
  const replacements=[];
  for(const {layerId,path:file} of patch.replacements) {
    const original=layer(layerId),{image,png}=await registered(file);
    if(!original||png.width!==original.image.width||png.height!==original.image.height)
      throw new RigError('RIG_MATERIAL_REPAIR_INVALID',layerId);
    replacements.push({layerId,image});
  }
  const drawOrder=patch.drawOrder??[];
  if(!Array.isArray(drawOrder)||drawOrder.length>parts.length||
    new Set(drawOrder.map(entry=>entry?.layerId)).size!==drawOrder.length||
    drawOrder.some(entry=>!layer(entry?.layerId)||!Number.isInteger(entry.order)||entry.order<0||entry.order>1000))
    throw new RigError('RIG_MATERIAL_REPAIR_INVALID');
  const backing=patch.backing;
  if(!backing)return {replacements,drawOrder};
  if(!layer(backing.behind)||!Array.isArray(backing.at)||backing.at.length!==2||
    !backing.at.every((v,i)=>Number.isFinite(v)&&v>=0&&v<=(i===0?canvas.width:canvas.height))||
    !/^[A-Za-z0-9_.:#-]{1,96}$/.test(backing.parent??''))throw new RigError('RIG_MATERIAL_REPAIR_INVALID');
  return {replacements,drawOrder,backing:{...backing,image:(await registered(backing.path)).image}};
}
const view=(canvas,parts,poses)=>({viewport:{mode:'canvas_rect',left:0,top:0,width:canvas.width,height:canvas.height},include_layer_ids:parts.map(p=>p.id),background:'transparent',target_long_edge:1536,...(poses?{poses,columns:3}:{})});
function geometryWarnings(data) {
  const found=[];
  function visit(v) {if(!v||typeof v!=='object')return;if(v.geometry_diagnostics)found.push(v.geometry_diagnostics);for(const [k,x] of Object.entries(v))if(k!=='geometry_diagnostics'&&typeof x==='object')visit(x);}
  visit(data);return found;
}

export async function buildRig(artwork,ctx) {
  const base={...structuredClone(artwork),stage:'rigging',status:'blocked',artifacts:[...(artwork?.artifacts??[])],checks:[...(artwork?.checks??[])],warnings:[...(artwork?.warnings??[])],unresolved:[...(artwork?.unresolved??[])]};
  base.refinementVersion=refinementVersion;
  if(ctx?.engineRuntimePatch)base.engineRuntimePatch=structuredClone(ctx.engineRuntimePatch);
  const check=(name,layer,status,note,evidence)=>base.checks.push({name,layer,status,...(note?{note}:{}),...(evidence?{evidence}:{})});
  let lock,dir,session;
  const saveResult=async()=>{if(dir)await writeJson(path.join(dir,'stage.json'),base);return base;};
  try {
    if(!ctx?.taskRoot)throw new RigError('TASK_ROOT_REQUIRED');
    const root=await fs.realpath(ctx.taskRoot);dir=path.join(root,'rigging');
    await fs.mkdir(dir,{recursive:true});if(await fs.realpath(dir)!==dir)throw new RigError('RIGGING_DIRECTORY_SYMLINK');
    try {lock=await fs.open(path.join(dir,'.build.lock'),'wx');}
    catch(error) {if(error.code==='EEXIST')throw new RigError('CANDIDATE_BUILD_LOCKED');throw error;}
    await lock.writeFile(JSON.stringify({pid:process.pid,taskId:ctx.taskId,candidateId:ctx.candidateId,startedAt:new Date().toISOString()})+'\n');
    for(const d of ['schemas','operation-images','poses','parameter-evidence','model']) {
      const p=path.join(dir,d);await fs.mkdir(p,{recursive:true});if(await fs.realpath(p)!==p)throw new RigError('RIGGING_DIRECTORY_SYMLINK');
    }
    // Existing files inside this owned candidate must never redirect writes outside it.
    async function rejectLinks(folder) {for(const e of await fs.readdir(folder,{withFileTypes:true})){if(e.isSymbolicLink())throw new RigError('RIGGING_OUTPUT_SYMLINK');if(e.isDirectory())await rejectLinks(path.join(folder,e.name));}}
    await rejectLinks(dir);
    const identity=Object.fromEntries(identityKeys.map(k=>[k,artwork?.[k]]));
    const sourceHash=digest(Buffer.from(JSON.stringify(artwork?.artifacts??[])));
    const file=path.join(dir,'state.json');let journal;
    try {journal=JSON.parse(await fs.readFile(file,'utf8'));}
    catch(error) {if(error.code!=='ENOENT')throw error;journal={schemaVersion:1,recipeVersion:2,repairProfile:RIG_REPAIR_PROFILE,identity,sourceHash,mergePortraitFringe:true,linkedPortraitBlink:true,passiveSleeveSway:true,projectId:null,state:null,pending:null,done:{},planning:{}};}
    if(JSON.stringify(journal.identity)!==JSON.stringify(identity)||journal.sourceHash!==sourceHash||journal.recipeVersion!==2)throw new RigError('CANDIDATE_IDENTITY_CHANGED');
    if(journal.repairProfile!==RIG_REPAIR_PROFILE) {
      // Jobs belong to the original service. Observe their receipt without preparing
      // current artwork proxies, changing the recipe, or issuing another editor write.
      await validateArtwork(artwork,ctx);
      delete base.refinementVersion;delete base.engineRuntimePatch;
      try {
        const prior=JSON.parse(await fs.readFile(path.join(dir,'stage.json'),'utf8'));
        if(prior.stage!=='rigging'||identityKeys.some(k=>prior[k]!==identity[k]))throw new RigError('CANDIDATE_IDENTITY_CHANGED');
        Object.assign(base,prior);
      }catch(error){if(error.code!=='ENOENT')throw error;}
      base.repairProfile=journal.repairProfile??null;
      session=new RigSession(ctx,dir,journal);
      try {
        if(journal.pending&&!ctx.engine?.call)throw new RigError('ENGINE_LEASE_REQUIRED');
        await session.resume();
      } finally {base.engineProjectId=journal.projectId;base.engineRevision=journal.state;}
      throw new RigError('RIG_RECIPE_UPGRADE_REQUIRED','旧配方仅支持查询原回执；继续制作需另行登记返修，未应用当前配方。');
    }
    const validated=await validateArtwork(artwork,ctx);
    const repair=await materialRepair(artwork,root,validated.parts,validated.canvas);
    const source=await prepareRigFaceImport(validated,root,dir,{mergePortraitFringe:journal.mergePortraitFringe===true,
      replacements:journal.mergePortraitFringe===true?repair?.replacements:[]}),{parts,canvas}=source;
    check('rigging_input_integrity','automated','passed','绑定源图、描述与02逐层 PNG 的实际哈希/尺寸/路径。');
    const continuousWave=parts.some(p=>hasRole(p,roles.continuous));
    const legacyWave=artwork.brief.intent.actions.some(a=>a.id==='wave')&&!continuousWave;
    const waveReturn=legacyWave?await loadWaveReturnRegistration({dir,ctx},parts):null,waveOwnership=waveReturn?.ownership;
    const controls=controlRecipe(parts,artwork.brief,{waveOwnership});
    const gaps=materialGaps(parts,artwork.brief);
    await writeJson(path.join(dir,'geometry.json'),{schemaVersion:1,...Object.fromEntries(identityKeys.map(k=>[k,artwork[k]])),canvas,parts:parts.map(p=>({id:p.id,tags:p.tags,imagePath:p.imagePath,geometry:p.geometry,...(p.rigging?{rigging:p.rigging}:{})})),gaps});
    base.artifacts.push(await artifact(root,'rigging_geometry','rigging/geometry.json'));
    if(gaps.length){base.unresolved.push(...gaps);check('rigging_materials','automated','blocked','缺少具体部件，先由02回补，不导入粗层后假完成。');return await saveResult();}
    if(!ctx.engine?.call) {base.unresolved.push(issue('ENGINE_LEASE_REQUIRED','需要00注入持本候选独占租约的 PSD2Live handle。'));return await saveResult();}
    session=new RigSession(ctx,dir,journal);await session.persist();await session.resume();
    // No mutation until all required public operations have exact runtime schemas.
    const operations=['project_import_layout','settings_update','layer_mesh_update','rig_generate','rig_deform','keyform_apply','author_axis','rig_create_warp','warp_set_topology','project_save_as','project_save','project_open','project_export_model','project_export_psd','motion_put','project_export_target'];
    if(parts.some(p=>has(p,'mouth','open')))operations.push('canvas_topology','mesh_get_topology');
    const faceDetails=parts.filter(fixedHeadDetail);
    const eyelidRims=parts.filter(p=>eyeRimAxis(p));
    if(faceDetails.length||eyelidRims.length)operations.push('layer_classify');
    if(source.meshRestores?.length||repair)operations.push('layer_replace_image');
    if(repair?.drawOrder.length)operations.push('layer_draw_order');
    if(repair?.backing)operations.push('layer_import_images');
    const nativeAlternates=parts.filter(p=>has(p,'eye','closed')||has(p,'mouth','open')||has(p,'mouth','closed'));
    // v3.6.7 only recognizes MOUTH (not MOUTH_CLOSE) when initializing MOUTH_OPEN opacity.
    const mouthToggles=parts.some(p=>has(p,'mouth','closed'))?parts.filter(p=>has(p,'mouth','open')):[];
    const restoreNative=nativeAlternates.filter(p=>!mouthToggles.includes(p)&&p.variant&&p.variant.type!=='none');
    if(controls.variants.length||mouthToggles.length||restoreNative.length||nativeAlternates.some(p=>p.visible===false))operations.push('layer_set_variant','object_edit_appearance');
    for(const operation of operations)await session.schema(operation);
    if(artwork.brief.intent.actions.some(a=>a.id==='wave')&&!(await session.schema('mesh_get_topology')).request_schema.properties?.space)
      throw new RigError('WAVE_CANVAS_QUERY_REQUIRED');
    if(!journal.done.import) {
      let offset=0;
      for(;;) {
        const jobs=(await session.query('job_list',{offset,limit:64})).data;
        if(jobs.items.some(j=>!j.terminal&&!['completed','failed','cancelled'].includes(j.status)))throw new RigError('ENGINE_HAS_ACTIVE_JOBS');
        if(jobs.next===undefined)break;if(!Number.isInteger(jobs.next)||jobs.next<=offset)throw new RigError('JOB_LIST_PAGINATION');offset=jobs.next;
      }
    }
    await session.step('import','project_import_layout',{path:source.layoutFile,discard_unsaved:false},{lifecycle:true});
    const imported=await session.list('layers');
    if(parts.some(p=>!imported.some(l=>l.id===p.id)))throw new RigError('IMPORTED_LAYER_ID_MISMATCH');
    // Layout tags drive semantic classification; save a durable ungenerated recovery point.
    // These source roles are not in the generator's vocabulary. Attach them to the facial surface.
    for(const p of faceDetails)await session.step('face-detail-'+p.id,'layer_classify',{layer_id:p.id,role:'face_detail',type:'preset'});
    for(const p of eyelidRims)await session.step('eyelid-crease-'+p.id,'layer_classify',{layer_id:p.id,role:'eyelash',side:has(p,'left')?'left':'right',type:'preset'});
    // These named anatomical layers have built-in eye/mouth opacity curves. An imported
    // provider toggle would override those curves and leave alternate art on a private axis.
    for(const p of restoreNative)await session.step('native-variant-'+p.id,'layer_set_variant',{layer_id:p.id,variant:'none'});
    for(const p of mouthToggles)await session.step('mouth-opacity-'+p.id,'layer_set_variant',{layer_id:p.id,variant:'toggle',parameter:'ParamMouthOpenY'});
    for(const variant of controls.variants)await session.step('control-variant-'+variant.layer_id,'layer_set_variant',variant);
    await session.step('save-layout','project_save_as',{path:path.join(dir,'layout.psd2live')});
    // Traced meshes extend beyond source raster bounds. HD rasters need texture-pixel
    // gutters too, otherwise their bound UVs sample an adjacent atlas tile at rest.
    await session.step('configure','settings_update',{changes:{generateDeformers:true,meshOnly:false,meshUnits:'DOCUMENT',meshTrace:'TEXTURE',texturePadding:32,seeThroughEyes:false,seeThroughBrows:false,mouthOutlineEnabled:!parts.some(p=>has(p,'mouth','line')),generatePhysics:false,exportMotions:true,exportMoc3:true,exportJson:true,exportIncludePhysics:false}});
    for(const p of parts) {
      const fine=has(p,'eye')||has(p,'mouth')||has(p,'brow')||has(p,'nose')||has(p,'face')||has(p,'ear')||hasRole(p,roles.raised)||hasRole(p,roles.rest)||hasRole(p,roles.continuous)||has(p,'elbow-fold')||has(p,'split-forearm')||has(p,'split-elbow-backing');
      const [l,t,r,b]=p.geometry.canvasBounds;
      const spacing=fine?Math.max(6,Math.min(16,Math.floor(Math.min(r-l,b-t)/5))):32;
      // PSD2Live calls this density but consumes a point spacing in document units (legal UI range 6..128).
      await session.step('mesh-'+p.id,'layer_mesh_update',{layer_id:p.id,changes:{edgeMode:fine?'TRIPLE':'DOUBLE',edgeWidth:fine?1:2,maxEdgeDistance:fine?Math.min(10,spacing):20,interiorDensity:spacing,wrap:0,...(has(p,'hair','front')?{outerMargin:3,wrap:5}:has(p,'hair','side')?{outerMargin:1,wrap:10}:{})}});
    }
    await session.step('generate-once','rig_generate',{});
    for(const item of source.meshRestores??[])await session.step('restore-source-'+item.layerId,'layer_replace_image',
      {layer_id:item.layerId,path:item.path,fit:'stretch',rebuild_mesh:false});
    const generation=await session.inspect('generation');
    if(!generation.generated||generation.pending_layers?.length||generation.pending_classifications?.length)throw new RigError('RIG_GENERATION_INCOMPLETE');
    const objects=await session.capturePlan('generated-objects',()=>session.list('objects'));
    const hidden=new Set(controls.variants.filter(v=>parts.find(p=>p.id===v.layer_id)?.visible===false).map(v=>v.layer_id));
    for(const p of nativeAlternates)if(p.visible===false)hidden.add(p.id);
    for(const o of objects.filter(o=>o.target.startsWith('mesh:')&&hidden.has(o.layerId)))
      await session.step('enable-'+o.target,'object_edit_appearance',{edits:[{action:'visibility',kind:'mesh',id:o.target.slice(5),visible:true}]});
    await session.step('save-baseline','project_save_as',{path:path.join(dir,'baseline.psd2live')});
    const portrait=source.manifest?.backend?.modelVersion==='anime-source-pixels-1';
    const sets=poseSets(artwork.brief,continuousWave,{portrait});
    let renderPoseSheet=(request)=>session.query('view_render_poses',request);
    let addedMaterialLayers=[];
    async function renderSheet(label,poses) {
      const ids=new Set((await session.list('parameters')).map(p=>p.id));
      const supported=poses.map(p=>Object.fromEntries(Object.entries(p).filter(([k])=>ids.has(k))));
      const request=view(canvas,parts,supported);
      if(label.startsWith('after-'))request.include_layer_ids.push(...addedMaterialLayers);
      const head=portrait&&/(?:headXY|midpoints|combined|mouth)$/.test(label);
      const focus=head?parts.filter(p=>['face','headwear','brow','eye','mouth'].some(t=>has(p,t))):
        label.endsWith('-eyes')?parts.filter(p=>has(p,'eye')||has(p,'brow')):label.endsWith('-mouth')?parts.filter(p=>has(p,'mouth')||has(p,'teeth')||has(p,'tongue')):[];
      if(focus.length) {
        const bounds=focus.map(p=>p.geometry.canvasBounds),l=Math.min(...bounds.map(b=>b[0])),t=Math.min(...bounds.map(b=>b[1])),r=Math.max(...bounds.map(b=>b[2])),b=Math.max(...bounds.map(b=>b[3]));
        const pad=Math.max(r-l,b-t)*(head ? .23 : .3);request.viewport={mode:'canvas_rect',left:l-pad,top:t-pad,width:r-l+2*pad,height:b-t+2*pad};
      }
      await session.assertCurrent();
      let r;
      try {r=await renderPoseSheet(request);}
      catch(error) {
        if(error.code!=='MAKER_REJECTED'||error.details?.operation!=='view_render_poses'||
          !error.message.includes('Fontconfig head is null'))throw error;
        renderPoseSheet=(next)=>renderIndividualPoses(session,next);
        r=await renderPoseSheet(request);
      }
      if(!r.images?.length)throw new RigError('ENGINE_RENDER_IMAGE_MISSING',label);
      if(r.data.tiles?.length!==supported.length||r.data.tiles.some((t,i)=>(t.outOfRangeParameters?.length??0)||Object.entries(supported[i]).some(([id,v])=>t.parameters?.[id]!==v)))throw new RigError('POSE_RENDER_VALUE_MISMATCH',label);
      await session.assertCurrent();
      const f=`rigging/poses/${label}.png`;decodePng(r.images[0]);await fs.writeFile(path.join(root,f),r.images[0]);
      await writeJson(path.join(dir,'poses',label+'.json'),{identity,projectId:journal.projectId,state:journal.state,poses:supported,requestedPoses:poses,viewport:request.viewport,metadata:r.data,kind:'engine_static_pose_sheet'});
      return f;
    }
    // Do not redraw baseline after a resume that has already authored refinements.
    for(const [label,poses] of Object.entries(sets))if(!journal.baselineSheets?.[label]) {
      if(Object.keys(journal.done).some(k=>k.startsWith('refine-')))throw new RigError('BASELINE_EVIDENCE_MISSING_USE_NEW_CANDIDATE');
      const f=await renderSheet('before-'+label,poses);journal.baselineSheets??={};journal.baselineSheets[label]=f;await session.persist();
    }
    const recipe=planRefinements(parts,objects,artwork.brief,{gate:artwork.productionScope?.gate});
    await writeJson(path.join(dir,'recipe.json'),{schemaVersion:1,engineVersion:ENGINE_VERSION,engineCommit:ENGINE_COMMIT,...(base.engineRuntimePatch?{engineRuntimePatch:base.engineRuntimePatch}:{}),identity,...recipe,refinementVersion,mouthTopologyVersion:MOUTH_TOPOLOGY_VERSION,expressionRefinementVersion:EXPRESSION_REFINEMENT_VERSION,...(waveReturn?{waveReturnRegistration:waveReturn.artifact}:{})});
    if(recipe.unmapped.length)throw new RigError('RIG_LAYERS_WITHOUT_MESH',recipe.unmapped.join(','));
    const sharedFace=await applySharedFaceRig(session,parts,objects,artwork.brief,{portrait,linkedBlink:portrait&&journal.linkedPortraitBlink===true});
    await writeJson(path.join(dir,'shared-face.json'),sharedFace);
    await applyGestureAxes(session,parts,artwork.brief);
    const mouthTopology=await refineMouthTopology(session,parts,objects);
    if(mouthTopology)await writeJson(path.join(dir,'mouth-topology.json'),mouthTopology);
    const expression=await applyExpressionRefinement(session,parts,objects,artwork.brief);
    if(expression)await writeJson(path.join(dir,'expression-refinement.json'),expression);
    const wave=await applyAnchoredWave(session,parts,objects,artwork.brief,{registration:waveReturn});
    if(wave)await writeJson(path.join(dir,'anchored-wave.json'),wave);
    const torsoBalance=parts.find(p=>p.id==='bodice')?.rigging?.torsoBalance;
    if(torsoBalance!==undefined) {
      if(!Number.isFinite(torsoBalance)||torsoBalance<=0||torsoBalance>.12)
        throw new RigError('TORSO_BALANCE_INVALID');
      const target='warp:DeformBodyLean';
      const {axes}=await session.query('workspace_inspect',{scope:'objects',target}).then(r=>r.data);
      if(axes?.ParamBodyAngleX)throw new RigError('TORSO_BALANCE_AXIS_ALREADY_AUTHORED');
      const keys=Object.entries(axes??{}).reduce((cells,[id,values])=>
        cells.flatMap(key=>values.map(value=>({...key,[id]:value}))),[{}]);
      const from=[[0,0],[1,0],[0,1],[1,1]];
      const shapes=[-10,10].flatMap(value=>keys.map(key=>{
        const shift=torsoBalance*value/10;
        return {target,key,value,operations:[{type:'landmarks',from,
          to:[[shift,0],[1+shift,0],[shift*.16,1],[1+shift*.16,1]]}]};
      }));
      const result=await session.step('torso-balance','author_axis',{
        parameter:{id:'ParamBodyAngleX',min:-10,max:10,default:0},shapes,
      });
      if(geometryWarnings(result.data).some(d=>(d.violations?.length??0)||(d.warnings?.length??0)))
        throw new RigError('POSED_GEOMETRY_REVIEW_REQUIRED','重心关键形返回几何警告。');
    }
    if(controls.motions.some(m=>m.curves.some(c=>c.parameter==='ParamGreetingBalance'))) {
      const target='warp:DeformBodyLean';
      const {axes}=await session.query('workspace_inspect',{scope:'objects',target}).then(r=>r.data);
      const keys=Object.entries(axes??{}).reduce((cells,[id,values])=>
        cells.flatMap(key=>values.map(value=>({...key,[id]:value}))),[{}]);
      const parameter={id:'ParamGreetingBalance',min:-1,max:1,default:0};
      const shapes=[-1,1].flatMap(value=>keys.map(key=>({target,key,value,operations:[
        {type:'rotate',degrees:value*3.2,pivot:[.5,.82]},
      ]})));
      const result=await session.step('greeting-balance','author_axis',{parameter,shapes});
      if(geometryWarnings(result.data).some(d=>(d.violations?.length??0)||(d.warnings?.length??0)))
        throw new RigError('POSED_GEOMETRY_REVIEW_REQUIRED','挥手重心关键形返回几何警告。');
    }
    const passiveSleeve=portrait&&journal.passiveSleeveSway===true&&parts.find(p=>p.id==='other-sleeve'&&has(p,'arm','sleeve'));
    const sleeveMesh=passiveSleeve&&objects.find(o=>o.layerId===passiveSleeve.id&&o.target.startsWith('mesh:'));
    const restingHand=passiveSleeve&&parts.find(p=>has(p,'arm','resting-wrist'));
    if(restingHand)await applyRestingWrist(session,passiveSleeve,restingHand,objects);
    else if(sleeveMesh?.parentId==='DeformBodyZBreath') {
      // Leave the shoulder join fixed. Let the idle wrist settle with body
      // weight instead of moving only with the common torso transform.
      const torso=parts.find(p=>p.id==='bodice');
      const leftOfTorso=torso&&passiveSleeve.rect.left<torso.rect.left;
      const from=[[0,0],[1,0],[0,1],[1,1]];
      const sway=await session.step('passive-sleeve-body-sway','author_axis',{
        parameter:{id:'ParamBodyAngleX',min:-10,max:10,default:0},
        shapes:[-10,10].map(value=>{
          const shift=value*.009*(leftOfTorso?-1:1);
          return {target:sleeveMesh.target,value,operations:[{type:'landmarks',from,to:[[0,0],[1,0],[shift,1],[1+shift,1]]}]};
        }),
      });
      const diagnostics=geometryWarnings(sway.data);
      if(diagnostics.some(d=>(d.violations?.length??0)||(d.warnings?.length??0)))
        throw new RigError('POSED_GEOMETRY_REVIEW_REQUIRED','待机侧袖关键形存在几何警告，保留候选待修。',{diagnostics});
    }
    if(recipe.apertureResets.length)await session.step('reset-apertures','keyform_apply',{changes:recipe.apertureResets});
    for(let i=0;i<recipe.apertureDeformations.length;i+=64) {
      const r=await session.step('repair-apertures-'+i,'rig_deform',{changes:recipe.apertureDeformations.slice(i,i+64)});
      if(geometryWarnings(r.data).some(d=>(d.violations?.length??0)||(d.warnings?.length??0)))throw new RigError('POSED_GEOMETRY_REVIEW_REQUIRED','眼嘴开合修正返回几何警告。');
    }
    for(const [i,step] of recipe.steps.entries()) {
      const r=await session.step('refine-'+i,'author_axis',step);const diagnostics=geometryWarnings(r.data);
      if(diagnostics.some(d=>(d.violations?.length??0)||(d.warnings?.length??0)))throw new RigError('POSED_GEOMETRY_REVIEW_REQUIRED','实际编辑返回几何警告或违规，保留候选定位后再修。',{diagnostics});
    }
    for(let i=0;i<recipe.rimOpacity.length;i+=120)await session.step('refine-rim-opacity-'+i,'keyform_apply',{changes:recipe.rimOpacity.slice(i,i+120)});
    for(const {layerId,image} of repair?.replacements??[]) {
      if(source.composedReplacementIds?.includes(layerId))continue;
      const {data}=await session.step('material-repair-'+layerId,'layer_replace_image',{layer_id:layerId,path:image,rebuild_mesh:false});
      if(!data.applied)throw new RigError('RIG_MATERIAL_REPAIR_NOT_APPLIED',layerId);
    }
    for(const {layerId,order} of repair?.drawOrder??[])
      await session.step('material-order-'+layerId,'layer_draw_order',{target:'layer:'+layerId,order});
    if(repair?.backing) {
      const {image,parent,behind,at}=repair.backing;
      const {data}=await session.step('material-repair-backing','layer_import_images',
        {paths:[image],parent_deformer_id:parent,anchor_layer_id:behind,in_front:false,at});
      if(!data.applied||data.affectedLayerIds?.length!==1)throw new RigError('RIG_MATERIAL_REPAIR_NOT_APPLIED');
      addedMaterialLayers=data.affectedLayerIds;
    }
    const headRange=await applyHeadRangeClamps(session,validateMotion(artwork.brief));
    await writeJson(path.join(dir,'head-range.json'),headRange);
    const finalObjects=addedMaterialLayers.length?await session.list('objects'):objects;
    const topologies=await readTopologies(session,finalObjects);
    await writeJson(path.join(dir,'topology.json'),{identity,projectId:journal.projectId,state:journal.state,topologies});
    if(topologies.some(t=>!t.ok))throw new RigError('MESH_TOPOLOGY_INVALID');
    check('rigging_rest_topology','automated','passed','真实 rest 网格无退化/非法索引/混绕向/非流形；不等于姿态视觉验收。','rigging/topology.json');
    const registeredWave=controls.motions.find(motion=>motion.id==='wave');
    const clip=previewClip(artwork.brief,continuousWave,registeredWave),existingIds=new Set((await session.list('parameters')).map(p=>p.id));
    clip.curves=clip.curves.filter(c=>existingIds.has(c.parameter));
    await session.step('preview-clip','motion_put',{clip});
    await session.step('save-candidate-'+refinementVersion,'project_save_as',{path:path.join(dir,'candidate.psd2live')});
    const psdExport=await session.step('export-psd-'+refinementVersion,'project_export_psd',{path:path.join(dir,'candidate.psd'),scale:1,include_generated_layers:true});
    await session.step('export-model-'+refinementVersion,'project_export_model',{output_directory:path.join(dir,'model')});
    const previewDir=path.join(dir,'preview');await fs.mkdir(previewDir,{recursive:true});
    // Native raster animation export; no fabricated film and no renderer substitution.
    await session.step('export-animation-'+refinementVersion,'project_export_target',{target:'gif',output_directory:previewDir,settings:{clip:'rigging-preview',fps:'24',size:'768',background:'FF273342'}});
    await session.step('save-before-reopen-'+refinementVersion,'project_save',{});
    const preOpenParameters=await session.list('parameters');
    const preOpenAxes=await readAxes(session,finalObjects);
    await session.step('reopen-'+refinementVersion,'project_open',{path:path.join(dir,'candidate.psd2live'),discard_unsaved:false},{lifecycle:true});
    const reopenedObjects=await session.list('objects'),parameters=await session.list('parameters'),axes=await readAxes(session,reopenedObjects);
    if(parameterSnapshot(parameters)!==parameterSnapshot(preOpenParameters)||JSON.stringify(canonical(axes))!==JSON.stringify(canonical(preOpenAxes)))throw new RigError('REOPEN_BINDINGS_CHANGED');
    const reopenedTopologies=await readTopologies(session,reopenedObjects);
    await writeJson(path.join(dir,'reopen-topology.json'),{identity,projectId:journal.projectId,state:journal.state,topologies:reopenedTopologies});
    if(JSON.stringify(canonical(topologies))!==JSON.stringify(canonical(reopenedTopologies)))throw new RigError('REOPEN_TOPOLOGY_CHANGED');
    check('rigging_save_reopen','automated','passed','实际 project_open 后参数、直接轴、继承链、clipping 与 rest 点/三角索引哈希一致。','rigging/reopen-topology.json');
    const finalSets={};for(const [label,poses] of Object.entries(sets))finalSets[label]=await renderSheet('after-'+label,poses);
    const parameterMap=await buildParameterMap(session,recipe.specs,parameters,axes,{root,dir,identity,brief:artwork.brief,canvas,parts,waveOwnership});
    parameterMap.refinementVersion=refinementVersion;
    if(mouthTopology)parameterMap.mouthTopologyVersion=MOUTH_TOPOLOGY_VERSION;
    if(waveReturn)parameterMap.waveReturnRegistration={...waveReturn.artifact,ownership:waveOwnership};
    if(base.engineRuntimePatch)parameterMap.engineRuntimePatch=base.engineRuntimePatch;
    parameterMap.dynamics={motions:controls.motions,appearances:controls.appearances};
    parameterMap.poseSets={before:journal.baselineSheets,after:finalSets};
    await writeJson(path.join(dir,'parameter-map.json'),parameterMap);base.parameterMapPath='rigging/parameter-map.json';
    const missing=[...requiredParameters(artwork.brief),...controls.specs.map(s=>s.id)].filter(id=>!parameterMap.parameters.some(p=>p.id===id&&p.available));
    if(missing.length)base.unresolved.push(issue('RIG_PARAMETER_NOT_MOVING','缺少真实可动绑定：'+missing.join(', ')));
    const models=await findModels(path.join(dir,'model'));
    if(models.length!==1)throw new RigError('EXPORTED_MODEL_ENTRY_AMBIGUOUS');
    const model=await inspectModel(models[0]);if(!model.ok)throw new RigError('EXPORTED_MODEL_REFERENCES_INVALID',JSON.stringify(model.errors));
    const psd=await fs.readFile(path.join(dir,'candidate.psd'));if(psd.length<26||psd.toString('ascii',0,4)!=='8BPS'||
      psd.readUInt16BE(4)!==1||psd.readUInt32BE(14)!==canvas.height||psd.readUInt32BE(18)!==canvas.width||
      psdExport.data.path!==path.join(dir,'candidate.psd')||psdExport.data.bytes!==psd.length||!Number.isInteger(psdExport.data.layers)||psdExport.data.layers<parts.length)throw new RigError('LAYERED_PSD_EXPORT_INVALID');
    const projects=await fs.readFile(path.join(dir,'candidate.psd2live'));if(projects.toString('ascii',0,2)!=='PK')throw new RigError('PROJECT_ARCHIVE_INVALID');
    const previews=(await fs.readdir(previewDir)).filter(f=>f.endsWith('.gif'));
    if(previews.length!==1)throw new RigError('ENGINE_ANIMATION_MISSING');
    const animation=inspectGif(await fs.readFile(path.join(previewDir,previews[0])));if(animation.frames<2||animation.durationSeconds<1)throw new RigError('ENGINE_ANIMATION_INVALID');
    base.projectPath='rigging/candidate.psd2live';base.psdPath='rigging/candidate.psd';base.modelPath=path.relative(root,models[0]).split(path.sep).join('/');
    base.engineVersion=ENGINE_VERSION;base.engineProjectId=journal.projectId;base.engineRevision=journal.state;
    await collectArtifacts(root,dir,base);
    check('rigging_export_integrity','automated','passed','从本工程实际导出，模型引用存在；不代表 Cubism/Leaf 运行兼容。');
    check('rigging_visual_review','visual','not_run','需查看本候选 before/after 九宫格、眼嘴近景及实际动画；程序不自授美术通过。');
    check('rigging_runtime_follow','runtime','not_run','尚未验证运行器与真人跟随。');
    check('rigging_user_acceptance','user_acceptance','not_run');
    base.unresolved.push(issue('RIG_VISUAL_REVIEW_REQUIRED','候选已生成实际证据，需模型观察/人审确认体积、遮挡与连续过渡；当前不得当作精细成品交付。'));
    base.warnings.push('轮廓定位只是 alpha 几何依据；不等于语义地标或参考质量。参数可动只说明实际渲染变化。');
    return await saveResult();
  } catch(error) {
    const pending=session?.journal.pending;
    base.status=pending?'awaiting_external_result':error instanceof RigError&&error.code!=='ENOSPC'?'blocked':'failed';
    base.unresolved.push(issue(error.code??'RIGGING_FAILED',error.message));
    if(pending)base.pending=structuredClone(pending);else delete base.pending;
    if(dir&&lock) {
      await writeJson(path.join(dir,'failure.json'),{code:error.code??'RIGGING_FAILED',message:error.message,details:error.details??{},pending:pending??null});
      try {await collectArtifacts(ctx.taskRoot,dir,base);}catch {base.warnings.push('失败候选部分文件无法登记；原始失败与 pending 保留在 rigging/failure.json。');}
      return await saveResult();
    }
    return base;
  } finally {
    if(lock) {await lock.close();await fs.unlink(path.join(dir,'.build.lock'));}
  }
}

async function readTopologies(session,objects) {
  const result=[];
  for(const object of objects.filter(o=>o.target.startsWith('mesh:')).sort((a,b)=>a.target.localeCompare(b.target))) {
    const pages=async section=>{let offset=0;const all=[];for(;;){
      const r=(await session.query('mesh_get_topology',{target:object.target,section,offset,limit:4096})).data;
      if(r.coordinate_space!=='mesh_rest')throw new RigError('TOPOLOGY_COORDINATE_SPACE');all.push(...r.items);
      if(r.next_offset===undefined)break;if(!Number.isInteger(r.next_offset)||r.next_offset<=offset)throw new RigError('TOPOLOGY_PAGINATION');offset=r.next_offset;
    }return all;};
    const vertices=await pages('vertices'),triangles=await pages('triangles');
    result.push({target:object.target,...inspectTopology(vertices,triangles),restSha256:digest(Buffer.from(JSON.stringify({vertices,triangles})))});
  }
  return result;
}

async function readAxes(session,objects) {
  const rows=[],parents=new Map();
  for(const o of objects.filter(o=>o.target.startsWith('mesh:')).sort((a,b)=>a.target.localeCompare(b.target))) {
    const d=(await session.query('workspace_inspect',{target:o.target})).data;
    const inherited=[];
    for(const p of [...(d.inherited??[])].sort((a,b)=>a.target.localeCompare(b.target))) {
      if(!parents.has(p.target))parents.set(p.target,(await session.query('workspace_inspect',{target:p.target})).data);
      inherited.push({...p,axes:parents.get(p.target).axes??{}});
    }
    rows.push({target:o.target,layerId:o.layerId,forms:d.forms??0,directAxes:d.axes??{},opacityAxes:d.channels?.find(c=>c.channel==='opacity')?.axes??{},inherited,static:d.static??{}});
  }
  return rows;
}
export function parameterBindings(id,axes) {
  return axes.filter(a=>(a.directAxes[id]?.length??0)>=2||(a.opacityAxes?.[id]?.length??0)>=2||a.inherited.some(p=>(p.axes?.[id]?.length??0)>=2))
    .map(a=>({target:a.target,layerId:a.layerId,directAxes:a.directAxes,opacityAxes:a.opacityAxes??{},inherited:a.inherited}));
}
export function parameterAvailability(bindings,evidence) {
  return bindings.length>0&&evidence.length>0&&evidence.every(e=>e.changedPixels>0);
}
export async function buildParameterMap(session,specs,parameters,axes,{root,dir,identity,brief,canvas,parts,waveOwnership}) {
  const rows=[],{finalVariants:variants}=controlRecipe(parts,brief,{waveOwnership});
  if(parts.some(p=>has(p,'mouth','closed')))for(const p of parts.filter(p=>has(p,'mouth','open')||has(p,'mouth','closed'))) {
    variants.push({layer_id:p.id,parameter:'ParamMouthOpenY',switch_id:has(p,'mouth','open')?1:0});
  }
  for(const spec of specs) {
    const actual=parameters.find(p=>p.id===spec.id),bindings=parameterBindings(spec.id,axes),motionEvidence=[],switchEvidence=[],rimEvidence=[];
    if(actual&&bindings.length) {
      const ids=[...new Set(bindings.map(b=>b.layerId).filter(Boolean))];
      const request={...view(canvas,parts),include_layer_ids:ids,target_long_edge:768};
      const context=spec.id.startsWith('ParamGreeting')?{ParamWave:.53}:
        ['ParamWaveLift','ParamWaveWrist'].includes(spec.id)?{ParamWave:1}:spec.id==='ParamMouthForm'?{ParamMouthOpenY:.5}:{};
      const render=async(value,label,layers=ids,viewport)=> {
        await session.assertCurrent();const r=await session.query('view_render_model',{...request,...(viewport?{viewport}:{}),include_layer_ids:layers,parameters:{...context,[spec.id]:value}});
        if(!r.images?.[0])throw new RigError('PARAMETER_RENDER_MISSING',spec.id);
        if(r.data.appliedParameters?.[spec.id]!==value||Object.entries(context).some(([k,v])=>r.data.appliedParameters?.[k]!==v)||(r.data.outOfRangeParameters?.length??0))throw new RigError('PARAMETER_RENDER_VALUE_MISMATCH',spec.id);
        await session.assertCurrent();
        const f=`rigging/parameter-evidence/${spec.id}-${label}.png`;await fs.writeFile(path.join(root,f),r.images[0]);return {file:f,image:decodePng(r.images[0]),metadata:r.data};
      };
      const neutral=await render(actual.default,'default');
      const headLimit=({ParamAngleX:brief.intent.headMotion.yawDegrees,ParamAngleY:brief.intent.headMotion.pitchDegrees,ParamAngleZ:brief.intent.headMotion.rollDegrees})[spec.id];
      const values=[headLimit===undefined?actual.min:Math.max(actual.min,-headLimit),headLimit===undefined?actual.max:Math.min(actual.max,headLimit)].filter(v=>v!==actual.default);
      for(const value of [...new Set(spec.sampleValues??values)]) {
        const posed=await render(value,String(value));motionEvidence.push({value,defaultImage:neutral.file,posedImage:posed.file,defaultMetadata:neutral.metadata,posedMetadata:posed.metadata,...pixelDifference(neutral.image,posed.image),context});
      }
      for(const {layer_id,switch_id} of variants.filter(v=>v.parameter===spec.id)) {
        const layerBound=bindings.some(b=>b.layerId===layer_id&&(b.opacityAxes[spec.id]?.length??0)>=2);
        const at=async value=>{
          const rendered=await render(value,layer_id+'-'+value,[layer_id]);let pixels=0;
          for(let i=3;i<rendered.image.rgba.length;i+=4)if(rendered.image.rgba[i]>=16)pixels++;
          return {value,file:rendered.file,pixels};
        };
        const on=await at(switch_id),off=await at(1-switch_id);
        switchEvidence.push({layerId:layer_id,on,off,passed:layerBound&&on.pixels>0&&off.pixels===0});
      }
      for(const p of parts.filter(p=>eyeRimAxis(p)===spec.id)) {
        const binding=bindings.find(b=>b.layerId===p.id),keys=binding?.opacityAxes?.[spec.id]??[];
        const aperture='warp:DeformSharedAperture'+(has(p,'left')?'L':'R');
        const shared=binding?.inherited.some(i=>i.target===aperture&&(i.axes?.[spec.id]?.length??0)>=2);
        const [l,t,r,b]=p.geometry.canvasBounds,pad=(r-l)*.25;
        const viewport={mode:'canvas_rect',left:l-pad,top:t-pad,width:r-l+2*pad,height:b-t+2*pad};
        const samples=[];
        for(const v of [1,.5,0])samples.push(await render(v,p.id+'-'+v,[p.id],viewport));
        const motion=eyeRimAperture(...samples.map(s=>s.image));
        rimEvidence.push({...motion,layerId:p.id,keys,aperture,shared,viewport,files:samples.map(s=>s.file),passed:motion.passed&&shared&&[0,.2,1].every(v=>keys.includes(v))});
      }
    }
    const available=Boolean(actual)&&parameterAvailability(bindings,motionEvidence)&&switchEvidence.every(e=>e.passed)&&rimEvidence.every(e=>e.passed);
    rows.push({...spec,...(actual?{min:actual.min,max:actual.max,default:actual.default}:{}),available,targets:bindings.map(b=>b.target),bindings,motionEvidence,...(switchEvidence.length?{switchEvidence}:{}),...(rimEvidence.length?{rimEvidence}:{}),
      reason:available?'axes_and_nonzero_engine_render':!actual?'parameter_missing':!bindings.length?'no_bound_geometry':rimEvidence.some(e=>!e.passed)?'eye_rim_aperture_or_opacity_mismatch':switchEvidence.some(e=>!e.passed)?'switch_endpoint_mismatch':'no_proven_render_change',
      authoredRange:motionEvidence.length?[Math.min(actual.default,...motionEvidence.map(e=>e.value)),Math.max(actual.default,...motionEvidence.map(e=>e.value))]:null});
  }
  return {schemaVersion:1,...identity,engineVersion:ENGINE_VERSION,engineCommit:ENGINE_COMMIT,projectId:session.journal.projectId,state:session.journal.state,parameters:rows,requested:structuredClone(brief.intent),
    unavailableSemantics:['hair.front','hair.back','accessory'].filter(s=>!rows.some(p=>p.semantic.startsWith(s)&&p.available)),
    poseSets:{},unresolved:rows.filter(p=>!p.available).map(p=>({id:p.id,reason:p.reason})),
    evidenceLimit:'真实 axes 与单参数实际栅格变化；不是艺术质量、物理效果、运行器兼容或真人跟随通过。'};
}
function requiredParameters(brief) {
  const p=[];for(const [id,key] of [['ParamAngleX','yawDegrees'],['ParamAngleY','pitchDegrees'],['ParamAngleZ','rollDegrees']])if(brief.intent.headMotion[key]>0)p.push(id);
  if(brief.intent.eyes.blink)p.push('ParamEyeLOpen','ParamEyeROpen');if(brief.intent.eyes.gaze)p.push('ParamEyeBallX','ParamEyeBallY');
  if(brief.intent.mouth.speech)p.push('ParamMouthOpenY','ParamMouthForm');if(brief.intent.expressions.length)p.push('ParamBrowLY','ParamBrowRY','ParamEyeSmile');
  if(brief.intent.expressions.some(e=>e.id==='angry'))p.push('ParamEyeAngry');
  if(brief.intent.expressions.some(e=>e.id==='surprise'))p.push('ParamEyeSurprise');return p;
}
async function collectArtifacts(root,dir,base) {
  async function walk(folder) {for(const e of await fs.readdir(folder,{withFileTypes:true})) {
    if(e.isSymbolicLink())throw new RigError('EXPORT_SYMLINK');const f=path.join(folder,e.name);
    if(e.isDirectory())await walk(f);
    else if(!['.build.lock','state.json','stage.json','failure.json'].includes(e.name)&&!e.name.endsWith('.tmp')) {
      const relative=path.relative(root,f).split(path.sep).join('/');if(!base.artifacts.some(a=>a.path===relative))base.artifacts.push(await artifact(root,'rigging_'+(relative.endsWith('.png')?'engine_image':relative.endsWith('.gif')?'engine_animation':'file'),relative));
    }
  }}
  await walk(dir);
}

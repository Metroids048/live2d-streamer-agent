import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildPackage, verifyPackage, verifyPackageArchive, planDelivery} from '../src/packaging/index.mjs';
import {artifact, inventory} from '../src/packaging/files.mjs';
import {archive} from '../src/packaging/archive.mjs';
import {registerCompletedCandidate,completedCandidateSources} from '../src/pipeline/completed-candidate.mjs';
import {recordRigReview,rigCriteriaFor} from '../src/rigging/review.mjs';
import {recordDynamicsReview} from '../src/dynamics/review.mjs';
import {previewCriteria} from '../src/dynamics/preview.mjs';
import {ffmpeg} from '../src/preview.mjs';
import {encodePng} from '../src/artwork/png.mjs';
import {Maker} from '../src/maker.mjs';
import {deliver} from '../src/delivery.mjs';

// Synthetic format fixtures, NOT an accepted character or a human performance.
const hash = data => createHash('sha256').update(data).digest('hex');
const png = encodePng({width:1,height:1,data:Buffer.from([224,160,120,255])});
const u32 = n => {const b = Buffer.alloc(4); b.writeUInt32BE(n); return b;};
const i16 = n => {const b = Buffer.alloc(2); b.writeInt16BE(n); return b;};
function layeredPsd() {
  const header = Buffer.alloc(26); header.write('8BPS'); header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12); header.writeUInt32BE(1, 14); header.writeUInt32BE(1, 18); header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24);
  const extra = Buffer.concat([u32(0), u32(0), Buffer.from([1, 65, 0, 0])]);
  const record = Buffer.concat([u32(0), u32(0), u32(1), u32(1), i16(1), i16(0), u32(3), Buffer.from('8BIMnorm'), Buffer.from([255, 0, 0, 0]), u32(extra.length), extra]);
  const info = Buffer.concat([i16(2), record, record, Buffer.from([0, 0, 255, 0, 0, 255])]);
  const layers = Buffer.concat([u32(info.length), info, u32(0)]);
  return Buffer.concat([header, u32(0), u32(0), u32(layers.length), layers, Buffer.from([0, 0, 255, 255, 255])]);
}

async function packageFixture(t, persistent = false, {revision = 8, parentRevision = 7} = {}) {
  const keep = persistent && process.env.PACKAGING_EVIDENCE_ROOT;
  const base = keep ? path.resolve(keep) : await fs.mkdtemp(path.join(os.tmpdir(), 'live2d-package-'));
  if (keep) await fs.mkdir(base, {recursive: true}); else t.after(() => fs.rm(base, {recursive: true, force: true}));
  const root = await fs.realpath(base), put = async (name, data) => {
    await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true}); await fs.writeFile(path.join(root, name), data);
  };
  const write = (name, value) => put(name, JSON.stringify(value));
  const d = {schemaVersion: 1, taskId: '12345678-1234-1234-1234-123456789abc', candidateId: 'fixture-character', revision, parentRevision,
    inputSha256: hash(png), descriptionSha256: hash('fixture-request'), stage: 'dynamics', status: 'completed',
    engineVersion: '3.6.7', projectId: 'fixture-native', rights: {source: '纯合成格式测试', license: 'fixture-only', allowDerivatives: true, allowRedistribution: false, userDeclared: true},
    modelPath: 'dynamics/中文模型/角色.model3.json', projectPath: 'dynamics/可编辑.psd2live', psdPath: 'rigging/分层.psd',
    parameterMapPath: 'rigging/parameter-map.json', dynamicsManifestPath: 'dynamics/dynamics-manifest.json', artifacts: [], checks: [], warnings: ['FIXTURE_ONLY'], unresolved: []};
  const ident=Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,d[k]]));
  const ids=(...ids)=>ids.map(id=>({id}));
  const intent={expressions:ids('happy','angry'),actions:ids('wave','reset'),clothingVariants:ids('chest_bow')};
  d.brief={...ident,originalDescription:'fixture-request',intent};
  await write(d.modelPath, {Version: 3, FileReferences: {Moc: '角色.moc3', Textures: ['纹理/图集.png'],
    Physics: '角色.physics3.json', Pose: '角色.pose3.json', DisplayInfo: '角色.cdi3.json', UserData: '角色.userdata3.json',
    Expressions: [{Name: '开心', File: '表情/开心.exp3.json'}, {Name: '生气', File: '表情/生气.exp3.json'}, {Name:'摘下胸前蝴蝶结', File:'表情/蝴蝶结.exp3.json'}],
    Motions: {Idle: [{File: '动作/待机.motion3.json', Sound: '音频/示例.wav'}], 招手:[{File:'动作/招手.motion3.json'}]}}});
  const modelDir = path.posix.dirname(d.modelPath);
  await put(`${modelDir}/角色.moc3`, Buffer.from('MOC3-FIXTURE-NOT-LOADABLE')); await put(`${modelDir}/纹理/图集.png`, png);
  for (const file of ['角色.physics3.json','角色.pose3.json','角色.userdata3.json']) await write(modelDir+'/'+file,{Version:3,fixtureOnly:true});
  const parameters=[['ParamMouthOpenY','mouth.open'],['ParamHappy','expression.eye'],['ParamWave','action.wave'],['ParamChestBowHidden','appearance.chest_bow.hidden'],['ParamBreath','body.breath']]
    .map(([id,semantic])=>({id,semantic,min:-1,max:1,default:0,available:true}));
  await write(modelDir+'/角色.cdi3.json',{Version:3,Parameters:parameters.map(p=>({Id:p.id,Name:p.id}))});
  for (const [file,Id,Value] of [['开心','ParamHappy',1],['生气','ParamHappy',-1],['蝴蝶结','ParamChestBowHidden',1]])
    await write(modelDir+'/表情/'+file+'.exp3.json',{Type:'Live2D Expression',Parameters:[{Id,Value,Blend:'Add'}]});
  for(const [file,Id,Loop] of [['待机','ParamBreath',true],['招手','ParamWave',false]])
    await write(modelDir+'/动作/'+file+'.motion3.json',{Version:3,Meta:{Loop,Duration:2},Curves:[{Target:'Parameter',Id,Segments:[0,0,0,1,1,0,2,0]}]});
  await put(modelDir+'/音频/示例.wav',Buffer.from('RIFF-FIXTURE'));
  await write(d.parameterMapPath,{...ident,requested:intent,parameters,dynamics:{appearances:[{id:'chest_bow',parameter:'ParamChestBowHidden',on:1,off:0}]}});
  await put(d.psdPath, layeredPsd());
  const nativeRoot = path.join(root, 'native-fixture'); await fs.mkdir(nativeRoot);
  const source = {rgbaBlob: 'synthetic-raster', rasterWidth: 1, rasterHeight: 1};
  const sourceData = Buffer.from(JSON.stringify({schema: 1, kind: 'source', value: {layers: [source]}}));
  const nativeFiles = {'history/HEAD.json': Buffer.from(JSON.stringify({headNodeId: 'fixture-head', nodeOrder: ['fixture-head']})),
    [`history/nodes/${hash('fixture-head')}.json`]: Buffer.from(JSON.stringify({id: 'fixture-head', snapshotHash: 'fixture-snapshot'})),
    [`history/revisions/${hash('fixture-snapshot')}.json`]: Buffer.from(JSON.stringify({schema: 1, nodes: {source: hash(sourceData)}})),
    [`document/nodes/source/${hash(sourceData)}.json`]: sourceData,
    [`assets/${hash(source.rgbaBlob)}-1x1.png`]: png};
  for (const [name, data] of Object.entries(nativeFiles)) {await fs.mkdir(path.dirname(path.join(nativeRoot, name)), {recursive: true}); await fs.writeFile(path.join(nativeRoot, name), data);}
  await fs.writeFile(path.join(nativeRoot, 'manifest.json'), JSON.stringify({format: 'PSD2Live', version: 2, projectId: d.projectId,
    files: Object.fromEntries(Object.entries(nativeFiles).map(([name, data]) => [name, hash(data)]))}));
  await archive({action: 'make', root: nativeRoot, file: path.join(root, d.projectPath), files: ['manifest.json', ...Object.keys(nativeFiles)]});
  await fs.rm(nativeRoot, {recursive: true});
  await put('dynamics/制作预览.mp4', Buffer.concat([u32(24), Buffer.from('ftypisom'), Buffer.alloc(12)])); await put('dynamics/封面.png', png);
  const manifest = {...d, expressions: [
    ['dyn_happy','开心','开心','emotion','ParamHappy'],['dyn_angry','生气','生气','emotion','ParamHappy'],
    ['dyn_appearance_chest_bow','摘下胸前蝴蝶结','蝴蝶结','appearance.chest_bow.hidden','ParamChestBowHidden']].map(([id,name,file,exclusiveGroup,p],i)=>
    ({id,name,file:modelDir+'/表情/'+file+'.exp3.json',exclusiveGroup,parameters:[p],leafExpressionId:String(i)})),
    motions: [['dyn_idle','待机','Idle','ParamBreath',true],['dyn_wave','招手','招手','ParamWave',false]]
      .map(([id,file,group,p,loop])=>({id,file:modelDir+'/动作/'+file+'.motion3.json',group,index:0,leafMotionId:group+':0',parameters:[p],loop,duration:2})),
    preview: {kind: 'parameter-animation', videoPath: 'dynamics/制作预览.mp4', coverPath: 'dynamics/封面.png',
      modelSha256: (await artifact(root, d.modelPath)).sha256, projectSha256: (await artifact(root, d.projectPath)).sha256}};
  await write(d.dynamicsManifestPath, manifest);
  const rect={left:0,top:0,width:1,height:1};
  d.layoutPath='artwork/layout.json';d.artworkManifestPath='artwork/artwork-manifest.json';
  await put('artwork/face.png',png);
  await write(d.layoutPath,{format:'psd2live-layout',version:1,canvas:{width:1,height:1},
    layers:['face','detail'].map(id=>({id,name:id,image:{path:'face.png',width:1,height:1},rect}))});
  const sourceParts=['face','detail'].map(id=>({id,path:'face.png',sha256:hash(png),rect}));
  const artworkFingerprint=hash(JSON.stringify({layoutSha256:hash(await fs.readFile(path.join(root,d.layoutPath))),
    parts:sourceParts.map(({id,sha256,rect})=>({id,sha256,rect}))}));
  await write(d.artworkManifestPath,{schemaVersion:1,...ident,artworkFingerprint,layoutPath:d.layoutPath,
    parts:sourceParts});
  await write('artwork/stage.json',{schemaVersion:1,...ident,stage:'artwork',status:'completed',layoutPath:d.layoutPath,
    artworkManifestPath:d.artworkManifestPath,artworkFingerprint,checks:[],unresolved:[],
    artifacts:await Promise.all([d.layoutPath,d.artworkManifestPath,'artwork/face.png'].map(p=>artifact(root,p,'fixture')))});
  await put('intake/source.png', png); await write('intake/private-request.json', {secretPrompt: 'must-not-ship'});
  d.artifacts = await inventory(root);
  const ctx = {taskRoot: root, taskId: d.taskId, candidateId: d.candidateId, revision: d.revision, parentRevision: d.parentRevision};
  const refresh = async name => {d.artifacts = d.artifacts.filter(a => a.path !== name); d.artifacts.push(await artifact(root, name, 'fixture'));};
  return {root, d, ctx, put, write, manifest, refresh};
}

const keys=['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'];
// Format/ownership fixtures only. Passing synthetic observations here is not a
// visual review of a real character; all files live in fresh temporary roots.
async function fixture(t,{reduced=false,scope}={}) {
  const f=await packageFixture(t),{root,put,write}=f,ident=Object.fromEntries(keys.map(k=>[k,f.d[k]]));
  const originalBrief=structuredClone(f.d.brief);
  if(reduced) {
    f.d.brief={...f.d.brief,intent:{...f.d.brief.intent,actions:[{id:'reset'}],clothingVariants:[]}};
    f.manifest.brief=f.d.brief;
    f.manifest.expressions=f.manifest.expressions.filter(e=>!e.id.startsWith('dyn_appearance_'));
    f.manifest.motions=f.manifest.motions.filter(m=>m.id==='dyn_idle');
  }
  const originalMap=JSON.parse(await fs.readFile(path.join(root,f.d.parameterMapPath)));
  await write(f.d.parameterMapPath,{...originalMap,requested:f.d.brief.intent});
  await promisify(execFile)(ffmpeg,['-v','error','-f','lavfi','-i','color=black:s=16x16:r=10','-t','1','-an','-c:v','libx264','-threads','1','-y',path.join(root,'dynamics/制作预览.mp4')]);
  const poseSets={before:{},after:{}};
  for(const phase of ['before','after'])for(const key of ['headXY','midpoints','eyes','mouth',...(!reduced?['wave','bow']:[])]) {
    const relative=`rigging/poses/${phase}-${key}.png`;poseSets[phase][key]=relative;
    await put(relative,png);await write(relative.replace(/\.png$/,'.json'),{identity:ident});
  }
  const gif=Buffer.from('47494638396101000100800000000000ffffff21f90401640000002c00000000010001000002024401003b','hex');
  await put('rigging/preview/fixture.gif',Buffer.concat([gif.subarray(0,19),gif.subarray(19,-1),gif.subarray(19)]));
  const map=JSON.parse(await fs.readFile(path.join(root,f.d.parameterMapPath)));
  await write(f.d.parameterMapPath,{...map,projectId:f.d.projectId,state:'fixture-state',poseSets});
  await write('rigging/state.json',{identity:ident,projectId:f.d.projectId,state:'fixture-state',pending:null});
  let rig={...f.d,stage:'rigging',status:'blocked',engineProjectId:f.d.projectId,engineRevision:'fixture-state',
    artifacts:(await inventory(root)).filter(a=>![f.d.dynamicsManifestPath,'artwork/stage.json'].includes(a.path)),checks:['rigging_input_integrity','rigging_rest_topology','rigging_save_reopen','rigging_export_integrity']
      .map(name=>({name,layer:'automated',status:'passed'})),unresolved:[{code:'RIG_VISUAL_REVIEW_REQUIRED'}]};
  await write('rigging/stage.json',rig);
  const evidence=[rig.projectPath,rig.psdPath,rig.modelPath,rig.parameterMapPath,
    ...Object.values(poseSets).flatMap(p=>Object.values(p)),...Object.values(poseSets).flatMap(p=>Object.values(p).map(v=>v.replace(/\.png$/,'.json'))),'rigging/preview/fixture.gif']
    .map(p=>rig.artifacts.find(a=>a.path===p));
  rig=await recordRigReview(rig,{id:'fixture-rig-pass',candidate:ident,reviewer:{kind:'model',name:'Synthetic contract fixture'},
    watchedContinuously:true,range:[0,2],evidence:evidence.map(({path,sha256})=>({path,sha256})),
    observations:rigCriteriaFor(rig.brief).map(criterion=>({criterion,status:'passed',from:0,to:2,
      note:'Synthetic observation only, not character acceptance',evidencePaths:evidence.map(a=>a.path)}))},{...ident,taskRoot:root});
  const preview={...f.manifest.preview,videoSha256:hash(await fs.readFile(path.join(root,'dynamics/制作预览.mp4'))),
    duration:1,fps:10,frameCount:10,requiredCriteria:[...previewCriteria,
      ...f.manifest.motions.filter(m=>m.id!=='dyn_idle').map(m=>'additional-motion:'+m.id),
      ...f.manifest.expressions.filter(e=>e.id.startsWith('dyn_appearance_')).map(e=>'appearance-toggle-restore:'+e.id)],
    captureReportPath:'dynamics/preview/capture-report.json'};
  await write(preview.captureReportPath,{decoded:true,originalCandidateReopened:true,frameCount:10,fps:10,duration:1,
    projectPath:f.d.projectPath,projectSha256:preview.projectSha256,modelPath:f.d.modelPath,modelSha256:preview.modelSha256});
  await write('dynamics/engine-journal.json',{schemaVersion:2,...ident,pending:null,steps:[]});
  await write('dynamics/preview/engine-journal.json',{schemaVersion:2,...ident,pending:null,status:'captured',steps:[],
    source:{projectPath:f.d.projectPath,projectSha256:preview.projectSha256,modelPath:f.d.modelPath,modelSha256:preview.modelSha256}});
  await write(f.d.dynamicsManifestPath,{...f.manifest,preview,exportStatus:'exported',parentProject:{path:rig.projectPath,sha256:preview.projectSha256}});
  let dynamics={...f.d,rigReviews:rig.rigReviews,checks:[...rig.checks,
    ...['dynamics.export-and-reopen','dynamics.preview-capture'].map(name=>({name,layer:'automated',status:'passed'}))],
    previewCapture:{status:'captured',reportPath:preview.captureReportPath},artifacts:[],status:'blocked',
    unresolved:[{code:'DYNAMICS_VISUAL_NOT_RUN'}]};
  const files=[...new Set([...rig.artifacts.map(a=>a.path),f.d.dynamicsManifestPath,preview.captureReportPath])];
  dynamics.artifacts=await Promise.all(files.map(p=>artifact(root,p,'fixture')));
  await write('dynamics/stage.json',dynamics);
  dynamics=await recordDynamicsReview(dynamics,{id:'fixture-dynamics-pass',reviewer:{kind:'model',name:'Synthetic contract fixture'},
    watchedContinuously:true,range:[0,1],...Object.fromEntries(['videoSha256','modelSha256','projectSha256'].map(k=>[k,preview[k]])),
    observations:preview.requiredCriteria.map(criterion=>({criterion,status:'passed',from:0,to:1,note:'Synthetic observation only, not character acceptance'}))},{...ident,taskRoot:root});
  const workspace=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'complete-candidate-workspace-')));
  t.after(()=>fs.rm(workspace,{recursive:true,force:true}));
  const output=path.join(workspace,'openclaw-workspace','outputs',ident.taskId),base='revisions/r0008';
  await fs.mkdir(output,{recursive:true});await fs.cp(root,path.join(output,base),{recursive:true});
  const maker=new Maker(workspace),ctx={sessionKey:'original-owner',sessionId:'original-session'},job={id:ident.taskId,kind:'single_image',
    candidateId:ident.candidateId,revision:1,parentRevision:null,output,status:'blocked',stage:'rigging',steps:[],session:maker.store.session(ctx),
    source:{inputSha256:ident.inputSha256,descriptionSha256:ident.descriptionSha256},artifacts:{old:'preserve'},delivery:{old:'preserve'}};
  const writeAt=async(p,v)=>{await fs.mkdir(path.dirname(path.join(output,p)),{recursive:true});await fs.writeFile(path.join(output,p),JSON.stringify(v));};
  await writeAt('intake/stage.json',{schemaVersion:1,...ident,revision:1,parentRevision:null,stage:'intake',status:'completed',
    brief:originalBrief,artifacts:[await artifact(root,'intake/source.png','private_original_image')],unresolved:[]});
  await fs.copyFile(path.join(root,'intake/source.png'),path.join(output,'intake/source.png'));
  const bases={1:'',2:'revisions/r0002',3:'revisions/r0003',4:'revisions/r0004',5:'revisions/r0005',7:'revisions/r0007',8:base};
  for(const revision of [1,2,3,4,5,7,8]) {
    const b=bases[revision],p=b?b+'/':'',parentRevision=revision===1?null:revision===7?5:revision===8?7:revision-1;
    const identity={...ident,revision,parentRevision},layout=revision===8?await fs.readFile(path.join(root,'artwork/layout.json')):Buffer.from(JSON.stringify({layers:[{id:'face'}]})),pixels=revision===8?png:Buffer.from('pixels-'+revision);
    const parts=(revision===8?['face','detail']:['face']).map(id=>({id,path:'face.png',sha256:hash(pixels),rect:{left:0,top:0,width:1,height:1}}));
    const artworkFingerprint=hash(JSON.stringify({layoutSha256:hash(layout),parts:parts.map(({id,sha256,rect})=>({id,sha256,rect}))}));
    const manifest={schemaVersion:1,...identity,parts,layoutPath:'layout.json',...(revision>1?{artworkFingerprint}:{})};
    const stage={schemaVersion:1,stage:'artwork',status:'completed',...identity,brief:originalBrief,checks:[],unresolved:[],
      ...(revision===8&&scope?{productionScope:scope}:{}),layoutPath:'artwork/layout.json',artworkManifestPath:'artwork/artwork-manifest.json',...(revision>1?{artworkFingerprint}:{})};
    if(parentRevision>1) {
      const pp=bases[parentRevision]+'/artwork/',parent=JSON.parse(await fs.readFile(path.join(output,pp+'artwork-manifest.json')));
      const links={parentArtworkFingerprint:parent.artworkFingerprint,
        parentArtworkStage:{...await artifact(output,pp+'stage.json'),path:path.posix.relative(b,pp+'stage.json')},
        parentArtworkManifest:{...await artifact(output,pp+'artwork-manifest.json'),path:path.posix.relative(b,pp+'artwork-manifest.json')}};
      Object.assign(stage,links);Object.assign(manifest,links);
    }
    await writeAt(p+'artwork/artwork-manifest.json',manifest);
    await fs.writeFile(path.join(output,p+'artwork/layout.json'),layout);await fs.writeFile(path.join(output,p+'artwork/face.png'),pixels);
    stage.artifacts=await Promise.all(['artwork/artwork-manifest.json','artwork/layout.json','artwork/face.png'].map(file=>artifact(path.join(output,b),file,'artwork-source')));
    await writeAt(p+'artwork/stage.json',stage);
    if(revision!==8) {
      await writeAt(p+'rigging/stage.json',{schemaVersion:1,stage:'rigging',status:'blocked',...identity,artifacts:[],unresolved:[{code:'HONEST_HISTORY_FAILED'}]});
      await writeAt(p+'rigging/state.json',{identity,pending:null,failed:{code:'HONEST_HISTORY_FAILED'}});
    }
  }
  const candidateRoot=path.join(output,base);
  // Freeze the same source manifest in every stage before packaging it.
  for(const stage of [rig,dynamics]) {
    stage.artifacts=await Promise.all(stage.artifacts.map(a=>a.path==='artwork/artwork-manifest.json'?artifact(candidateRoot,a.path,a.role):a));
    await writeAt(base+'/'+stage.stage+'/stage.json',stage);
  }
  const packaged=await buildPackage(dynamics,{...ident,taskRoot:candidateRoot});assert.equal(packaged.status,'completed',JSON.stringify(packaged.unresolved));
  await maker.store.write('make-'+job.id,job);
  let count=0;
  const save=async(buffer,mime,subdir,cap,name)=>{const file=path.join(workspace,'stored-'+(++count)+'-'+name);await fs.writeFile(file,buffer);return {path:file};};
  return {job,maker,ctx,output,base,bases,save,count:()=>count,writeAt,rig,dynamics,packaged,
    pointer:path.join(output,'completed-candidate-current.json')};
}

test('completed candidate: true r8→r7→r5 ancestry and real ZIP closure; parent stays blocked',async t=>{
  const f=await fixture(t),before=structuredClone(f.job),registered=await registerCompletedCandidate(f.job,{revision:8});
  assert.equal(registered.revision,8);assert.equal(registered.parentRevision,7);
  assert.deepEqual(registered.parents.map(p=>p.revision),[7,5,4,3,2,1]);
  assert.deepEqual(f.job,before);assert.equal((await f.maker.store.read('make-'+f.job.id)).status,'blocked');
  const selected=await completedCandidateSources(f.job);
  assert.equal(selected.sources.length,3);assert.ok(selected.sources.every(s=>s.file.startsWith(path.join(f.output,f.base)+path.sep)));
  assert.deepEqual(registered.reviews.map(r=>[r.stage,r.reviewer.kind,r.status]),[['rigging','model','passed'],['dynamics','model','passed']]);
  assert(!registered.checks.some(c=>['runtime','human','user_acceptance'].includes(c.layer)&&c.status==='passed'));
});

test('completed candidate rejects G1/deferred Artwork and a locally completed reduced brief',async t=>{
  for(const options of [{scope:{gate:'G1',deferred:[]}},{scope:{gate:'full',deferred:['wave']}},{reduced:true}]) {
    const f=await fixture(t,options);
    // Every local stage has genuinely passed its own synthetic reviews and ZIP
    // checks. That must not silently shrink the original intake requirements.
    await assert.rejects(registerCompletedCandidate(f.job,{revision:8}),{code:'COMPLETED_CANDIDATE_INVALID'});
    await assert.rejects(fs.access(f.pointer));assert.equal(f.count(),0);
  }
});

test('completed candidate requires original requested motion/toggle reset criteria in the actual latest review',async t=>{
  const f=await fixture(t),root=path.join(f.output,f.base),rel=f.dynamics.dynamicsManifestPath;
  const manifest=JSON.parse(await fs.readFile(path.join(root,rel)));manifest.preview.requiredCriteria=previewCriteria;
  await f.writeAt(f.base+'/'+rel,manifest);
  const reviewPath=manifest.reviews.at(-1).path,review=JSON.parse(await fs.readFile(path.join(root,reviewPath)));
  review.observations=review.observations.filter(o=>previewCriteria.includes(o.criterion));await f.writeAt(f.base+'/'+reviewPath,review);
  for(const name of ['dynamics','packaging']) {
    const relative=f.base+'/'+name+'/stage.json',stage=JSON.parse(await fs.readFile(path.join(f.output,relative)));
    stage.artifacts=await Promise.all(stage.artifacts.map(a=>artifact(root,a.path,a.role)));await f.writeAt(relative,stage);
  }
  await assert.rejects(registerCompletedCandidate(f.job,{revision:8}),{code:'COMPLETED_CANDIDATE_INVALID'});
});

test('completed candidate rejects incomplete stages, pending, unresolved, missing/latest-failed or stale reviews',async t=>{
  const f=await fixture(t),relative=f.base+'/rigging/stage.json',file=path.join(f.output,relative),original=JSON.parse(await fs.readFile(file));
  for(const name of ['dynamics','packaging']) {
    const relative=f.base+'/'+name+'/stage.json',stage=JSON.parse(await fs.readFile(path.join(f.output,relative)));
    for(const patch of [{status:'awaiting_external_result'},{status:'failed'},{pending:{operation:'export'}},
      {unresolved:[{code:'QUALITY_DEFECT'}]},{checks:[...stage.checks,{name:'reject',layer:'visual',status:'failed'}]}]) {
      await f.writeAt(relative,{...stage,...patch});await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));
    }
    await f.writeAt(relative,stage);
  }
  for(const change of [{status:'blocked'},{pending:{operation:'save'}},{failed:{code:'FAILED'}},{unresolved:[{code:'DEFECT'}]},
    {rigReviews:[]},{checks:original.checks.filter(c=>c.name!=='rigging_visual_review')},
    {rigReviews:[...original.rigReviews,{...original.rigReviews.at(-1),status:'failed'}]},
    {rigReviews:[{...original.rigReviews.at(-1),path:'rigging/reviews/not-registered/review.json'}]}]) {
    await f.writeAt(relative,{...original,...change});await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));
    await assert.rejects(fs.access(f.pointer));
  }
  for(const lock of ['rigging/.build.lock','dynamics/.review.lock','packaging/.build.lock']) {
    const file=path.join(f.output,f.base,lock);await fs.writeFile(file,'active');
    await assert.rejects(registerCompletedCandidate(f.job,{revision:8}),{code:'COMPLETED_CANDIDATE_BUSY'});await fs.rm(file);
  }
  await f.writeAt(relative,original);
  const reviewPath=f.base+'/'+original.rigReviews.at(-1).path,review=JSON.parse(await fs.readFile(path.join(f.output,reviewPath)));
  review.engineRevision='obsolete';await f.writeAt(reviewPath,review);
  // Updating a stage's hash is insufficient: the review must bind the current state.
  const patched={...original,artifacts:await Promise.all(original.artifacts.map(a=>artifact(path.join(f.output,f.base),a.path,a.role)))};
  await f.writeAt(relative,patched);await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));
});

test('completed candidate frozen hashes reject source/review/ancestor/ZIP mutation, including re-registration',async t=>{
  const f=await fixture(t);await registerCompletedCandidate(f.job,{revision:8});const pointer=await fs.readFile(f.pointer);
  for(const relative of [f.base+'/'+f.rig.psdPath,f.base+'/'+f.dynamics.rigReviews.at(-1).path,
    f.base+'/'+f.dynamics.dynamicsManifestPath,f.base+'/packaging/full.zip',f.bases[7]+'/rigging/state.json','intake/stage.json']) {
    const file=path.join(f.output,relative),bytes=await fs.readFile(file);await fs.appendFile(file,'tamper');
    await assert.rejects(completedCandidateSources(f.job));await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));
    assert.deepEqual(await fs.readFile(f.pointer),pointer);await fs.writeFile(file,bytes);
  }
  const p=JSON.parse(pointer);await fs.writeFile(f.pointer,JSON.stringify({...p,parentRevision:6}));
  await assert.rejects(completedCandidateSources(f.job));
});

test('completed repair freezes the original artwork quality failure before any rig was started',async t=>{
  const f=await fixture(t),manifestPath='artwork/artwork-manifest.json',stagePath='artwork/stage.json';
  const manifest=JSON.parse(await fs.readFile(path.join(f.output,manifestPath)));
  const stage=JSON.parse(await fs.readFile(path.join(f.output,stagePath)));
  await f.writeAt(manifestPath,{...manifest,status:'blocked'});
  stage.status='blocked';stage.unresolved=[{stage:'artwork',code:'ARTWORK_QUALITY_FAILED'}];
  stage.artifacts=await Promise.all(stage.artifacts.map(a=>artifact(f.output,a.path,a.role)));
  await f.writeAt(stagePath,stage);
  await fs.rm(path.join(f.output,'rigging/stage.json'));
  await assert.rejects(registerCompletedCandidate(f.job,{revision:8}),{code:'PREVIEW_INVALID'});
  await fs.rm(path.join(f.output,'rigging/state.json'));
  const bundle=await registerCompletedCandidate(f.job,{revision:8}),original=bundle.parents.at(-1);
  assert.equal(original.revision,1);
  assert.equal(original.rigStage,undefined);
  assert.equal(original.artworkStage.sha256,hash(await fs.readFile(path.join(f.output,stagePath))));
  await fs.appendFile(path.join(f.output,'artwork/face.png'),'changed');
  await assert.rejects(completedCandidateSources(f.job));
});

test('completed candidate publication is session-bound, independent and idempotent, including interrupted saves',async t=>{
  const f=await fixture(t);await assert.rejects(deliver(f.maker,f.job.id,f.ctx,f.save),{code:'NOT_COMPLETED'});assert.equal(f.count(),0);
  await registerCompletedCandidate(f.job,{revision:8});
  await assert.rejects(deliver(f.maker,f.job.id,{...f.ctx,sessionId:'different'},f.save),{code:'SESSION_MISMATCH'});
  let calls=0;await assert.rejects(deliver(f.maker,f.job.id,f.ctx,(...args)=>{if(++calls===2)throw new Error('SDK interrupted');return f.save(...args);}),/SDK interrupted/);
  const interrupted=await f.maker.store.read('make-'+f.job.id);assert.deepEqual(interrupted.delivery,f.job.delivery);assert.equal(interrupted.status,'blocked');
  const result=await deliver(f.maker,f.job.id,f.ctx,f.save);assert.equal(result.revision,8);assert.equal(result.status,'completed');assert.equal(result.attachments.length,3);assert.equal(f.count(),3);
  const second=await deliver(f.maker,f.job.id,f.ctx,f.save);assert.deepEqual(second.attachments,result.attachments);assert.equal(f.count(),3);
  const saved=await f.maker.store.read('make-'+f.job.id);assert.equal(saved.revision,1);assert.equal(saved.status,'blocked');
  assert.deepEqual(saved.delivery,f.job.delivery);assert.equal(saved.completedCandidateDelivery.revision,8);assert.equal(saved.deliveryProgress,undefined);
  const status=await f.maker.making(f.job.id,f.ctx);
  assert.equal(status.status,'blocked');
  assert.deepEqual(status.completedCandidateDelivery,{status:'published',revision:8,parentRevision:7,at:saved.completedCandidateDelivery.at});
  await assert.rejects(f.maker.making(f.job.id,{...f.ctx,sessionId:'different'}),{code:'SESSION_MISMATCH'});
  await assert.rejects(fs.access(path.join(f.output,'附件交付.json')));
});

test('completed candidate bad pointer cannot fall back to a completed parent or another path',async t=>{
  const f=await fixture(t);await registerCompletedCandidate(f.job,{revision:8});
  const p=JSON.parse(await fs.readFile(f.pointer));p.manifest.path='../other/stage.json';await fs.writeFile(f.pointer,JSON.stringify(p));
  await f.maker.store.write('make-'+f.job.id,{...f.job,status:'completed'});
  await assert.rejects(deliver(f.maker,f.job.id,f.ctx,f.save));assert.equal(f.count(),0);
});

test('legacy completed single-image delivery without a pointer still verifies and publishes its own real ZIP',async t=>{
  const f=await fixture(t);await fs.cp(path.join(f.output,f.base),f.output,{recursive:true});
  await f.maker.store.write('make-'+f.job.id,{...f.job,revision:8,parentRevision:7,status:'completed',artifacts:{packagePath:'packaging/full.zip'}});
  const result=await deliver(f.maker,f.job.id,f.ctx,f.save);assert.equal(result.attachments.length,3);assert.equal(f.count(),3);
  const stored=await f.maker.store.read('make-'+f.job.id);assert.equal(stored.completedCandidateDelivery,undefined);assert.equal(stored.delivery.attachments.length,3);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.output,'附件交付.json'))).attachments.length,3);
});

test('a resumed native revision publishes only its own canonical package',async t=>{
  const f=await fixture(t),output=path.join(f.output,f.base),key='make-'+f.job.id;
  const job={...f.job,revision:8,parentRevision:7,status:'completed',output,artifacts:{packagePath:'packaging/full.zip'}};
  await f.maker.store.write(key,{...job,output:path.join(f.output,'revisions','r0007')});
  await assert.rejects(deliver(f.maker,f.job.id,f.ctx,f.save),{code:'OUTPUT_MISMATCH'});
  assert.equal(f.count(),0);
  await f.maker.store.write(key,job);
  const result=await deliver(f.maker,f.job.id,f.ctx,f.save);
  assert.equal(result.archive,path.join(output,'packaging/full.zip'));
  assert.equal(result.attachments.length,3);
  assert.equal(f.count(),3);
});

test('completed candidate detects source mutation after the first save before any second SDK call',async t=>{
  const f=await fixture(t);await registerCompletedCandidate(f.job,{revision:8});
  await assert.rejects(deliver(f.maker,f.job.id,f.ctx,async(...args)=>{
    const saved=await f.save(...args);if(f.count()===1)await fs.appendFile(path.join(f.output,f.bases[7],'/rigging/state.json'),'changed');return saved;
  }),{code:'COMPLETED_CANDIDATE_CHANGED'});
  assert.equal(f.count(),1);const saved=await f.maker.store.read('make-'+f.job.id);
  assert.equal(saved.completedCandidateDelivery.status,'publishing');assert.equal(saved.completedCandidateDelivery.attachments.length,1);
  assert.equal(saved.status,'blocked');assert.deepEqual(saved.delivery,f.job.delivery);
});

test('completed candidate rejects a wrong real branch, symlink and unrecorded visual pass before SDK access',async t=>{
  const f=await fixture(t),p=f.base+'/artwork/stage.json',stage=JSON.parse(await fs.readFile(path.join(f.output,p)));
  await f.writeAt(p,{...stage,parentRevision:6});await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));await f.writeAt(p,stage);
  const project=path.join(f.output,f.base,f.rig.projectPath),data=await fs.readFile(project),external=path.join(f.maker.root,'outside.psd2live');
  await fs.writeFile(external,data);await fs.rm(project);await fs.symlink(external,project);
  await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));await fs.rm(project);await fs.writeFile(project,data);
  const dynPath=f.base+'/dynamics/stage.json',dynamics=JSON.parse(await fs.readFile(path.join(f.output,dynPath)));
  // A completed status and passing check cannot substitute for the recorded review.
  await f.writeAt(dynPath,{...dynamics,checks:dynamics.checks.map(c=>c.name==='dynamics.visual'?{...c,reviewPath:'dynamics/reviews/invented/review.json'}:c)});
  await assert.rejects(registerCompletedCandidate(f.job,{revision:8}));assert.equal(f.count(),0);
});

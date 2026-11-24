import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildPackage, verifyPackage, verifyPackageArchive, planDelivery} from '../src/packaging/index.mjs';
import {artifact, inventory} from '../src/packaging/files.mjs';
import {archive} from '../src/packaging/archive.mjs';
import {recordFinalPreviewReview} from '../src/packaging/final-preview-review.mjs';
import {encodePng} from '../src/artwork/png.mjs';

// Synthetic format fixtures, NOT a Cubism-compatible character or playable video.
const hash = data => createHash('sha256').update(data).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jX1sAAAAASUVORK5CYII=', 'base64');
const u32 = n => {const b = Buffer.alloc(4); b.writeUInt32BE(n); return b;};
const i16 = n => {const b = Buffer.alloc(2); b.writeInt16BE(n); return b;};
function layeredPsd(width=1,height=1) {
  const header = Buffer.alloc(26); header.write('8BPS'); header.writeUInt16BE(1, 4);
  header.writeUInt16BE(3, 12); header.writeUInt32BE(height, 14); header.writeUInt32BE(width, 18); header.writeUInt16BE(8, 22); header.writeUInt16BE(3, 24);
  const extra = Buffer.concat([u32(0), u32(0), Buffer.from([1, 65, 0, 0])]);
  const record = Buffer.concat([u32(0), u32(0), u32(1), u32(1), i16(1), i16(0), u32(3), Buffer.from('8BIMnorm'), Buffer.from([255, 0, 0, 0]), u32(extra.length), extra]);
  const info = Buffer.concat([i16(2), record, record, Buffer.from([0, 0, 255, 0, 0, 255])]);
  const layers = Buffer.concat([u32(info.length), info, u32(0)]);
  return Buffer.concat([header, u32(0), u32(0), u32(layers.length), layers, Buffer.from([0, 0, 255, 255, 255])]);
}

async function fixture(t, persistent = false, {revision = 'r01', parentRevision = null} = {}) {
  const keep = persistent && process.env.PACKAGING_EVIDENCE_ROOT;
  const base = keep ? path.resolve(keep) : await fs.mkdtemp(path.join(os.tmpdir(), 'live2d-package-'));
  if (keep) await fs.mkdir(base, {recursive: true}); else t.after(() => fs.rm(base, {recursive: true, force: true}));
  const root = await fs.realpath(base), put = async (name, data) => {
    await fs.mkdir(path.dirname(path.join(root, name)), {recursive: true}); await fs.writeFile(path.join(root, name), data);
  };
  const write = (name, value) => put(name, JSON.stringify(value));
  const d = {schemaVersion: 1, taskId: 'fixture-task', candidateId: 'fixture-character', revision, parentRevision,
    inputSha256: hash('synthetic-source'), descriptionSha256: hash('fixture-request'), stage: 'dynamics', status: 'completed',
    engineVersion: '3.6.7', projectId: 'fixture-native', rights: {source: '纯合成格式测试', license: 'fixture-only', allowDerivatives: true, allowRedistribution: false, userDeclared: true},
    modelPath: 'dynamics/中文模型/角色.model3.json', projectPath: 'dynamics/可编辑.psd2live', psdPath: 'rigging/分层.psd',
    parameterMapPath: 'rigging/parameter-map.json', dynamicsManifestPath: 'dynamics/dynamics-manifest.json', artifacts: [], checks: [], warnings: ['FIXTURE_ONLY'], unresolved: []};
  const ident=Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,d[k]]));
  const ids=(...ids)=>ids.map(id=>({id}));
  const intent={expressions:ids('happy','angry'),actions:ids('wave','reset'),clothingVariants:ids('chest_bow')};
  d.brief={...ident,intent};
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
  await put('intake/source.png', png); await write('intake/private-request.json', {secretPrompt: 'must-not-ship'});
  d.artifacts = await inventory(root);
  const ctx = {taskRoot: root, taskId: d.taskId, candidateId: d.candidateId, revision: d.revision, parentRevision: d.parentRevision};
  const refresh = async name => {d.artifacts = d.artifacts.filter(a => a.path !== name); d.artifacts.push(await artifact(root, name, 'fixture'));};
  const result={root, d, ctx, put, write, manifest, refresh};
  await sourceArtwork(result);
  // Format-only packaging tests use an explicit exporter double. The integration below uses the real mature writer/reader.
  ctx.sourcePsdExporter=formatSourcePsdFixture;
  return result;
}

async function sourceArtwork(f) {
  const ident=Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,f.d[k]]));
  const data=Buffer.from([1,2,3,0,50,60,70,255,80,90,100,128,120,130,140,255]);
  await f.put('artwork/part.png',encodePng({width:2,height:2,data}));
  f.d.layoutPath='artwork/layout.json';f.d.artworkManifestPath='artwork/artwork-manifest.json';
  await f.write(f.d.layoutPath,{format:'psd2live-layout',version:1,canvas:{width:8,height:8},layers:[
    {id:'source-part',name:'源部件',image:{path:'part.png',width:2,height:2},rect:{left:1.25,top:2,width:.5,height:.5},visible:true,opacity:1},
    {id:'source-hidden',name:'隐藏源部件',image:{path:'part.png',width:2,height:2},rect:{left:3,top:2,width:1,height:1},visible:false,opacity:1}
  ]});
  await f.write(f.d.artworkManifestPath,{schemaVersion:1,...ident,status:'completed'});
  const sourceFiles=await Promise.all(['artwork/part.png',f.d.layoutPath,f.d.artworkManifestPath].map(p=>artifact(f.root,p,'artwork-source')));
  await f.write('artwork/stage.json',{schemaVersion:1,...ident,stage:'artwork',status:'completed',layoutPath:f.d.layoutPath,artworkManifestPath:f.d.artworkManifestPath,
    artifacts:sourceFiles,checks:[],unresolved:[],warnings:[]});
  for(const file of sourceFiles)await f.refresh(file.path);
  return data;
}

async function formatSourcePsdFixture({layoutPath,outputPath}) {
  const layoutBytes=await fs.readFile(layoutPath),layout=JSON.parse(layoutBytes),rgbaSha256=hash(Buffer.from([1,2,3,0,50,60,70,255,80,90,100,128,120,130,140,255]));
  await fs.writeFile(outputPath,layeredPsd(32,32),{flag:'wx'});
  const record=async file=>({path:file,bytes:(await fs.stat(file)).size,sha256:hash(await fs.readFile(file))});
  const psd=await record(outputPath),reportPath=outputPath+'.readback.json',provenancePath=outputPath+'.provenance.json';
  await fs.writeFile(reportPath,JSON.stringify({schemaVersion:1,status:'passed',scope:'FORMAT-ONLY TEST DOUBLE',sourceLayoutSha256:hash(layoutBytes),psdSha256:psd.sha256,psdBytes:psd.bytes,
    logicalCanvas:layout.canvas,psdCanvas:{width:32,height:32},integerCanvasScale:4,layerCount:2,hiddenLayerCount:1,maxLogicalRectError:0,limitations:['FORMAT-ONLY TEST DOUBLE'],
    layers:layout.layers.map(layer=>({id:layer.id,sourceRgbaSha256:rgbaSha256,sourceWidth:2,sourceHeight:2,sourcePixelsChecked:4,sourcePixelsMissingOrChanged:0,maxSourceChannelError:0,rgbaRoundTripExact:true,
      bounds:{left:layer.rect.left*4,top:layer.rect.top*4,width:layer.rect.width*4,height:layer.rect.height*4},maxLogicalRectError:0}))}));
  const tool={path:'format-only-test-double',sha256:hash('format-only'),bytes:1};
  await fs.writeFile(provenancePath,JSON.stringify({runtimeManifest:tool,runtimeComponents:[tool],compiler:tool,java:tool,helper:tool,compiledTool:tool}));
  return {psd,report:await record(reportPath),provenance:await record(provenancePath)};
}

test('高清源PSD进入正式完整包和可移动读回契约，真实成熟writer',
  {skip:!process.env.SOURCE_PSD_RUNTIME_MANIFEST,timeout:180000},async t=>{
    const f=await fixture(t);delete f.ctx.sourcePsdExporter;
    f.ctx.sourcePsdRuntimeManifest=process.env.SOURCE_PSD_RUNTIME_MANIFEST;
    let engineCalls=0;f.ctx.engine={call(){engineCalls++;throw new Error('Packaging must never enter the editor');}};
    const result=await buildPackage(f.d,f.ctx);assert.equal(result.status,'completed',JSON.stringify(result.unresolved));
    assert.equal(typeof result.sourcePsdPath,'string');
    const manifest=JSON.parse(await fs.readFile(path.join(f.root,result.packageManifestPath)));
    assert.notEqual(manifest.sourcePsdPath,manifest.psdPath);
    assert.deepEqual(['source_psd','source_psd_readback','source_psd_provenance'].map(role=>result.artifacts.filter(a=>a.role===role).length),[1,1,1]);
    const readback=JSON.parse(await fs.readFile(path.join(f.root,result.sourcePsdReadbackPath)));
    assert.deepEqual(readback.psdCanvas,{width:32,height:32});assert.equal(readback.layerCount,2);
    assert.equal(readback.layers[0].sourcePixelsMissingOrChanged,0);assert.equal(readback.layers[0].maxSourceChannelError,0);
    assert.equal(readback.candidateId,f.d.candidateId);
    const verified=await verifyPackageArchive(path.join(f.root,result.packagePath),result.deliveryFiles[0],path.join(f.root,'source-verified'),{identity:f.d});
    assert.equal(verified.sourcePsd.status,'passed');assert.equal(verified.sourcePsd.width,32);
    assert.equal(engineCalls,0);
    f.ctx.sourcePsdExporter=()=>{throw new Error('Completed package must be reused');};
    assert.equal((await buildPackage(f.d,f.ctx)).sourcePsdPath,result.sourcePsdPath);
  });

test('高清源PSD拒绝错版Artwork、源图漂移、伪读回及缺源入口；失败不自动重跑',async t=>{
  for(const kind of ['missing','identity','source-hash','readback'])await t.test(kind,async t=>{
    const f=await fixture(t);let conversions=0;
    const exporter=f.ctx.sourcePsdExporter;
    f.ctx.sourcePsdExporter=async args=>{
      conversions++;const result=await exporter(args);
      const report=JSON.parse(await fs.readFile(result.report.path));report.layers[0].sourcePixelsMissingOrChanged=1;
      await fs.writeFile(result.report.path,JSON.stringify(report));return result;
    };
    if(kind==='missing')delete f.d.layoutPath;
    if(kind==='identity') {const stage=JSON.parse(await fs.readFile(path.join(f.root,'artwork/stage.json')));stage.candidateId='foreign';await f.write('artwork/stage.json',stage);}
    if(kind==='source-hash') {await f.put('artwork/part.png',encodePng({width:2,height:2,data:Buffer.alloc(16,255)}));await f.refresh('artwork/part.png');}
    const result=await buildPackage(f.d,f.ctx);
    assert.equal(result.status,'failed');assert.equal(result.unresolved.at(-1).code,'REFERENCE_INVALID');assert.deepEqual(result.deliveryFiles,[]);
    const count=conversions;assert.equal((await buildPackage(f.d,f.ctx)).status,'failed');assert.equal(conversions,count);
  });
});

test('高清源PSD可移动证明拒绝改身份和伪零误差，即使重新登记外层文件哈希',async t=>{
  const f=await fixture(t),result=await buildPackage(f.d,f.ctx);assert.equal(result.status,'completed');
  const content=path.join(f.root,'packaging/content'),manifest=JSON.parse(await fs.readFile(path.join(content,'manifest.json')));
  const proofPath=manifest.sourcePsdReadbackPath,provenancePath=manifest.sourcePsdProvenancePath;
  const report=JSON.parse(await fs.readFile(path.join(content,proofPath))),provenance=JSON.parse(await fs.readFile(path.join(content,provenancePath)));
  for(const kind of ['identity','pixels']) {
    const changed=structuredClone(report);if(kind==='identity')changed.inputSha256='f'.repeat(64);else changed.layers[0].maxSourceChannelError=1;
    await fs.writeFile(path.join(content,proofPath),JSON.stringify(changed));
    const proof=await artifact(content,proofPath,'source_psd_readback');
    await fs.writeFile(path.join(content,provenancePath),JSON.stringify({...provenance,readback:proof}));
    for(const file of [proofPath,provenancePath])manifest.files[manifest.files.findIndex(a=>a.path===file)]=await artifact(content,file);
    await fs.writeFile(path.join(content,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(verifyPackage(content,f.d),{code:'REFERENCE_INVALID'});
  }
});

test('完整包：中文路径、所有运行引用、来源同版；干净移动后复验', async t => {
  const f = await fixture(t, true), result = await buildPackage(f.d, f.ctx);
  assert.equal(result.status, 'completed', JSON.stringify(result.unresolved));
  const manifest = JSON.parse(await fs.readFile(path.join(f.root, result.packageManifestPath)));
  assert.equal(manifest.inputSha256, f.d.inputSha256); assert.equal(manifest.rights.license, 'fixture-only');
  assert.equal(manifest.expressions[1].leafId, '1'); assert.equal(manifest.motions[0].leafId, 'Idle:0');
  assert.equal(manifest.runtimeCompatibility.candidateLoaded, 'not_run'); assert.equal(result.distribution.serviceMaxBytes, null);
  assert.ok(!manifest.files.some(a => a.path.includes('source.png') || a.path.includes('private-request')));
  assert.ok(manifest.files.some(a => a.path === 'model/音频/示例.wav'));
  assert.ok(manifest.requirementCoverage.requested.actions.includes('wave'));
  const guide=await fs.readFile(path.join(f.root,'packaging/content/使用说明.md'),'utf8');
  assert.match(guide,/招手 · 1/); assert.match(guide,/motion:招手:0/); assert.match(guide,/expression:2/); assert.match(guide,/保留当前情绪/);
  const moved = path.join(f.root, '异地解压');
  const verified = await verifyPackageArchive(path.join(f.root, result.packagePath), result.deliveryFiles[0], moved, {identity: f.d});
  assert.equal(verified.references, 'passed'); assert.equal(verified.nativeReopen, 'not_run'); assert.equal(verified.psd.layerRecordCount, 2);
  assert.equal((await buildPackage(f.d, f.ctx)).packagePath, result.packagePath); await fs.rm(moved, {recursive: true});
});

test('正式候选版本形状：数值revision及parentRevision经打包和解压保持原类型', async t => {
  for (const revisions of [{revision: 1, parentRevision: null}, {revision: 2, parentRevision: 1}]) await t.test(JSON.stringify(revisions), async t => {
    const f = await fixture(t, false, revisions), result = await buildPackage(f.d, f.ctx);
    assert.equal(result.status, 'completed', JSON.stringify(result.unresolved));
    const manifest = JSON.parse(await fs.readFile(path.join(f.root, result.packageManifestPath)));
    const stage = JSON.parse(await fs.readFile(path.join(f.root, 'packaging/stage.json')));
    for (const value of [result, manifest, stage]) {
      assert.equal(value.revision, revisions.revision); assert.equal(value.parentRevision, revisions.parentRevision);
    }
    const downloaded = path.join(f.root, 'numeric-verified');
    const verified = await verifyPackageArchive(path.join(f.root, result.packagePath), result.deliveryFiles[0], downloaded, {identity: f.d});
    assert.equal(verified.identity.revision, revisions.revision); assert.equal(verified.identity.parentRevision, revisions.parentRevision);
    await assert.rejects(verifyPackage(downloaded, {...f.d, revision: String(revisions.revision)}), {code: 'REFERENCE_INVALID'});
    if (revisions.parentRevision !== null) await assert.rejects(verifyPackage(downloaded, {...f.d, parentRevision: String(revisions.parentRevision)}), {code: 'REFERENCE_INVALID'});
    assert.equal((await buildPackage(f.d, f.ctx)).revision, revisions.revision);
  });
});

test('数值版本与字符串版本不互换，context及动态清单均逐字比较', async t => {
  for (const key of ['revision', 'parentRevision']) await t.test(key, async t => {
    const f = await fixture(t, false, {revision: 2, parentRevision: 1});
    await assert.rejects(buildPackage(f.d, {...f.ctx, [key]: String(f.ctx[key])}), {code: 'REFERENCE_INVALID'});
    await assert.rejects(fs.stat(path.join(f.root, 'packaging')), {code: 'ENOENT'});
    f.manifest[key] = String(f.manifest[key]);
    await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);
    const result = await buildPackage(f.d, f.ctx);
    assert.equal(result.status, 'failed'); assert.equal(result.unresolved.at(-1).code, 'REFERENCE_INVALID');
    assert.deepEqual(result.deliveryFiles, []);
  });
});

test('缺引用、越界、哈希不符、软链接和错候选预览被拒绝', async t => {
  for (const kind of ['missing', 'traversal', 'hash', 'symlink', 'preview', 'identity', 'duplicate-resource']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'missing') await fs.rm(path.join(f.root, 'dynamics/中文模型/纹理/图集.png'));
    if (kind === 'traversal') {const name = f.d.modelPath, value = JSON.parse(await fs.readFile(path.join(f.root, name))); value.FileReferences.Moc = '../角色.moc3'; await f.write(name, value); await f.refresh(name); f.manifest.preview.modelSha256 = (await artifact(f.root, name)).sha256; await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);}
    if (kind === 'hash') f.d.artifacts.find(a => a.path === f.d.psdPath).sha256 = '0'.repeat(64);
    if (kind === 'symlink') {const file = path.join(f.root, 'dynamics/中文模型/纹理/图集.png'); await fs.rm(file); await fs.symlink(path.join(f.root, 'intake/source.png'), file);}
    if (kind === 'preview') {f.manifest.preview.projectSha256 = '0'.repeat(64); await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);}
    if (kind === 'identity') {f.manifest.candidateId = 'other'; await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);}
    if (kind === 'duplicate-resource') {f.manifest.expressions[1] = f.manifest.expressions[0]; await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);}
    const result = await buildPackage(f.d, f.ctx);
    assert.equal(result.status, 'failed'); assert.equal(result.unresolved.at(-1).code, 'REFERENCE_INVALID'); assert.equal(result.deliveryFiles.length, 0);
  });
});

test('篡改、额外文件、错身份、已存在解压目录均拒绝', async t => {
  const f = await fixture(t), result = await buildPackage(f.d, f.ctx);
  assert.equal(result.status, 'completed', JSON.stringify(result.unresolved));
  const content = path.join(f.root, 'packaging/content');
  await assert.rejects(verifyPackage(content, {...f.d, candidateId: 'wrong'}), {code: 'REFERENCE_INVALID'});
  await fs.writeFile(path.join(content, 'unlisted.txt'), 'extra'); await assert.rejects(verifyPackage(content, f.d), {code: 'REFERENCE_INVALID'}); await fs.rm(path.join(content, 'unlisted.txt'));
  const existing = path.join(f.root, 'keep'); await fs.mkdir(existing); await fs.writeFile(path.join(existing, 'keep.txt'), 'keep');
  await assert.rejects(verifyPackageArchive(path.join(f.root, result.packagePath), result.deliveryFiles[0], existing), {code: 'EEXIST'});
  assert.equal(await fs.readFile(path.join(existing, 'keep.txt'), 'utf8'), 'keep');
  await fs.appendFile(path.join(f.root, result.packagePath), 'tamper');
  await assert.rejects(verifyPackageArchive(path.join(f.root, result.packagePath), result.deliveryFiles[0], path.join(f.root, 'never-created')), {code: 'REFERENCE_INVALID'});
});

test('上游未完成不造替代包；同身份失败不自动重试', async t => {
  const f = await fixture(t); f.d.status = 'blocked';
  const result = await buildPackage(f.d, f.ctx); assert.equal(result.status, 'blocked'); assert.deepEqual(result.deliveryFiles, []);
  f.d.status = 'completed'; assert.equal((await buildPackage(f.d, f.ctx)).status, 'blocked');
});

test('历史1.1可移动包保留原契约，不冒充新增高清源PSD',async t=>{
  const f=await fixture(t),result=await buildPackage(f.d,f.ctx);assert.equal(result.status,'completed');
  const content=path.join(f.root,'packaging/content'),manifest=JSON.parse(await fs.readFile(path.join(content,'manifest.json')));
  const removed=['sourcePsdPath','sourcePsdReadbackPath','sourcePsdProvenancePath'].map(k=>manifest[k]);
  for(const file of removed)await fs.rm(path.join(content,file));
  for(const key of ['sourcePsdContract','sourcePsdPath','sourcePsdReadbackPath','sourcePsdProvenancePath'])delete manifest[key];
  manifest.producer.packaging='1.1.0';manifest.files=manifest.files.filter(f=>!removed.includes(f.path));
  await fs.writeFile(path.join(content,'manifest.json'),JSON.stringify(manifest));
  assert.equal((await verifyPackage(content,f.d)).sourcePsd,null);
});

test('打包进程在发布前退出，原候选可恢复，半成品不会占用最终目录',async t=>{
  const f=await fixture(t);
  // Keep this crash/recovery check independent of the installed native writer.
  const sourceExport=await formatSourcePsdFixture({layoutPath:path.join(f.root,f.d.layoutPath),outputPath:path.join(f.root,'crash-source-fixture.psd')});
  const entry=new URL('../src/packaging/index.mjs',import.meta.url).href;
  const program=`import {buildPackage} from ${JSON.stringify(entry)};
    const [d,ctx,sourceExport]=JSON.parse(process.argv[1]);
    await buildPackage(d,{...ctx,sourcePsdExporter:async()=>sourceExport,progress:()=>process.exit(34)});`;
  await assert.rejects(promisify(execFile)(process.execPath,['--input-type=module','-e',program,JSON.stringify([f.d,f.ctx,sourceExport])]),{code:34});
  await assert.rejects(fs.lstat(path.join(f.root,'packaging')),{code:'ENOENT'});
  const result=await buildPackage(f.d,f.ctx);
  assert.equal(result.status,'completed');
  assert.equal((await fs.readdir(f.root)).some(p=>p.startsWith('.packaging-')),false);
});

test('121MiB策略：SDK默认、本地限制、服务未知分别记录', () => {
  const MiB = 1024 ** 2;
  const plan = planDelivery([{role: 'complete-package', bytes: 121 * MiB}, {role: 'runtime-package', bytes: 64 * MiB}, {role: 'editable-package', bytes: 5 * MiB}]);
  assert.equal(plan.files[0].status, 'blocked'); assert.equal(plan.files[1].status, 'unverified');
  assert.equal(plan.files[1].sdkMaxBytesRequired, 64 * MiB); assert.equal(plan.files[2].sdkMaxBytesRequired, null);
  assert.equal(planDelivery([{bytes: 10}], {serviceMaxBytes: 9}).files[0].status, 'blocked');
});

test('原生工程漏依赖与伪分层PSD不能靠外层哈希清单通过', async t => {
  for (const kind of ['embedded-raster', 'history-node', 'flattened-psd']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'flattened-psd') {
      await f.put(f.d.psdPath, Buffer.concat([layeredPsd().subarray(0, 26), u32(0), u32(0), u32(0), Buffer.from([0, 0, 1, 2, 3])]));
      await f.refresh(f.d.psdPath);
    } else {
      const project = path.join(f.root, f.d.projectPath), unpacked = path.join(f.root, 'native-check');
      const {files} = await archive({action: 'list', file: project});
      await archive({action: 'extract', file: project, root: unpacked, files});
      const name = files.find(name => name.startsWith(kind === 'embedded-raster' ? 'assets/' : 'history/nodes/'));
      await fs.rm(path.join(unpacked, name));
      const manifestPath = path.join(unpacked, 'manifest.json'), manifest = JSON.parse(await fs.readFile(manifestPath));
      delete manifest.files[name]; await fs.writeFile(manifestPath, JSON.stringify(manifest));
      await fs.rm(project); await archive({action: 'make', root: unpacked, file: project, files: files.filter(file => file !== name)});
      await f.refresh(f.d.projectPath);
      f.manifest.preview.projectSha256 = (await artifact(f.root, f.d.projectPath)).sha256;
      await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);
    }
    const result = await buildPackage(f.d, f.ctx);
    assert.equal(result.status, 'failed'); assert.equal(result.unresolved.at(-1).code, 'REFERENCE_INVALID');
  });
});

test('恶意ZIP路径在解压前被拒绝并清理本次目标', async t => {
  const f = await fixture(t), file = path.join(f.root, 'bad.zip'), destination = path.join(f.root, 'rejected');
  await promisify(execFile)('python3', ['-c', "import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1],'w') as z: z.writestr('../escape.txt','bad')", file]);
  const expected = await artifact(f.root, 'bad.zip');
  await assert.rejects(verifyPackageArchive(file, expected, destination), {code: 'REFERENCE_INVALID'});
  await assert.rejects(fs.stat(destination), {code: 'ENOENT'}); await assert.rejects(fs.stat(path.join(f.root, 'escape.txt')), {code: 'ENOENT'});
});

test('实际超过64MiB时保留完整包并生成独立runtime/editable包', async t => {
  const f = await fixture(t);
  const texture = 'dynamics/中文模型/纹理/图集.png';
  await f.put(texture, Buffer.concat([png, randomBytes(65 * 1024 ** 2)])); await f.refresh(texture);
  const result = await buildPackage(f.d, f.ctx);
  assert.equal(result.status, 'blocked'); assert.equal(result.unresolved.at(-1).code,'DELIVERY_TOO_LARGE');
  const runtime = result.deliveryFiles.find(a => a.role === 'runtime-package');
  const editable = result.deliveryFiles.find(a => a.role === 'editable-package');
  assert.ok(runtime && editable); assert.ok(result.deliveryFiles[0].bytes > 64 * 1024 ** 2);
  const r = await verifyPackage(path.join(f.root, 'packaging/runtime-verified'), f.d);
  const e = await verifyPackage(path.join(f.root, 'packaging/editable-assets-verified'), f.d);
  assert.equal(r.references, 'passed'); assert.equal(e.editableProject.inventoryHashes, 'passed');
  assert.equal(result.distribution.files.find(a => a.role === 'runtime-package').status, 'blocked');
  assert.equal(result.distribution.files.find(a => a.role === 'editable-package').status, 'unverified');
});

test('用户要求须逐项出现在模型索引与对应可用参数；手势收回、外观隔离和显示信息', async t => {
  for (const kind of ['missing-wave','crossed-bow','never-lower','missing-cdi-param','wrong-brief','wrong-rig','missing-cdi','service-limit']) await t.test(kind,async t=>{
    const f=await fixture(t), read=async name=>JSON.parse(await fs.readFile(path.join(f.root,name)));
    const change=async (name,update)=>{const data=await read(name);update(data);await f.write(name,data);await f.refresh(name);};
    const dir=path.posix.dirname(f.d.modelPath);
    if(kind==='missing-wave') {await change(f.d.modelPath,m=>delete m.FileReferences.Motions['招手']); f.manifest.motions.pop();}
    if(kind==='crossed-bow') {await change(dir+'/表情/蝴蝶结.exp3.json',e=>e.Parameters[0].Id='ParamHappy'); f.manifest.expressions.at(-1).parameters=['ParamHappy'];}
    if(kind==='never-lower') await change(dir+'/动作/招手.motion3.json',d=>d.Curves[0].Segments[d.Curves[0].Segments.length-1]=1);
    if(kind==='missing-cdi-param') await change(dir+'/角色.cdi3.json',c=>c.Parameters=c.Parameters.filter(p=>p.Id!=='ParamWave'));
    if(kind==='wrong-brief') f.d.brief.descriptionSha256='0'.repeat(64);
    if(kind==='wrong-rig') await change(f.d.parameterMapPath,m=>m.candidateId='another');
    if(kind==='missing-cdi') await change(f.d.modelPath,m=>delete m.FileReferences.DisplayInfo);
    if(kind==='service-limit') f.ctx.serviceMaxBytes=400;
    f.manifest.preview.modelSha256=(await artifact(f.root,f.d.modelPath)).sha256;
    await f.write(f.d.dynamicsManifestPath,f.manifest);await f.refresh(f.d.dynamicsManifestPath);
    const result=await buildPackage(f.d,f.ctx);
    if(kind==='service-limit') {assert.equal(result.status,'blocked'); assert.equal(result.unresolved.at(-1).code,'DELIVERY_TOO_LARGE');
      assert.ok(result.deliveryFiles.some(f=>f.role==='runtime-package'));return;}
    assert.equal(result.status,'failed');assert.equal(result.unresolved.at(-1).code,'REFERENCE_INVALID');assert.deepEqual(result.deliveryFiles,[]);
  });
});

test('开心允许有自身形变证据的专用 eyes.smile，拒绝跟踪轴和伪绑定', async t => {
  for(const kind of ['dedicated-smile','eyes.open','eye.left.open','eyes.gazeX','wrong-owner','wrong-runtime-owner',
    'unavailable','borrowed-open-axis','no-motion-evidence','zero-motion']) await t.test(kind,async t=>{
    const f=await fixture(t),dir=path.posix.dirname(f.d.modelPath);
    const map=JSON.parse(await fs.readFile(path.join(f.root,f.d.parameterMapPath)));
    // Format fixture mirroring r15: meshes use open directly and inherit a distinct smile axis.
    const smile={id:'ParamEyeSmile',semantic:'eyes.smile',min:0,max:1,default:0,owner:'rigging',available:true,
      bindings:['L','R'].map(side=>({target:'mesh:ArtMeshEyelash'+side,directAxes:{['ParamEye'+side+'Open']:[0,1]},
        inherited:[{target:'warp:DeformSharedAperture'+side,axes:{ParamEyeSmile:[0,1],['ParamEye'+side+'Open']:[0,.25,.5,.75,1]}}]})),
      motionEvidence:[{value:1,defaultImage:'rigging/smile-default.png',posedImage:'rigging/smile-1.png',changedPixels:393,totalPixels:589824}]};
    if(['eyes.open','eye.left.open','eyes.gazeX'].includes(kind))smile.semantic=kind;
    if(kind==='wrong-owner')smile.owner='tracking';
    if(kind==='wrong-runtime-owner')smile.runtimeOwner='tracking';
    if(kind==='unavailable')smile.available=false;
    if(kind==='borrowed-open-axis')for(const b of smile.bindings)delete b.inherited[0].axes.ParamEyeSmile;
    if(kind==='no-motion-evidence')smile.motionEvidence=[];
    if(kind==='zero-motion')smile.motionEvidence[0].changedPixels=0;
    const added=[smile,...[['ParamBrowLY','brow.left.y'],['ParamBrowRY','brow.right.y'],['ParamMouthForm','mouth.form']]
      .map(([id,semantic])=>({id,semantic,min:-1,max:1,default:0,owner:'rigging',available:true}))];
    map.parameters.push(...added);
    await f.write(f.d.parameterMapPath,map);await f.refresh(f.d.parameterMapPath);
    const cdiPath=dir+'/角色.cdi3.json',cdi=JSON.parse(await fs.readFile(path.join(f.root,cdiPath)));
    cdi.Parameters.push(...added.map(p=>({Id:p.id,Name:p.id})));await f.write(cdiPath,cdi);await f.refresh(cdiPath);
    const happy=f.manifest.expressions.find(e=>e.id==='dyn_happy');
    happy.parameters=added.map(p=>p.id);
    await f.write(happy.file,{Type:'Live2D Expression',FadeInTime:.15,FadeOutTime:.15,
      Parameters:added.map((p,i)=>({Id:p.id,Value:[.6,.45,.45,.65][i],Blend:'Add'}))});await f.refresh(happy.file);
    await f.write(f.d.dynamicsManifestPath,f.manifest);await f.refresh(f.d.dynamicsManifestPath);
    const result=await buildPackage(f.d,f.ctx);
    if(kind==='dedicated-smile')assert.equal(result.status,'completed',JSON.stringify(result.unresolved));
    else {assert.equal(result.status,'failed');assert.equal(result.unresolved.at(-1).code,'REFERENCE_INVALID');assert.deepEqual(result.deliveryFiles,[]);}
  });
});

test('3.6.7 引擎附加表情与制作预览保留实际索引，不能替代需求项', async t => {
  const f = await fixture(t), dir = path.posix.dirname(f.d.modelPath);
  const model = JSON.parse(await fs.readFile(path.join(f.root, f.d.modelPath)));
  const refs = model.FileReferences;
  refs.Expressions.splice(1, 0, {Name:'惊讶', File:'表情/惊讶.exp3.json'});
  refs.Motions['制作预览'] = [{File:'动作/制作预览.motion3.json'}];
  for (const [name, source] of [['表情/惊讶.exp3.json','表情/开心.exp3.json'], ['动作/制作预览.motion3.json','动作/待机.motion3.json']]) {
    await f.put(dir+'/'+name, await fs.readFile(path.join(f.root,dir,source)));
    await f.refresh(dir+'/'+name);
  }
  for (const e of f.manifest.expressions) e.leafExpressionId = String(refs.Expressions.findIndex(r=>r.Name===e.name));
  await f.write(f.d.modelPath, model); await f.refresh(f.d.modelPath);
  f.manifest.preview.modelSha256 = (await artifact(f.root,f.d.modelPath)).sha256;
  await f.write(f.d.dynamicsManifestPath, f.manifest); await f.refresh(f.d.dynamicsManifestPath);
  const result = await buildPackage(f.d, f.ctx);
  assert.equal(result.status, 'completed', JSON.stringify(result.unresolved));
  const extracted = path.join(f.root, 'clean-indexes');
  await verifyPackageArchive(path.join(f.root, result.packagePath), result.deliveryFiles[0], extracted, {identity:f.d});
  const manifestPath=path.join(extracted,'manifest.json'), manifest=JSON.parse(await fs.readFile(manifestPath));
  assert.deepEqual(manifest.expressions.map(e=>e.leafId),['0','2','3']);
  assert.deepEqual(manifest.additionalIndexedControls.expressions.map(e=>e.leafId),['1']);
  assert.deepEqual(manifest.additionalIndexedControls.motions.map(m=>m.leafId),['制作预览:0']);
  manifest.additionalIndexedControls.expressions.push(manifest.expressions.pop());
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyPackage(extracted, f.d), {code:'REFERENCE_INVALID'});
});

// Format-only HD adapter double; real rendering/decoding is covered by hd-preview tests and native evidence.
async function formatHdPreview(f) {
  const ident=Object.fromEntries(['taskId','candidateId','revision','parentRevision','inputSha256','descriptionSha256'].map(k=>[k,f.d[k]]));
  const hd={schemaVersion:1,...ident,kind:'parameter_playback',width:1920,height:1080,fps:30,frameCount:31,phases:['fixture-only'],artifacts:[]};
  const trajectoryPath='dynamics/preview-trajectory.json',physicsPath=path.posix.dirname(f.d.modelPath)+'/角色.physics3.json';
  await f.write(trajectoryPath,{scope:'FORMAT_FIXTURE_ONLY',fps:30,frameCount:31});
  await f.write('dynamics/recipe.json',{physics:[{id:'fixture-physics',outputs:[{parameter:'ParamHair'}]}]});
  f.manifest.preview.trajectoryPath=trajectoryPath;await f.write(f.d.dynamicsManifestPath,f.manifest);
  for(const file of [trajectoryPath,'dynamics/recipe.json',f.d.dynamicsManifestPath])await f.refresh(file);
  for(const [key,file,role] of [['videoPath','fixture.mp4','hd-preview-video'],['coverPath','cover.png','hd-preview-cover'],
    ['fullBodyPath','body.png','hd-preview-full-body'],['facePath','face.png','hd-preview-face']]) {
    const relative='packaging-hd-preview/'+file;
    await f.put(relative,file.endsWith('.mp4')?Buffer.concat([u32(24),Buffer.from('ftypisom'),Buffer.alloc(12)]):png);
    hd[key]=relative;hd.artifacts.push(await artifact(f.root,relative,role));
  }
  const modelDirectory=path.posix.dirname(f.d.modelPath),sourcePaths=[f.d.artworkManifestPath,f.d.dynamicsManifestPath,'dynamics/recipe.json',trajectoryPath,
    ...f.d.artifacts.filter(a=>a.path.startsWith(modelDirectory+'/')).map(a=>a.path)].sort();
  const sources=sourcePaths.map(file=>f.d.artifacts.find(a=>a.path===file));
  const modelFiles=sources.filter(a=>a.path.startsWith(modelDirectory+'/'));
  const phaseFrames=[{phase:'fixture-only',first:0,last:30}],sourceRequest={schemaVersion:1,...ident,kind:hd.kind,
    width:hd.width,height:hd.height,fps:hd.fps,frameCount:hd.frameCount,phases:hd.phases,phaseFrames,
    modelPath:f.d.modelPath,artworkManifestPath:f.d.artworkManifestPath,dynamicsManifestPath:f.d.dynamicsManifestPath,trajectoryPath,
    physics:{path:physicsPath,groups:['fixture-physics'],outputs:['ParamHair']},modelFiles,sources,
    rendererScript:{path:'scripts/hachi-g1-preview.mjs',sha256:hash('format-renderer'),bytes:1}};
  const requestBytes=Buffer.from(JSON.stringify(sourceRequest,null,2)+'\n'),record=a=>({sha256:a.sha256,bytes:a.bytes});
  hd.provenancePath='packaging-hd-preview/proof.json';
  await f.write(hd.provenancePath,{schemaVersion:2,...ident,kind:hd.kind,renderer:'FORMAT_FIXTURE_ONLY',
    width:hd.width,height:hd.height,fps:hd.fps,frameCount:hd.frameCount,phases:hd.phases,phaseFrames,
    entry:path.join(f.root,f.d.modelPath),sourceRequest,request:{sha256:hash(requestBytes),bytes:requestBytes.length},
    trajectory:record(sources.find(a=>a.path===trajectoryPath)),artworkManifest:record(sources.find(a=>a.path===f.d.artworkManifestPath)),
    modelFiles:modelFiles.map(a=>({file:path.posix.relative(modelDirectory,a.path),...record(a)})),
    physics:{groups:['fixture-physics'],outputs:[{parameter:'ParamHair',samples:31,min:0,max:0}],observedFrames:31,nativeEvaluations:31,parameterOverrides:false},
    video:{file:path.posix.basename(hd.videoPath),...record(hd.artifacts.find(a=>a.path===hd.videoPath))},
    stills:hd.artifacts.filter(a=>a.path!==hd.videoPath).map(a=>({file:path.posix.basename(a.path),...record(a)}))});
  hd.artifacts.push(await artifact(f.root,hd.provenancePath,'hd-preview-provenance'));
  return hd;
}

test('new production HD adapter packages full-body/face and source proof with the selected video',async t=>{
  const f=await fixture(t),hd=await formatHdPreview(f),original=await fs.readFile(path.join(f.root,hd.provenancePath));let calls=0;
  f.ctx.buildHdPreview=async input=>{calls++;assert.deepEqual(input.dynamics,f.d);assert.equal(input.taskRoot,f.root);return hd;};
  const result=await buildPackage(f.d,f.ctx);assert.equal(result.status,'completed',JSON.stringify(result.unresolved));
  assert.equal(result.hdPreviewContract,1);assert.equal(calls,1);
  const manifest=JSON.parse(await fs.readFile(path.join(f.root,result.packageManifestPath)));
  assert.equal(manifest.preview.hdContract,1);assert.equal(manifest.preview.videoPath,'preview/fixture.mp4');
  for(const key of ['fullBodyPath','facePath','provenancePath'])assert(manifest.files.some(a=>a.path===manifest.preview[key]));
  const clean=path.join(f.root,'hd-clean');await verifyPackageArchive(path.join(f.root,result.packagePath),result.deliveryFiles[0],clean,{identity:f.d});
  const proofPath=path.join(clean,manifest.preview.provenancePath),proof=JSON.parse(await fs.readFile(proofPath));
  assert(proof.sourceProvenance.path.startsWith('preview/'),'render provenance must be inside the movable package');
  const portableBytes=await fs.readFile(path.join(clean,proof.sourceProvenance.path)),portable=JSON.parse(portableBytes);
  assert.deepEqual(proof.originalProvenance,{sha256:hash(original),bytes:original.length});
  assert.deepEqual(portable,{...JSON.parse(original),entry:manifest.modelPath});
  assert.equal(portableBytes.includes(Buffer.from(f.root)),false,'no local absolute path is published');
  assert.deepEqual(await fs.readFile(path.join(f.root,hd.provenancePath)),original,'local original is unchanged');
  await buildPackage(f.d,f.ctx);assert.equal(calls,1,'completed same-source pack is reused');
  await fs.rename(path.join(f.root,'packaging-hd-preview'),path.join(f.root,'private-hd-source'));
  assert.equal((await verifyPackage(clean,f.d)).hashes,'passed','verification uses only portable package members');
  proof.frameCount++;await fs.writeFile(proofPath,JSON.stringify(proof));
  manifest.files=manifest.files.map(a=>a.path===manifest.preview.provenancePath?{...a,sha256:hash(JSON.stringify(proof)),bytes:Buffer.byteLength(JSON.stringify(proof))}:a);
  await fs.writeFile(path.join(clean,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(()=>verifyPackage(clean,f.d),e=>e.code==='REFERENCE_INVALID');
});

test('required final review gates packaging and binds the portable receipt to the exact video',async t=>{
  const f=await fixture(t),hd=await formatHdPreview(f);
  f.ctx.buildHdPreview=async()=>hd;
  f.ctx.requireFinalPreviewReview=true;
  const pending=await buildPackage(f.d,f.ctx);
  assert.equal(pending.status,'blocked');
  assert.equal(pending.finalPreviewReview.status,'pending');
  assert.equal(pending.deliveryFiles.length,0);
  await assert.rejects(fs.access(path.join(f.root,'packaging')),{code:'ENOENT'});
  const request=JSON.parse(await fs.readFile(path.join(f.root,pending.finalPreviewReview.requestPath)));
  assert.equal(request.schemaVersion,3);
  assert(request.criteria.includes('hand_wrist_elbow')&&request.criteria.includes('brow_layer_ownership'));
  const observation={...request,observationMedium:'continuous_video',playbackRate:1,
    range:[0,request.duration],reviewer:'synthetic test fixture',
    observations:request.criteria.map(criterion=>({criterion,status:'passed',note:'synthetic observation'}))};
  for(const invalid of [
    {...observation,video:{...request.video,sha256:hash('other video')}},
    {...observation,observationMedium:'contact_sheet'},
    {...observation,observations:observation.observations.filter(o=>o.criterion!=='idle_hands_and_head_body_coupling')},
    {...observation,range:[0,request.duration/2]}
  ])await assert.rejects(recordFinalPreviewReview(f.root,invalid),{code:'FINAL_PREVIEW_REVIEW_INVALID'});
  assert.equal((await recordFinalPreviewReview(f.root,observation)).status,'passed');
  const result=await buildPackage(f.d,f.ctx);
  assert.equal(result.status,'completed',JSON.stringify(result.unresolved));
  assert.equal(result.finalPreviewReview.sha256,request.video.sha256);
  const clean=path.join(f.root,'final-reviewed-clean');
  await verifyPackageArchive(path.join(f.root,result.packagePath),result.deliveryFiles[0],clean,{identity:f.d});
  const manifestPath=path.join(clean,'manifest.json');
  const manifest=JSON.parse(await fs.readFile(manifestPath));
  assert.equal(manifest.preview.finalReviewPath,'preview/final-review.json');
  delete manifest.preview.finalReviewPath;
  await fs.writeFile(manifestPath,JSON.stringify(manifest));
  await assert.rejects(verifyPackage(clean,f.d),{code:'REFERENCE_INVALID'});
});

test('HD adapter cannot package a foreign candidate or an unregistered still',async t=>{
  for(const mode of ['foreign','missing']) {
    const f=await fixture(t),hd=await formatHdPreview(f);f.ctx.buildHdPreview=async()=>{if(mode==='foreign')hd.revision='foreign';else hd.artifacts=hd.artifacts.filter(a=>a.path!==hd.facePath);return hd;};
    const result=await buildPackage(f.d,f.ctx);assert.equal(result.status,'failed');assert.equal(result.deliveryFiles.length,0);
    assert(result.unresolved.some(e=>e.code==='REFERENCE_INVALID'));
  }
});

test('portable HD source rejects broken identity, trajectory, resource, output and private-path closure after rehashing',async t=>{
  const f=await fixture(t),hd=await formatHdPreview(f);f.ctx.buildHdPreview=async()=>hd;
  const result=await buildPackage(f.d,f.ctx);assert.equal(result.status,'completed',JSON.stringify(result.unresolved));
  const clean=path.join(f.root,'hd-source-clean');
  await verifyPackageArchive(path.join(f.root,result.packagePath),result.deliveryFiles[0],clean,{identity:f.d});
  const manifest=JSON.parse(await fs.readFile(path.join(clean,'manifest.json'))),proofPath=manifest.preview.provenancePath;
  const originalProof=await fs.readFile(path.join(clean,proofPath)),sourcePath=JSON.parse(originalProof).sourceProvenance.path;
  const originalSource=await fs.readFile(path.join(clean,sourcePath));
  const mutations={
    'six-field identity':s=>{s.parentRevision='foreign';},
    'source request identity':s=>{s.sourceRequest.descriptionSha256=hash('foreign');},
    'trajectory hash':s=>{s.trajectory.sha256=hash('foreign trajectory');},
    'trajectory registration':s=>{s.sourceRequest.sources.find(a=>a.path===s.sourceRequest.trajectoryPath).sha256=hash('unregistered trajectory');},
    'model resource hash':s=>{s.modelFiles[0].sha256=hash('foreign resource');},
    'missing model resource':s=>{s.sourceRequest.modelFiles.pop();},
    'rendered video hash':s=>{s.video.sha256=hash('another video');},
    'private source path':s=>{s.sourceRequest.rendererScript.path='/Users/private-fixture/scripts/render.mjs';}
  };
  for(const [name,mutate] of Object.entries(mutations))await t.test(name,async()=>{
    const source=JSON.parse(originalSource),proof=JSON.parse(originalProof);mutate(source);
    const request=Buffer.from(JSON.stringify(source.sourceRequest,null,2)+'\n');source.request={sha256:hash(request),bytes:request.length};
    await fs.writeFile(path.join(clean,sourcePath),JSON.stringify(source));
    proof.sourceProvenance=await artifact(clean,sourcePath);
    await fs.writeFile(path.join(clean,proofPath),JSON.stringify(proof));
    for(const file of [sourcePath,proofPath])manifest.files[manifest.files.findIndex(a=>a.path===file)]=await artifact(clean,file);
    await fs.writeFile(path.join(clean,'manifest.json'),JSON.stringify(manifest));
    await assert.rejects(verifyPackage(clean,f.d),{code:'REFERENCE_INVALID'});
  });
  const source=JSON.parse(originalSource);source.entry=path.join(f.root,f.d.modelPath);source.sourceRequest.rendererScript.path='/Users/private-fixture/scripts/render.mjs';
  await f.write(hd.provenancePath,source);hd.artifacts[hd.artifacts.findIndex(a=>a.path===hd.provenancePath)]=await artifact(f.root,hd.provenancePath,'hd-preview-provenance');
  await fs.rm(path.join(f.root,'packaging'),{recursive:true});
  const rejected=await buildPackage(f.d,f.ctx);assert.equal(rejected.status,'failed');assert.equal(rejected.deliveryFiles.length,0);
  assert.match(rejected.unresolved.at(-1).message,/绝对路径/);
});

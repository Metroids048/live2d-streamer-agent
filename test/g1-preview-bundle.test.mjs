import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {createG1PreviewBundle,g1PreviewSources} from '../src/pipeline/g1-preview.mjs';
import {artifact,digest,json} from '../src/packaging/files.mjs';
import {ffmpeg} from '../src/preview.mjs';

// Source/registration contract only: structural MOC bytes and a decoded black film
// do not demonstrate model rendering, visual acceptance or native playback.
async function fixture(t,{state=true}={}) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-g1-bundle-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const base='revisions/r0002',render=base+'/g1-preview/render',model=base+'/rigging/model';
  for(const dir of [render,model,base+'/artwork'])await fs.mkdir(path.join(root,dir),{recursive:true});
  const job={id:'task',kind:'single_image',candidateId:'candidate',revision:1,output:root,
    source:{inputSha256:'input',descriptionSha256:'description'}};
  const identity={taskId:job.id,candidateId:job.candidateId,revision:2,parentRevision:1,...job.source};
  const write=async(relative,value)=>fs.writeFile(path.join(root,relative),JSON.stringify(value));
  await write(base+'/artwork/artwork-manifest.json',identity);
  const png=Buffer.from('89504e470d0a1a0a','hex');
  await fs.writeFile(path.join(root,model+'/texture.png'),png);
  await fs.writeFile(path.join(root,model+'/layout.moc3'),'MOC3fixture');
  await write(model+'/layout.model3.json',{Version:3,FileReferences:{Moc:'layout.moc3',Textures:['texture.png']}});
  await fs.writeFile(path.join(root,base+'/rigging/candidate.psd2live'),'PKproject');
  await fs.writeFile(path.join(root,base+'/rigging/candidate.psd'),'8BPSfixture');
  await write(base+'/rigging/parameter-map.json',{...identity,projectId:'project',state:'state-1'});
  await write(base+'/rigging/export-receipt.json',{exported:true});
  if(state)await write(base+'/rigging/state.json',{identity,projectId:'project',state:'state-1',pending:null});
  const files=['candidate.psd2live','candidate.psd','parameter-map.json','export-receipt.json',
    'model/layout.model3.json','model/layout.moc3','model/texture.png'];
  const rig={schemaVersion:1,stage:'rigging',status:'blocked',...identity,engineProjectId:'project',engineRevision:'state-1',
    projectPath:'rigging/candidate.psd2live',psdPath:'rigging/candidate.psd',parameterMapPath:'rigging/parameter-map.json',
    modelPath:'rigging/model/layout.model3.json',artifacts:[]};
  const refreshRig=async()=>{
    rig.artifacts=await Promise.all(files.map(file=>artifact(path.join(root,base),'rigging/'+file,'rigging_file')));
    await write(base+'/rigging/stage.json',rig);
  };
  await refreshRig();
  await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=1920x1080:r=30',
    '-t','8','-an','-c:v','libx264','-preset','ultrafast','-threads','1','-pix_fmt','yuv420p',path.join(root,render+'/Hachi-G1-1080p30.mp4')]);
  for(const name of ['pose-0000','full-body','face'])await fs.writeFile(path.join(root,render+'/'+name+'.png'),png);
  const modelFiles=await Promise.all(['layout.model3.json','layout.moc3','texture.png'].map(async file=>({file,...await digest(path.join(root,model,file))})));
  const provenance={...identity,artworkManifest:await digest(path.join(root,base+'/artwork/artwork-manifest.json')),
    entry:path.join(root,model+'/layout.model3.json'),modelFiles,width:1920,height:1080,fps:30,seconds:8,frameCount:240,
    samples:[{parameters:{ParamAngleX:-10,ParamMouthOpenY:0,ParamEyeLOpen:1}},
      {parameters:{ParamAngleX:10,ParamMouthOpenY:.8,ParamEyeLOpen:0}}],video:await digest(path.join(root,render+'/Hachi-G1-1080p30.mp4'))};
  await write(render+'/render-provenance.json',provenance);
  return {root,base,render,job,rig,identity,write,refreshRig,provenance,
    manifest:path.join(root,base+'/g1-preview/stage.json')};
}

test('G1 verifies every registered rig source and requires the real project/PSD/map/model entries',async t=>{
  const f=await fixture(t);
  await fs.appendFile(path.join(f.root,f.base+'/rigging/export-receipt.json'),'changed');
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_CHANGED'});
  await f.refreshRig();
  for(const key of ['projectPath','psdPath','parameterMapPath','modelPath']) {
    const old=f.rig[key];delete f.rig[key];await f.write(f.base+'/rigging/stage.json',f.rig);
    await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_INVALID'});
    f.rig[key]=old;
  }
  const removed=f.rig.artifacts.shift();await f.write(f.base+'/rigging/stage.json',f.rig);
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_INVALID'});
  f.rig.artifacts.unshift(removed);await f.write(f.base+'/rigging/stage.json',f.rig);
  await fs.writeFile(path.join(f.root,f.base+'/rigging/.build.lock'),'active');
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_BUSY'});
});

test('G1 publication rejects a changed project, PSD, parameter map or optional engine journal',async t=>{
  const f=await fixture(t),bundle=await createG1PreviewBundle(f.job);
  for(const relative of ['rigging/candidate.psd2live','rigging/candidate.psd','rigging/parameter-map.json','rigging/state.json']) {
    assert.ok(bundle.artifacts.some(a=>a.path===f.base+'/'+relative),relative+' is hashed');
    const file=path.join(f.root,f.base,relative),before=await fs.readFile(file);
    await fs.appendFile(file,'changed');
    await assert.rejects(g1PreviewSources(f.job));
    await fs.writeFile(file,before);
  }
  assert.equal((await g1PreviewSources(f.job)).sources.length,4);
});

test('G1 does not require an unregistered journal, but validates a present journal and map binding',async t=>{
  const f=await fixture(t,{state:false});
  await createG1PreviewBundle(f.job);
  await f.write(f.base+'/rigging/state.json',{identity:f.identity,projectId:'foreign',state:'state-1'});
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
  await fs.rm(path.join(f.root,f.base+'/rigging/state.json'));
  await f.write(f.base+'/rigging/parameter-map.json',{...f.identity,projectId:'foreign',state:'state-1'});
  await f.refreshRig();
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
});

test('G1 re-registration keeps exact old manifest and media, then atomically adopts a new render directory',async t=>{
  const f=await fixture(t);await createG1PreviewBundle(f.job);
  const before=await fs.readFile(f.manifest),oldVideo=await digest(path.join(f.root,f.render+'/Hachi-G1-1080p30.mp4'));
  const next=f.base+'/g1-preview/render-2';await fs.cp(path.join(f.root,f.render),path.join(f.root,next),{recursive:true});
  await f.write(next+'/render-provenance.json',{...f.provenance,attempt:2});
  const bundle=await createG1PreviewBundle(f.job,{renderDirectory:next});
  assert.deepEqual(await fs.readFile(path.join(f.root,bundle.previousManifest.path)),before);
  assert.equal(bundle.previousManifest.sha256,(await digest(path.join(f.root,bundle.previousManifest.path))).sha256);
  assert.deepEqual(await digest(path.join(f.root,f.render+'/Hachi-G1-1080p30.mp4')),oldVideo);
  assert.equal(bundle.artifacts.find(a=>a.role==='g1-video').path,next+'/Hachi-G1-1080p30.mp4');
  assert.equal((await g1PreviewSources(f.job)).sources.length,4);
});

test('G1 will not replace a manifest whose old media were overwritten or whose new sources are invalid',async t=>{
  const f=await fixture(t);await createG1PreviewBundle(f.job);const before=await fs.readFile(f.manifest);
  const face=path.join(f.root,f.render+'/face.png'),faceBefore=await fs.readFile(face);
  await fs.appendFile(face,'changed');
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_CHANGED'});
  assert.deepEqual(await fs.readFile(f.manifest),before);
  await fs.writeFile(face,faceBefore);await fs.appendFile(path.join(f.root,f.base+'/rigging/candidate.psd2live'),'changed');
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_CHANGED'});
  assert.deepEqual(await fs.readFile(f.manifest),before);
});

async function lineageFixture(t,{lastRevision=3,parentRevisions={}}={}) {
  const f=await fixture(t),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
  const bases=Object.fromEntries(Array.from({length:lastRevision},(_,i)=>[i+1,i===0?'':`revisions/r${String(i+1).padStart(4,'0')}`])),identities={};
  for(let revision=1;revision<=lastRevision;revision++) {
    const base=bases[revision],prefix=base?base+'/':'',identity={...f.identity,revision,
      parentRevision:parentRevisions[revision]??(revision===1?null:revision-1)};
    identities[revision]=identity;
    if(revision!==2) {
      await fs.mkdir(path.join(f.root,prefix+'artwork'),{recursive:true});
      await fs.cp(path.join(f.root,f.base+'/rigging'),path.join(f.root,prefix+'rigging'),{recursive:true});
      if(revision>=3)await fs.cp(path.join(f.root,f.render),path.join(f.root,prefix+'g1-preview/render'),{recursive:true});
    }
    const layout=Buffer.from(JSON.stringify({layers:[{id:'face',image:'face.png'}]})),part=Buffer.from('actual-r'+revision+'-face');
    await fs.writeFile(path.join(f.root,prefix+'artwork/layout.json'),layout);
    await fs.writeFile(path.join(f.root,prefix+'artwork/face.png'),part);
    const parts=[{id:'face',path:'face.png',sha256:sha(part),rect:{left:0,top:0,width:1,height:1}}];
    const artworkFingerprint=sha(Buffer.from(JSON.stringify({layoutSha256:sha(layout),parts:parts.map(({id,sha256,rect})=>({id,sha256,rect}))})));
    const manifest={schemaVersion:1,...identity,layoutPath:'layout.json',parts,...(revision>1?{artworkFingerprint}:{})};
    const stage={schemaVersion:1,stage:'artwork',status:'completed',...identity,layoutPath:'artwork/layout.json',
      artworkManifestPath:'artwork/artwork-manifest.json',...(revision>1?{artworkFingerprint}:{}),artifacts:[]};
    if(revision>=3) {
      const parentBase=bases[identity.parentRevision],parent=JSON.parse(await fs.readFile(path.join(f.root,parentBase+'/artwork/artwork-manifest.json')));
      const links={parentArtworkFingerprint:parent.artworkFingerprint,
        parentArtworkStage:{path:path.posix.relative(base,parentBase+'/artwork/stage.json'),...await digest(path.join(f.root,parentBase+'/artwork/stage.json'))},
        parentArtworkManifest:{path:path.posix.relative(base,parentBase+'/artwork/artwork-manifest.json'),...await digest(path.join(f.root,parentBase+'/artwork/artwork-manifest.json'))}};
      Object.assign(manifest,links);Object.assign(stage,links);
    }
    await f.write(prefix+'artwork/artwork-manifest.json',manifest);
    stage.artifacts=await Promise.all(['artwork/artwork-manifest.json','artwork/layout.json','artwork/face.png'].map(file=>artifact(path.join(f.root,base),file,'artwork_file')));
    await f.write(prefix+'artwork/stage.json',stage);
    await f.write(prefix+'rigging/parameter-map.json',{...identity,projectId:'project',state:'state-1'});
    await f.write(prefix+'rigging/state.json',{identity,projectId:'project',state:'state-1',pending:null});
    const rig={...f.rig,...identity,artifacts:await Promise.all(f.rig.artifacts.map(a=>artifact(path.join(f.root,base),a.path,a.role)))};
    await f.write(prefix+'rigging/stage.json',rig);
    if(revision>1)await f.write(prefix+'g1-preview/render/render-provenance.json',{...f.provenance,...identity,
      artworkManifest:await digest(path.join(f.root,prefix+'artwork/artwork-manifest.json')),
      entry:path.join(f.root,prefix+'rigging/model/layout.model3.json')});
  }
  return {...f,bases,identities,pointer:path.join(f.root,'g1-preview-current.json')};
}

test('G1 r7 follows its real parent5 branch, excludes sibling r6, and freezes the selected ancestry',async t=>{
  const f=await lineageFixture(t,{lastRevision:7,parentRevisions:{6:5,7:5}});
  await createG1PreviewBundle(f.job,{revision:5});
  const r5Manifest=path.join(f.root,f.bases[5],'/g1-preview/stage.json'),r5Before=await fs.readFile(r5Manifest),pointerBefore=await fs.readFile(f.pointer);
  // A sibling may be failed or unavailable; it is not part of r7's provenance.
  await fs.rm(path.join(f.root,f.bases[6]),{recursive:true});
  const bundle=await createG1PreviewBundle(f.job,{revision:7});
  assert.equal(f.job.revision,1);assert.equal(bundle.parentRevision,5);assert.equal(bundle.status,'pending_user_review');
  assert.deepEqual(bundle.parents.map(p=>[p.revision,p.parentRevision]),[[5,4],[4,3],[3,2],[2,1],[1,null]]);
  assert.equal(bundle.checks.userAcceptance,'pending');assert.equal(bundle.checks.nativePlayback,'not_run');
  const pointer=JSON.parse(await fs.readFile(f.pointer));assert.equal(pointer.parentRevision,5);
  assert.deepEqual(await fs.readFile(path.join(f.root,pointer.previousPointer.path)),pointerBefore);
  assert.deepEqual(await fs.readFile(r5Manifest),r5Before);
  assert.equal((await g1PreviewSources(f.job)).bundle.revision,7);
  const parentJournal=path.join(f.root,f.bases[5],'/rigging/state.json'),before=await fs.readFile(parentJournal);
  await fs.appendFile(parentJournal,' ');
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_CHANGED'});
  await assert.rejects(createG1PreviewBundle(f.job,{revision:7}),{code:'PREVIEW_CHANGED'});
  await fs.writeFile(parentJournal,before);
  await f.write('g1-preview-current.json',{...pointer,parentRevision:6});
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
});

test('G1 real-branch selection rejects invalid parents, disagreement and changed parent pins',async t=>{
  const f=await lineageFixture(t,{lastRevision:7,parentRevisions:{6:5,7:5}}),relative=f.bases[7]+'/artwork/stage.json';
  const saved=await fs.readFile(path.join(f.root,relative)),stage=JSON.parse(saved);
  for(const parentRevision of [7,8,0,null,'5',5.5,6]) {
    await f.write(relative,{...stage,parentRevision});
    await assert.rejects(createG1PreviewBundle(f.job,{revision:7}),{code:'PREVIEW_IDENTITY_MISMATCH'});
  }
  await f.write(relative,{...stage,parentArtworkStage:{...stage.parentArtworkStage,path:'../r0006/artwork/stage.json'}});
  await assert.rejects(createG1PreviewBundle(f.job,{revision:7}),{code:'PREVIEW_IDENTITY_MISMATCH'});
  await f.write(relative,{...stage,parentArtworkManifest:{...stage.parentArtworkManifest,sha256:'0'.repeat(64)}});
  await assert.rejects(createG1PreviewBundle(f.job,{revision:7}),{code:'PREVIEW_CHANGED'});
  await fs.writeFile(path.join(f.root,relative),saved);
  const rigRelative=f.bases[7]+'/rigging/stage.json',rig=JSON.parse(await fs.readFile(path.join(f.root,rigRelative)));
  await f.write(rigRelative,{...rig,parentRevision:6});
  await assert.rejects(createG1PreviewBundle(f.job,{revision:7}),{code:'PREVIEW_IDENTITY_MISMATCH'});
});

test('G1 explicit r3 keeps job revision 1, freezes the real r3→r2→r1 lineage, and selects only its atomic pointer',async t=>{
  const f=await lineageFixture(t),r2=await fs.readFile(path.join(f.root,f.base+'/artwork/stage.json'));
  await createG1PreviewBundle(f.job);
  const before=await fs.readFile(f.pointer),r2Bundle=await fs.readFile(f.manifest);
  const bundle=await createG1PreviewBundle(f.job,{revision:3});
  assert.equal(f.job.revision,1);assert.equal(bundle.revision,3);assert.equal(bundle.parentRevision,2);
  assert.deepEqual(bundle.parents.map(p=>p.revision),[2,1]);
  assert.ok(bundle.parents.every(p=>p.artworkStage.sha256&&p.artworkManifest.sha256&&p.rigStage.sha256));
  const pointer=JSON.parse(await fs.readFile(f.pointer));
  assert.equal(pointer.manifest.path,'revisions/r0003/g1-preview/stage.json');
  assert.deepEqual(await digest(path.join(f.root,pointer.manifest.path)),{sha256:pointer.manifest.sha256,bytes:pointer.manifest.bytes});
  assert.deepEqual(await fs.readFile(path.join(f.root,pointer.previousPointer.path)),before);
  const result=await g1PreviewSources(f.job);
  assert.equal(result.bundle.revision,3);assert.ok(result.sources.every(s=>s.artifact.path.startsWith('revisions/r0003/')));
  assert.deepEqual(await fs.readFile(f.manifest),r2Bundle);assert.deepEqual(await fs.readFile(path.join(f.root,f.base+'/artwork/stage.json')),r2);
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
  assert.deepEqual(await fs.readFile(f.manifest),r2Bundle);
  await fs.rm(f.pointer);assert.equal((await g1PreviewSources(f.job)).bundle.revision,2);
});

test('G1 r3 refuses missing, foreign or changed ancestry and does not silently refresh frozen parent hashes',async t=>{
  const f=await lineageFixture(t),parent=f.base+'/artwork/stage.json',before=await fs.readFile(path.join(f.root,parent));
  await fs.appendFile(path.join(f.root,parent),' ');
  await assert.rejects(createG1PreviewBundle(f.job,{revision:3}),{code:'PREVIEW_CHANGED'});
  await fs.writeFile(path.join(f.root,parent),before);
  const missing=path.join(f.root,'rigging/stage.json'),rig=await fs.readFile(missing);await fs.rm(missing);
  await assert.rejects(createG1PreviewBundle(f.job,{revision:3}));await fs.writeFile(missing,rig);
  const bundle=await createG1PreviewBundle(f.job,{revision:3});assert.equal(bundle.status,'pending_user_review');
  for(const relative of [parent,'artwork/artwork-manifest.json','rigging/candidate.psd2live','revisions/r0003/artwork/face.png']) {
    const file=path.join(f.root,relative),bytes=await fs.readFile(file);await fs.appendFile(file,'changed');
    await assert.rejects(g1PreviewSources(f.job));await fs.writeFile(file,bytes);
  }
  const rootStage=JSON.parse(await fs.readFile(missing));rootStage.candidateId='foreign';await f.write('rigging/stage.json',rootStage);
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
});

test('G1 rejects corrupt or foreign pointers without fallback and preserves selection when a new render fails',async t=>{
  const f=await lineageFixture(t);await createG1PreviewBundle(f.job);const before=await fs.readFile(f.pointer);
  await fs.appendFile(path.join(f.root,'revisions/r0003/g1-preview/render/face.png'),'changed');
  // Still images are newly hashed; a changed rendered model is what invalidates registration.
  await fs.appendFile(path.join(f.root,'revisions/r0003/rigging/model/texture.png'),'changed');
  await assert.rejects(createG1PreviewBundle(f.job,{revision:3}),{code:'PREVIEW_CHANGED'});
  assert.deepEqual(await fs.readFile(f.pointer),before);
  const pointer=JSON.parse(before);
  for(const altered of [{...pointer,candidateId:'foreign'},{...pointer,manifest:{...pointer.manifest,path:'revisions/r0003/g1-preview/stage.json'}},
    {...pointer,manifest:{...pointer.manifest,sha256:'0'.repeat(64)}}]) {
    await f.write('g1-preview-current.json',altered);await assert.rejects(g1PreviewSources(f.job));
  }
  await fs.writeFile(f.pointer,'{');await assert.rejects(g1PreviewSources(f.job));
  await fs.writeFile(f.pointer,before);assert.equal((await g1PreviewSources(f.job)).bundle.revision,2);
});

test('G1 r3 re-registration cannot refresh changed frozen ancestors or omit the artwork fingerprint contract',async t=>{
  const f=await lineageFixture(t),stage='revisions/r0003/artwork/stage.json';
  const savedStage=await fs.readFile(path.join(f.root,stage)),value=JSON.parse(savedStage);
  for(const altered of [{...value,artworkFingerprint:'0'.repeat(64)},
    {...value,parentArtworkFingerprint:'0'.repeat(64)},
    {...value,parentArtworkManifest:undefined}]) {
    await f.write(stage,altered);await assert.rejects(createG1PreviewBundle(f.job,{revision:3}));
  }
  await fs.writeFile(path.join(f.root,stage),savedStage);
  await createG1PreviewBundle(f.job,{revision:3});
  const pointer=await fs.readFile(f.pointer),manifest=await fs.readFile(path.join(f.root,'revisions/r0003/g1-preview/stage.json'));
  // Whitespace changes the ancestor stage hash without invalidating its contents.
  await fs.appendFile(path.join(f.root,'artwork/stage.json'),' ');
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_CHANGED'});
  await assert.rejects(createG1PreviewBundle(f.job,{revision:3}),{code:'PREVIEW_CHANGED'});
  assert.deepEqual(await fs.readFile(f.pointer),pointer);
  assert.deepEqual(await fs.readFile(path.join(f.root,'revisions/r0003/g1-preview/stage.json')),manifest);
});

async function failedAncestorFixture(t,{journalArtifact=false}={}) {
  const f=await lineageFixture(t,{lastRevision:4}),base=f.bases[3],identity=f.identities[3];
  await fs.rm(path.join(f.root,base+'/rigging'),{recursive:true});
  await fs.mkdir(path.join(f.root,base+'/rigging'));
  await fs.writeFile(path.join(f.root,base+'/rigging/layout.psd2live'),'actual-partial-project');
  await f.write(base+'/rigging/topology.json',{status:'failed',code:'MESH_TOPOLOGY_INVALID'});
  // Real r3 failed before export: stage has no engine/model/map/PSD fields,
  // while its journal retains the actual partial engine project and state.
  const stage={schemaVersion:1,stage:'rigging',status:'blocked',...identity,
    unresolved:[{code:'MESH_TOPOLOGY_INVALID',message:'MESH_TOPOLOGY_INVALID',stage:'rigging'}],artifacts:[]};
  const journal={schemaVersion:1,identity,projectId:'partial-project',state:'partial-state:1:91',pending:null,failed:null};
  await f.write(base+'/rigging/state.json',journal);
  stage.artifacts=await Promise.all(['rigging/layout.psd2live','rigging/topology.json',...(journalArtifact?['rigging/state.json']:[])].map(file=>artifact(path.join(f.root,base),file,'rigging_file')));
  await f.write(base+'/rigging/stage.json',stage);
  return {...f,ancestorBase:base,ancestorStage:stage,ancestorJournal:journal};
}

test('G1 r4 freezes the honest unexported MESH_TOPOLOGY_INVALID r3 ancestor without requiring a model',async t=>{
  const f=await failedAncestorFixture(t),p=f.ancestorBase+'/rigging/',before=await fs.readFile(path.join(f.root,p+'stage.json'));
  const journal=await fs.readFile(path.join(f.root,p+'state.json'));
  const bundle=await createG1PreviewBundle(f.job,{revision:4});
  assert.equal(bundle.revision,4);assert.equal(bundle.parentRevision,3);assert.equal(bundle.status,'pending_user_review');assert.equal(f.job.revision,1);
  assert.deepEqual(bundle.parents.map(p=>p.revision),[3,2,1]);
  assert.equal(bundle.parents[0].rigStage.sha256,(await digest(path.join(f.root,p+'stage.json'))).sha256);
  assert.equal(bundle.parents[0].engineJournal.sha256,(await digest(path.join(f.root,p+'state.json'))).sha256);
  assert.deepEqual(await fs.readFile(path.join(f.root,p+'stage.json')),before);
  assert.deepEqual(await fs.readFile(path.join(f.root,p+'state.json')),journal);
  assert.equal((await g1PreviewSources(f.job)).sources.length,4);
  const pointer=await fs.readFile(f.pointer);
  for(const relative of [p+'stage.json',p+'state.json',p+'layout.psd2live',p+'topology.json']) {
    const file=path.join(f.root,relative),bytes=await fs.readFile(file);await fs.appendFile(file,' ');
    await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_CHANGED'});
    await assert.rejects(createG1PreviewBundle(f.job,{revision:4}),{code:'PREVIEW_CHANGED'});
    await fs.writeFile(file,bytes);assert.deepEqual(await fs.readFile(f.pointer),pointer);
  }
});

test('G1 ancestor freezing accepts a recorded failed journal but strictly validates registered journal, identity and paths',async t=>{
  const f=await failedAncestorFixture(t,{journalArtifact:true}),base=f.ancestorBase;
  f.ancestorJournal.failed={code:'MESH_TOPOLOGY_INVALID',operation:'mesh'};
  await f.write(base+'/rigging/state.json',f.ancestorJournal);
  f.ancestorStage.artifacts=await Promise.all(f.ancestorStage.artifacts.map(a=>artifact(path.join(f.root,base),a.path,a.role)));
  await f.write(base+'/rigging/stage.json',f.ancestorStage);
  await createG1PreviewBundle(f.job,{revision:4});assert.equal((await g1PreviewSources(f.job)).sources.length,4);
  for(const altered of [{...f.ancestorStage,candidateId:'foreign'},
    {...f.ancestorStage,artifacts:[{...f.ancestorStage.artifacts[0],path:'../r0002/rigging/layout.psd2live'}]},
    {...f.ancestorStage,artifacts:[...f.ancestorStage.artifacts,f.ancestorStage.artifacts[0]]}]) {
    await f.write(base+'/rigging/stage.json',altered);await assert.rejects(g1PreviewSources(f.job));
  }
  await f.write(base+'/rigging/stage.json',f.ancestorStage);
  await fs.writeFile(path.join(f.root,base+'/rigging/.build.lock'),'active');
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_BUSY'});
  await fs.rm(path.join(f.root,base+'/rigging/.build.lock'));
  const journalBytes=await fs.readFile(path.join(f.root,base+'/rigging/state.json'));
  await f.write(base+'/rigging/state.json',{...f.ancestorJournal,identity:{...f.ancestorJournal.identity,candidateId:'foreign'}});
  const alteredStage={...f.ancestorStage,artifacts:await Promise.all(f.ancestorStage.artifacts.map(a=>artifact(path.join(f.root,base),a.path,a.role)))};
  await f.write(base+'/rigging/stage.json',alteredStage);
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
  await fs.writeFile(path.join(f.root,base+'/rigging/state.json'),journalBytes);
  await f.write(base+'/rigging/stage.json',f.ancestorStage);
  const original=f.ancestorStage.artifacts.find(a=>a.path==='rigging/state.json');
  await fs.appendFile(path.join(f.root,base+'/'+original.path),' ');
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_CHANGED'});
});

test('G1 r4 selected revision still rejects missing exports, failed or pending journals and active locks',async t=>{
  const f=await failedAncestorFixture(t),base=f.bases[4],stagePath=base+'/rigging/stage.json',statePath=base+'/rigging/state.json';
  const stage=JSON.parse(await fs.readFile(path.join(f.root,stagePath))),state=JSON.parse(await fs.readFile(path.join(f.root,statePath)));
  for(const key of ['engineRevision','modelPath','projectPath','psdPath','parameterMapPath']) {
    const altered={...stage};delete altered[key];await f.write(stagePath,altered);
    await assert.rejects(createG1PreviewBundle(f.job,{revision:4}),{code:'PREVIEW_INVALID'});
  }
  for(const changed of [{...stage,status:'failed'},{...stage,pending:{id:'active-operation'}}]) {
    await f.write(stagePath,changed);await assert.rejects(createG1PreviewBundle(f.job,{revision:4}),{code:'PREVIEW_INVALID'});
  }
  await f.write(stagePath,stage);
  for(const changed of [{...state,failed:{code:'MESH_TOPOLOGY_INVALID'}},{...state,pending:{id:'active-operation'}}]) {
    await f.write(statePath,changed);await assert.rejects(createG1PreviewBundle(f.job,{revision:4}),{code:'PREVIEW_INVALID'});
  }
  await f.write(statePath,state);await fs.writeFile(path.join(f.root,base+'/rigging/.build.lock'),'active');
  await assert.rejects(createG1PreviewBundle(f.job,{revision:4}),{code:'PREVIEW_BUSY'});
});

async function largeJournal(f,relative,bytes) {
  const value=JSON.parse(await fs.readFile(path.join(f.root,relative)));
  value.done={operation:{status:'completed',result:{history:''}}};
  value.done.operation.result.history='x'.repeat(bytes-Buffer.byteLength(JSON.stringify(value)));
  await f.write(relative,value);assert.equal((await fs.stat(path.join(f.root,relative))).size,bytes);
  return value;
}

test('G1 reads a real-scale 30289622-byte ancestor journal locally, retaining identity and a bounded size limit',async t=>{
  const f=await failedAncestorFixture(t),relative=f.bases[2]+'/rigging/state.json';
  const journal=await largeJournal(f,relative,30289622),before=await digest(path.join(f.root,relative));
  await assert.rejects(json(f.root,relative),{code:'REFERENCE_INVALID'}); // Generic manifests retain 16 MiB.
  const bundle=await createG1PreviewBundle(f.job,{revision:4});
  assert.equal(bundle.parents.find(p=>p.revision===2).engineJournal.bytes,30289622);
  assert.equal((await g1PreviewSources(f.job)).sources.length,4);
  assert.deepEqual(await digest(path.join(f.root,relative)),before);
  await f.write(relative,{...journal,identity:{...journal.identity,candidateId:'foreign'}});
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_IDENTITY_MISMATCH'});
  const handle=await fs.open(path.join(f.root,relative),'w');
  try{await handle.truncate(64*1024*1024+1);}finally{await handle.close();}
  await assert.rejects(g1PreviewSources(f.job),{code:'PREVIEW_INVALID',message:/64.*MiB/});
});

test('G1 selected large journal keeps failed, pending and invalid JSON rejection',async t=>{
  const f=await fixture(t),relative=f.base+'/rigging/state.json',journal=await largeJournal(f,relative,17*1024*1024);
  await createG1PreviewBundle(f.job);assert.equal((await g1PreviewSources(f.job)).sources.length,4);
  for(const changed of [{...journal,failed:{code:'MESH_TOPOLOGY_INVALID'}},{...journal,pending:{id:'active-operation'}}]) {
    await f.write(relative,changed);await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_INVALID'});
  }
  await fs.writeFile(path.join(f.root,relative),'{');
  await assert.rejects(createG1PreviewBundle(f.job),{code:'PREVIEW_INVALID'});
});

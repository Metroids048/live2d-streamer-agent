import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {singleImageSources} from '../src/pipeline/delivery.mjs';
import {attachmentLimitForRevision, LOCAL_ATTACHMENT_MAX_BYTES} from '../src/packaging/distribution.mjs';
import {makeEditableVolumes} from '../src/packaging/editable-volumes.mjs';

// Publication-boundary fixtures only; actual ZIP extraction is covered by 05.
async function setup(t,cap=1024) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-delivery-boundary-')));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'packaging'));
  const job={id:'task',candidateId:'candidate',revision:2,parentRevision:1,source:{inputSha256:'a'.repeat(64),descriptionSha256:'b'.repeat(64)},artifacts:{packagePath:'packaging/full.zip'}};
  const bundle={schemaVersion:1,stage:'packaging',status:'completed',taskId:job.id,candidateId:job.candidateId,revision:2,parentRevision:1,...job.source,packagePath:job.artifacts.packagePath,unresolved:[],checks:[],deliveryFiles:[]};
  for(const [name,role,size] of [['full.zip','complete-package',cap+1],['runtime.zip','runtime-package',9],['editable.zip','editable-package',10],['cover.png','preview-cover',11],['preview.mp4','preview-video',12]]) {
    const data=Buffer.alloc(size,role.charCodeAt(0)),p='packaging/'+name;await fs.writeFile(path.join(root,p),data);
    bundle.deliveryFiles.push({path:p,role,bytes:data.length,sha256:createHash('sha256').update(data).digest('hex')});
  }
  const save=()=>fs.writeFile(path.join(root,'packaging/stage.json'),JSON.stringify(bundle));await save();
  return {root,job,bundle,save,cap};
}
test('single-image publication selects verified independent subsets without rebuilding the old model',async t=>{
  const f=await setup(t),verified=[];
  const result=await singleImageSources(f.job,f.root,f.cap,{verifyArchive:async(file,a,destination,{identity})=>{verified.push(a.role);assert.equal(identity.revision,2);assert.equal(identity.inputSha256,f.job.source.inputSha256);}});
  assert.deepEqual(verified,['complete-package','runtime-package','editable-package']);
  assert.deepEqual(result.sources.map(s=>s.name),['runtime.zip','editable.zip','cover.png','preview.mp4']);
  assert.equal(result.archive,path.join(f.root,'packaging/full.zip'));await assert.rejects(fs.access(path.join(f.root,'使用与来源.md')));
});
test('another revision or changed delivery bytes never reaches publication',async t=>{
  const f=await setup(t);let calls=0;const deps={verifyArchive:async()=>{calls++;}};
  f.bundle.revision='2';await f.save();await assert.rejects(singleImageSources(f.job,f.root,f.cap,deps),{code:'PACKAGE_IDENTITY_MISMATCH'});
  f.bundle.revision=2;await f.save();await fs.appendFile(path.join(f.root,'packaging/runtime.zip'),'tamper');
  await assert.rejects(singleImageSources(f.job,f.root,f.cap,deps),{code:'INVALID_ARTIFACT'});assert.equal(calls,0);
});
test('refined replay returns the player and complete package when the archive fits',async t=>{
  const f=await setup(t);
  assert.equal(attachmentLimitForRevision(f.job),LOCAL_ATTACHMENT_MAX_BYTES);
  f.job.cachedReplay={refinedArtworkSha256:'c'.repeat(64)};
  const limit=attachmentLimitForRevision(f.job);
  assert.ok(limit>LOCAL_ATTACHMENT_MAX_BYTES);
  const result=await singleImageSources(f.job,f.root,limit,{verifyArchive:async()=>{},preferComplete:true});
  assert.deepEqual(result.sources.map(s=>s.name),['preview.mp4','full.zip']);
});
test('oversized complete package requires both independent subsets',async t=>{
  const f=await setup(t);f.bundle.deliveryFiles=f.bundle.deliveryFiles.filter(a=>a.role!=='editable-package');await f.save();
  await assert.rejects(singleImageSources(f.job,f.root,f.cap),{code:'DELIVERY_TOO_LARGE'});
});
test('a verified service limit lower than the local publisher limit selects only deliverable variants',async t=>{
  const f=await setup(t,128);
  f.bundle.distribution={localMaxBytes:1024,serviceMaxBytes:64};
  await f.save();
  const result=await singleImageSources(f.job,f.root,1024,{verifyArchive:async()=>{}});
  assert.deepEqual(result.sources.map(s=>s.name),['runtime.zip','editable.zip','cover.png','preview.mp4']);
});

test('oversized editable archive publishes all verified volumes or fails closed',async t=>{
  const f=await setup(t,32768),dir=path.join(f.root,'packaging');
  const data=Buffer.alloc(44000,42),name='editable-assets.zip';
  await fs.writeFile(path.join(dir,name),data);
  const editable={role:'editable-package',path:'packaging/'+name,bytes:data.length,
    sha256:createHash('sha256').update(data).digest('hex')};
  const volumes=(await makeEditableVolumes(dir,editable,f.cap)).map(v=>({...v,path:'packaging/'+v.path}));
  assert.equal(volumes.length,2);
  const entries=f.bundle.deliveryFiles.filter(a=>a.role!=='editable-package');
  const deps={verifyArchive:async()=>{}};
  f.bundle.deliveryFiles=[...entries,editable,...volumes];
  await f.save();
  const result=await singleImageSources(f.job,f.root,f.cap,deps);
  assert.deepEqual(result.sources.map(s=>s.artifact.role),
    ['runtime-package','preview-cover','preview-video','editable-volume-001','editable-volume-002']);
  assert.ok(result.volumeGuide.includes(editable.sha256));
  f.bundle.deliveryFiles.pop();
  await f.save();
  await assert.rejects(singleImageSources(f.job,f.root,f.cap,deps),{code:'REFERENCE_INVALID'});
});

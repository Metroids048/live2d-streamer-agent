import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Maker} from '../src/maker.mjs';
import {deliver,deliverStagePreview} from '../src/delivery.mjs';
import {artifact} from '../src/packaging/files.mjs';

// Publication boundaries only: these bytes are fixtures, not visual/model acceptance.
async function fixture(t){
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-g1-publish-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const maker=new Maker(root),id='12345678-1234-1234-1234-123456789abc',ctx={sessionKey:'owner',sessionId:'session'};
  const output=path.join(root,'openclaw-workspace','outputs',id),base='revisions/r0002/g1-preview';
  await fs.mkdir(path.join(output,base),{recursive:true});
  const job={id,kind:'single_image',candidateId:'candidate',revision:1,parentRevision:null,session:maker.store.session(ctx),
    status:'blocked',stage:'rigging',output,steps:[],source:{inputSha256:'input',descriptionSha256:'description'}};
  const identity={taskId:id,candidateId:job.candidateId,revision:2,parentRevision:1,...job.source};
  const roles=['g1-video','g1-cover','g1-full-body','g1-face','g1-artwork-source','g1-render-source'];
  const artifacts=[];
  for(const [i,role]of roles.entries()){
    const file=base+'/'+i+'.bin';await fs.writeFile(path.join(output,file),'fixture-'+i);artifacts.push(await artifact(output,file,role));
  }
  const revision='revisions/r0002',rigDir=path.join(output,revision,'rigging');
  await fs.mkdir(path.join(rigDir,'model'),{recursive:true});
  const files={'candidate.psd2live':'PKfixture','candidate.psd':'8BPSfixture',
    'parameter-map.json':JSON.stringify({...identity,projectId:'project',state:'state-1'}),
    'model/layout.model3.json':JSON.stringify({Version:3,FileReferences:{Moc:'layout.moc3',Textures:['texture.png']}}),
    'model/layout.moc3':'MOC3fixture','model/texture.png':Buffer.from('89504e470d0a1a0a','hex')};
  const rigArtifacts=[];
  for(const [file,bytes] of Object.entries(files)){
    await fs.writeFile(path.join(rigDir,file),bytes);
    const a=await artifact(path.join(output,revision),'rigging/'+file,'rigging_file');rigArtifacts.push(a);
    artifacts.push({...a,path:revision+'/'+a.path,role:file.startsWith('model/')?'g1-model-source':'g1-rig-dependency'});
  }
  await fs.writeFile(path.join(rigDir,'stage.json'),JSON.stringify({schemaVersion:1,stage:'rigging',status:'blocked',...identity,
    engineProjectId:'project',engineRevision:'state-1',projectPath:'rigging/candidate.psd2live',psdPath:'rigging/candidate.psd',
    parameterMapPath:'rigging/parameter-map.json',modelPath:'rigging/model/layout.model3.json',artifacts:rigArtifacts}));
  artifacts.push(await artifact(output,revision+'/rigging/stage.json','g1-rig-source'));
  const bundle={schemaVersion:1,stage:'g1-preview',status:'pending_user_review',...identity,
    engineProjectId:'project',engineRevision:'state-1',artifacts,notice:'G1制作预览；未完成'};
  const manifest=path.join(output,base,'stage.json');await fs.writeFile(manifest,JSON.stringify(bundle));
  await maker.store.write('make-'+id,job);
  let publications=0;
  const save=async(bytes,mime,subdir,cap,name)=>{
    const file=path.join(root,'published-'+(++publications)+'-'+name);await fs.writeFile(file,bytes);return {path:file};
  };
  return {root,maker,id,ctx,job,bundle,manifest,output,save,count:()=>publications};
}
test('G1 explicitly publishes pending preview; final delivery remains blocked and cached receipts are reused',async t=>{
  const f=await fixture(t);
  await assert.rejects(deliver(f.maker,f.id,f.ctx,f.save),{code:'NOT_COMPLETED'});
  const first=await deliverStagePreview(f.maker,f.id,f.ctx,f.save);
  assert.equal(first.status,'blocked');assert.equal(first.revision,2);assert.equal(first.attachments.length,4);assert.equal(f.count(),4);
  const second=await deliverStagePreview(f.maker,f.id,f.ctx,f.save);
  assert.deepEqual(second.attachments,first.attachments);assert.equal(f.count(),4);
  const stored=await f.maker.store.read('make-'+f.id);
  assert.equal(stored.status,'blocked');assert.equal(stored.revision,1);assert.equal(stored.delivery,undefined);
});
test('another conversation cannot publish the pending preview',async t=>{
  const f=await fixture(t);
  await assert.rejects(deliverStagePreview(f.maker,f.id,{sessionKey:'stranger'},f.save),{code:'SESSION_MISMATCH'});
  assert.equal(f.count(),0);
});
test('changed MOC source invalidates preview before any media publication',async t=>{
  const f=await fixture(t),a=f.bundle.artifacts.find(a=>a.role==='g1-model-source');
  await fs.appendFile(path.join(f.output,a.path),'new revision');
  await assert.rejects(deliverStagePreview(f.maker,f.id,f.ctx,f.save),{code:'PREVIEW_CHANGED'});
  assert.equal(f.count(),0);
});
test('a preview from a different parent revision cannot publish',async t=>{
  const f=await fixture(t);f.bundle.parentRevision=0;await fs.writeFile(f.manifest,JSON.stringify(f.bundle));
  await assert.rejects(deliverStagePreview(f.maker,f.id,f.ctx,f.save),{code:'PREVIEW_IDENTITY_MISMATCH'});
  assert.equal(f.count(),0);
});
test('source changed during publication is rejected before its SDK call',async t=>{
  const f=await fixture(t),cover=f.bundle.artifacts.find(a=>a.role==='g1-cover');
  const save=async(...args)=>{
    const result=await f.save(...args);
    if(f.count()===1)await fs.appendFile(path.join(f.output,cover.path),'changed after validation');
    return result;
  };
  await assert.rejects(deliverStagePreview(f.maker,f.id,f.ctx,save),{code:'INVALID_ARTIFACT'});
  assert.equal(f.count(),1);
});

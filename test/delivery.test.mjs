import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {Maker} from '../src/maker.mjs';
import {deliver} from '../src/delivery.mjs';

async function fixture(t) {
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'live2d-delivery-')));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const maker=new Maker(root),id='12345678-1234-1234-1234-123456789abc',ctx={sessionKey:'owner',sessionId:'session'};
  const output=path.join(root,'openclaw-workspace','outputs',id);
  await fs.mkdir(path.join(output,'model'),{recursive:true});await fs.mkdir(path.join(output,'preview'));
  for(const name of ['角色.psd2live','model/model.json','preview/半身制作预览-6秒.mp4','preview/半身预览.png']) await fs.writeFile(path.join(output,name),'test fixture');
  const job={id,session:maker.store.session(ctx),status:'completed',output,source:{sha256:'test hash'},steps:[]};
  await maker.store.write('make-'+id,job);
  let publications=0;
  const save=async(buffer,mime,subdir,max,name)=>{
    const saved=path.join(root,'published-'+(++publications)+'-'+name);await fs.writeFile(saved,buffer);return {path:saved};
  };
  return {root,maker,id,ctx,output,job,save,count:()=>publications};
}
test('another conversation cannot publish a completed job',async t=>{
  const f=await fixture(t);
  await assert.rejects(deliver(f.maker,f.id,{sessionKey:'stranger'},f.save),{code:'SESSION_MISMATCH'});
  assert.equal(f.count(),0);
});
test('job query is read-only and publication reuses identical stored attachments',async t=>{
  const f=await fixture(t),before=await fs.readdir(f.output);
  await f.maker.making(f.id,f.ctx);assert.deepEqual(await fs.readdir(f.output),before);
  const first=await deliver(f.maker,f.id,f.ctx,f.save);
  assert.equal(first.attachments.length,3);assert.equal(f.count(),3);
  const second=await deliver(f.maker,f.id,f.ctx,f.save);
  assert.deepEqual(second.attachments,first.attachments);assert.equal(f.count(),3);
});
test('symlinked artifact is rejected before any attachment is published',async t=>{
  const f=await fixture(t),cover=path.join(f.output,'preview/半身预览.png');
  const external=path.join(f.root,'unrelated.txt');await fs.writeFile(external,'private fixture');
  await fs.unlink(cover);await fs.symlink(external,cover);
  await assert.rejects(deliver(f.maker,f.id,f.ctx,f.save),{code:'INVALID_ARTIFACT'});
  assert.equal(f.count(),0);
});
test('a failed second media save keeps the first receipt private and resumes without saving it twice',async t=>{
  const f=await fixture(t);let saves=0;
  await assert.rejects(deliver(f.maker,f.id,f.ctx,(...args)=>{
    if(++saves===2)throw new Error('media store interrupted');
    return f.save(...args);
  }),/media store interrupted/);
  assert.equal((await f.maker.store.read('make-'+f.id)).delivery,undefined);
  const result=await deliver(f.maker,f.id,f.ctx,f.save);
  assert.equal(result.attachments.length,3);
  assert.equal(f.count(),3);
});
test('a media-store receipt pointing to different bytes cannot publish the candidate',async t=>{
  const f=await fixture(t),other=path.join(f.root,'other.png');
  await fs.writeFile(other,'different candidate');
  await assert.rejects(deliver(f.maker,f.id,f.ctx,async()=>({path:other})),{code:'MEDIA_STORE_MISMATCH'});
  assert.equal((await f.maker.store.read('make-'+f.id)).delivery,undefined);
});

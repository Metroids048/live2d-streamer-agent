import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {ImageInbox,captureSessionImages} from '../src/pipeline/attachments.mjs';

const ctx={agentId:'live2d-streamer',sessionKey:'test-session',sessionId:'test-id'};
async function setup(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'avatar-inbox-')),root=await fs.realpath(dir);
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const task=path.join(root,'output');await fs.mkdir(task);
  return {root,task,inbox:new ImageInbox(root)};
}
const message=bytes=>[{role:'user',content:[{type:'image',mimeType:'image/png',data:Buffer.from(bytes).toString('base64')}]}];
test('same-session repeated resolution reuses identical bytes; changed bytes are refused',async t=>{
  const {inbox,task}=await setup(t),[ref]=await inbox.capture(message('test bytes; decoder is a separate boundary'),ctx);
  const a=await inbox.resolve(ref.imageRef,ctx,task),b=await inbox.resolve(ref.imageRef,ctx,task);
  assert.deepEqual(a,b);
  await fs.writeFile(a.path,'tampered');
  await assert.rejects(inbox.resolve(ref.imageRef,ctx,task),{code:'INPUT_CONFLICT'});
});
test('session isolation, latest-user-only capture, and input symlinks',async t=>{
  const {inbox,task,root}=await setup(t);
  assert.deepEqual(await inbox.capture([...message('old'),{role:'user',content:'followup'}],ctx),[]);
  assert.deepEqual(await inbox.capture(message('old'),{...ctx,agentId:'other'}),[]);
  const [ref]=await inbox.capture(message('source'),ctx);
  await assert.rejects(inbox.resolve(ref.imageRef,{...ctx,sessionId:'other'},task),{code:'SESSION_MISMATCH'});
  const other=path.join(root,'elsewhere');await fs.mkdir(other);await fs.symlink(other,path.join(task,'input'));
  await assert.rejects(inbox.resolve(ref.imageRef,ctx,task),{code:'INPUT_INVALID'});
  assert.deepEqual(await fs.readdir(other),[]);
});
test('existing symlink cannot replace the task input',async t=>{
  const {inbox,task,root}=await setup(t),[ref]=await inbox.capture(message('source'),ctx);
  await fs.mkdir(path.join(task,'input'));const outside=path.join(root,'protected');await fs.writeFile(outside,'source');
  await fs.symlink(outside,path.join(task,'input/source.png'));
  await assert.rejects(inbox.resolve(ref.imageRef,ctx,task),{code:'INPUT_CONFLICT'});
  assert.equal(await fs.readFile(outside,'utf8'),'source');
});
test('native SDK transcript facade receives only trusted session scope and latest user images',async t=>{
  const {inbox}=await setup(t),scope={...ctx,sessionKey:'agent:live2d-streamer:test'};let calls=0;
  const read=async identity=>{calls++;assert.deepEqual(identity,scope);return [
    ...message('old').map(m=>({type:'message',message:m})),
    {type:'message',message:message('current')[0]},
    {type:'message',message:{role:'toolResult',content:message('tool pixels')[0].content}}
  ];};
  const result=await captureSessionImages(inbox,scope,read);
  assert.equal(result.ok,true);assert.equal(result.images.length,1);
  assert.equal(result.images[0].sha256,(await inbox.capture(message('current'),scope))[0].sha256);
  const followup=await captureSessionImages(inbox,scope,async()=>[{type:'message',message:message('old')[0]},{type:'message',message:{role:'user',content:'continue'}}]);
  assert.deepEqual(followup.images,[]);
  assert.equal((await captureSessionImages(inbox,{...scope,agentId:'other'},read)).ok,false);assert.equal(calls,1);
  assert.equal((await captureSessionImages(inbox,scope,async()=>{throw new Error('private transcript path');})).code,'ATTACHMENTS_UNAVAILABLE');
});
test('recapture refuses a replaced cache and preserves its bytes',async t=>{
  const {inbox}=await setup(t),[ref]=await inbox.capture(message('source'),ctx);
  const record=await inbox.store.read(ref.imageRef);await fs.writeFile(record.path,'changed');
  await assert.rejects(inbox.capture(message('source'),ctx),{code:'INPUT_CONFLICT'});
  assert.equal(await fs.readFile(record.path,'utf8'),'changed');
});
test('native string message hydrates only SDK-owned latest user media metadata',async t=>{
  const {inbox,task}=await setup(t),scope={...ctx,sessionKey:'agent:live2d-streamer:native'};
  const source=Buffer.from('native attached pixels'),mediaPath='/media/inbound/native.png';let reads=0;
  const media={
    resolveMediaBufferPath:async(id,subdir)=>{assert.equal(id,'native.png');assert.equal(subdir,'inbound');return mediaPath;},
    readMediaBuffer:async(id,subdir,limit)=>{reads++;assert.equal(limit,16*1024*1024);return {path:mediaPath,buffer:source,size:source.length};}
  };
  const user={role:'user',content:'register the image',MediaPath:mediaPath,MediaPaths:[mediaPath],MediaType:'image/png',MediaTypes:['image/png']};
  const events=[{type:'message',message:user}];
  const result=await captureSessionImages(inbox,scope,async()=>events,media);
  assert.equal(result.ok,true);assert.equal(result.images.length,1);assert.equal(reads,1);
  const saved=await inbox.resolve(result.images[0].imageRef,scope,task);
  assert.deepEqual(await fs.readFile(saved.path),source);
  events.push({type:'message',message:{role:'user',content:mediaPath}});
  assert.deepEqual((await captureSessionImages(inbox,scope,async()=>events,media)).images,[]);
  assert.equal(reads,1);
});
test('native metadata outside SDK media root or mismatched bytes cannot register',async t=>{
  const {inbox}=await setup(t),scope={...ctx,sessionKey:'agent:live2d-streamer:native'};let reads=0;
  const events=[{type:'message',message:{role:'user',content:'image',MediaPath:'/outside/native.png',MediaType:'image/png'}}];
  const media={resolveMediaBufferPath:async()=>'/media/inbound/native.png',readMediaBuffer:async()=>{reads++;return {path:'/other/native.png',buffer:Buffer.from('pixels'),size:6};}};
  assert.equal((await captureSessionImages(inbox,scope,async()=>events,media)).code,'ATTACHMENTS_UNAVAILABLE');assert.equal(reads,0);
  events[0].message.MediaPath='/media/inbound/native.png';
  assert.equal((await captureSessionImages(inbox,scope,async()=>events,media)).code,'ATTACHMENTS_UNAVAILABLE');assert.equal(reads,1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {ImageInbox} from '../src/pipeline/attachments.mjs';
import {prepareInput} from '../src/intake/index.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
const evidence=path.join(project,'evidence/single-image-live2d/01');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

// Calls the real inbox adapter with synthetic SDK-shaped content and sessions.
// This is a local integration test, never a real OpenClaw attachment receipt.
async function setup(t) {
  const root=await fs.mkdtemp(path.join(evidence,'test-integration-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const taskRoot=path.join(root,'candidate');await fs.mkdir(taskRoot);
  const bytes=await fs.readFile(path.join(evidence,'fixtures/geometric.png'));
  const session={agentId:'live2d-streamer',sessionKey:'fixture-current',sessionId:'fixture-1'};
  const inbox=new ImageInbox(root);
  const [ref]=await inbox.capture([{role:'user',content:[{type:'image',data:bytes.toString('base64'),mimeType:'image/png'}]}],session);
  const ctx={root,taskRoot,taskId:'integration-fixture',candidateId:'integration-fixture',revision:'r01',
    resolveImage:(imageRef,identity)=>inbox.resolve(imageRef,session,identity.taskRoot)};
  const request={imageRef:ref.imageRef,description:'几何图用于输入联调，不是人物主案例。',rights:{source:'01 自行绘制的几何 fixture',license:'允许本地测试和修改，不公开分发',allowDerivatives:true,allowRedistribution:false}};
  return {root,taskRoot,bytes,session,inbox,ctx,request};
}

test('real inbox adapter decodes SDK-shaped fixture; declared resolver collisions stay blocked',async t=>{
  const s=await setup(t);
  const first=await prepareInput(s.request,s.ctx);
  assert.equal(first.status,'blocked');assert.equal(first.error.code,'BACKEND_UNAVAILABLE');
  assert.equal(first.inputSha256,sha(s.bytes));assert.equal(first.sourceImage.width,32);
  assert.equal(first.brief,null);assert.equal(first.checks.find(c=>c.name==='full_image_decode_and_normalize').status,'passed');
  const snapshot=await fs.readFile(path.join(s.taskRoot,'intake/stage.json'),'utf8');
  // Explicit error injection keeps this regression independent of 00 fixing wx.
  const again=await prepareInput(s.request,{...s.ctx,resolveImage:async()=>{throw Object.assign(new Error(s.root),{code:'EEXIST'});}});
  assert.equal(again.status,'blocked');assert.equal(again.error.code,'ATTACHMENT_RESOLVER_CONFLICT');
  assert.equal(again.brief,null);assert.equal(again.sourceImage,null);
  assert.equal(await fs.readFile(path.join(s.taskRoot,'intake/stage.json'),'utf8'),snapshot);
  assert.equal(JSON.stringify(again).includes(s.root),false);
});

test('real inbox adapter rejects a different fixture session before any visual call',async t=>{
  const s=await setup(t);let visualCalls=0;
  const rejected=await prepareInput(s.request,{...s.ctx,
    resolveImage:(ref,identity)=>s.inbox.resolve(ref,{...s.session,sessionId:'fixture-2'},identity.taskRoot),
    describeImage:async()=>{visualCalls++;throw new Error('must not reach vision');}});
  assert.equal(rejected.status,'needs_input');assert.equal(rejected.error.code,'SESSION_MISMATCH');
  assert.equal(visualCalls,0);assert.equal(rejected.brief,null);
});

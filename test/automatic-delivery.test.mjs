import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Store} from '../src/store.mjs';
import {deliver} from '../src/delivery.mjs';
import {notifyAutomaticDelivery} from '../src/pipeline/automatic-delivery.mjs';

test('automatic result message keeps the originating session, waits for the worker and records idempotency',async t=>{
  const root=await mkdtemp(path.join(tmpdir(),'live2d-delivery-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=new Store(root),maker={store};
  const id='f522cfe3-c1e8-4369-a92a-89150fbf620d';
  const sessionContext={sessionKey:'agent:live2d-streamer:dashboard:test',sessionId:'original-session'};
  const job={id,kind:'single_image',sessionContext,session:store.session(sessionContext),revision:1,
    notifyAutomatically:true,stage:'artwork',status:'blocked',error:{code:'INCOMPLETE',message:'缺少眼部素材'}};
  const sent=[];
  const options={append:async message=>{sent.push(message);return {ok:true};}};
  for(const patch of [{pid:process.pid},{session:'different'},{notifyAutomatically:false},{}]){
    await store.write('make-'+id,{...job,...patch});
    await notifyAutomaticDelivery(maker,id,options);
  }
  await notifyAutomaticDelivery(maker,id,options);
  assert.equal(sent.length,1);
  assert.equal(sent[0].sessionId,sessionContext.sessionId);
  assert.equal(sent[0].sessionKey,sessionContext.sessionKey);
  assert.match(sent[0].text,/拆层和补绘.*缺少眼部素材/u);
  assert.equal((await store.read('automatic-notice-'+id)).status,'visible_message_saved');
  await store.write('make-'+id,{...job,revision:2});
  await notifyAutomaticDelivery(maker,id,{append:async()=>({ok:false,code:'session-rebound'})});
  assert.equal((await store.read('automatic-notice-'+id)).status,'session_rebound');
});

test('the owning conversation gets the observed visual hold without publishing candidate media',async t=>{
  const root=await realpath(await mkdtemp(path.join(tmpdir(),'live2d-held-')));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const id='f522cfe3-c1e8-4369-a92a-89150fbf620d',candidateId='candidate';
  const output=path.join(root,'openclaw-workspace','outputs',id);
  await mkdir(output,{recursive:true});
  const store=new Store(root),maker={root,store,making:async()=>{}};
  const sessionContext={sessionKey:'agent:live2d-streamer:dashboard:test',sessionId:'original-session'};
  const job={id,candidateId,kind:'single_image',sessionContext,session:store.session(sessionContext),revision:1,
    notifyAutomatically:true,stage:'packaging',status:'completed',output};
  await store.write('make-'+id,job);
  await store.write('delivery-hold-'+id,{taskId:id,candidateId,revision:1,reason:'肩前仍有露边'});
  const saveMediaBuffer=async()=>assert.fail('held candidate must never publish');
  await assert.rejects(deliver(maker,id,sessionContext,saveMediaBuffer),{code:'DELIVERY_VISUAL_HOLD'});
  const sent=[];
  const options={saveMediaBuffer,append:async message=>{sent.push(message);return {ok:true};}};
  await store.write('delivery-hold-'+id,{taskId:id,candidateId,revision:1,pending:true,reason:'等候整角原速复核'});
  await assert.rejects(deliver(maker,id,sessionContext,saveMediaBuffer),{code:'DELIVERY_VISUAL_PENDING'});
  await notifyAutomaticDelivery(maker,id,options);
  assert.equal(sent.length,0);
  assert.equal(await store.read('automatic-notice-'+id),null);
  await store.write('delivery-hold-'+id,{taskId:id,candidateId,revision:1,reason:'肩前仍有露边'});
  await notifyAutomaticDelivery(maker,id,options);
  await notifyAutomaticDelivery(maker,id,options);
  assert.equal(sent.length,1);
  assert.match(sent[0].text,/视觉复核未通过.*肩前仍有露边/u);
  assert.doesNotMatch(sent[0].text,/MEDIA:/);
});

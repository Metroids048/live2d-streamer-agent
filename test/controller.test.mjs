import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Controller} from '../src/controller.mjs';
import {Fault,Rpc} from '../src/rpc.mjs';
import {inspectModel} from '../src/model.mjs';

// 模拟边界用于验证状态不变量，不是 VTS、动作或直播验收证据。
async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'live2d-test-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.mkdir(path.join(root,'config'));
  const modelFile=path.join(root,'role.model3.json');
  await fs.writeFile(modelFile,JSON.stringify({FileReferences:{Moc:'role.moc3',Textures:['tex.png'],Expressions:[{File:'smile.exp3.json'},{File:'sad.exp3.json'}]}}));
  await fs.writeFile(path.join(root,'role.moc3'),'MOC3test');
  await fs.writeFile(path.join(root,'tex.png'),Buffer.from([137,80,78,71,13,10,26,10,0]));
  for(const name of ['smile','sad']) await fs.writeFile(path.join(root,name+'.exp3.json'),'{}');
  const config={projectId:'test',vtsUrl:'ws://127.0.0.1:8001',obsUrl:'ws://127.0.0.1:4455',sceneName:'test-scene',captureName:'test-window',modelRoot:root,approvedModels:[{modelID:'role',modelFile,source:'official-test-fixture',licenseReviewed:true}]};
  await fs.writeFile(path.join(root,'config/project.json'),JSON.stringify(config));
  const state={modelID:'role',expressions:{'smile.exp3.json':false,'sad.exp3.json':true},calls:[],disconnect:false,auth:true,wrongReadback:false};
  const rpcFactory=(url,kind)=>({
    async open(){},close(){},async identifyObs(){},
    async request(type,p={}) {
      state.calls.push([type,p]);
      if(type==='AuthenticationRequest') return {authenticated:state.auth};
      if(type==='AuthenticationTokenRequest') throw new Fault('VTS_API_ERROR','授权被拒',{errorId:50});
      if(type==='CurrentModelRequest') return {modelLoaded:true,modelID:state.modelID,modelName:'Role'};
      if(type==='AvailableModelsRequest') return {availableModels:[{modelID:'role'}]};
      if(type==='ModelLoadRequest'){state.modelID=p.modelID;return {};}
      if(type==='ExpressionStateRequest') return {modelLoaded:true,modelID:state.modelID,expressions:Object.entries(state.expressions).map(([file,active])=>({file,active,name:file}))};
      if(type==='ExpressionActivationRequest') {
        if(!state.wrongReadback) state.expressions[p.expressionFile]=p.active;
        if(state.disconnect){state.disconnect=false;throw new Fault('OUTCOME_UNKNOWN','断连');}
        return {};
      }
      if(type==='HotkeysInCurrentModelRequest') return {availableHotkeys:[]};
      if(kind==='obs') return type==='GetSceneList'?{scenes:[]}:{outputActive:false};
      throw new Error('unexpected request '+type);
    }
  });
  const c=new Controller(root,{rpcFactory});
  const ctx={sessionKey:'conversation-a',sessionId:'epoch-a',callId:'1'};
  async function ready(){await c.store.write('vts-token',{authenticationToken:'test-only'});await c.store.write('binding',{modelID:'role'});}
  return {root,c,state,ctx,ready,modelFile,config};
}

test('只读查询不授权、不切模型，也不创建状态目录',async t=>{
  const {root,c,state}=await fixture(t);
  const r=await c.run('status');
  assert.equal(r.vts.code,'AUTH_REQUIRED');
  assert.equal(state.calls.some(([x])=>/Token|Load|Activation|Create|Set/.test(x)),false);
  await assert.rejects(fs.stat(path.join(root,'.local')),{code:'ENOENT'});
});
test('缺失纹理和目录外引用具体报错，不能载入',async t=>{
  const {c,modelFile,root,ctx,state,ready}=await fixture(t);await ready();
  await fs.unlink(path.join(root,'tex.png'));
  const inspection=await inspectModel(modelFile);
  assert.equal(inspection.errors[0].file,'tex.png');
  assert.equal((await c.run('load',{model_id:'role'},ctx)).code,'INVALID_MODEL');
  assert.equal(state.calls.some(([x])=>x==='ModelLoadRequest'),false);
  await fs.writeFile(modelFile,JSON.stringify({FileReferences:{Moc:'../outside.moc3',Textures:'bad'}}));
  assert.equal((await inspectModel(modelFile)).errors[0].code,'INVALID_FILE_REFERENCES');
  await fs.writeFile(path.join(root,'tex.png'),Buffer.from([137,80,78,71,13,10,26,10]));
  await fs.mkdir(path.join(root,'nested'));
  const nested=path.join(root,'nested/escaped.model3.json');
  await fs.symlink(path.join(root,'tex.png'),path.join(root,'nested/texture.png'));
  await fs.writeFile(nested,JSON.stringify({FileReferences:{Moc:'../role.moc3',Textures:['texture.png']}}));
  const escaped=await inspectModel(nested);
  assert.equal(escaped.errors.length,2);
  assert.ok(escaped.errors.every(e=>e.code==='REFERENCE_OUTSIDE_MODEL'));
  await fs.writeFile(nested,JSON.stringify({FileReferences:{Moc:'x',Textures:[],Expressions:[null]}}));
  assert.equal((await inspectModel(nested)).errors[0].code,'INVALID_FILE_REFERENCES');
});
test('首次授权拒绝只请求一次，不盲重试',async t=>{
  const {c,state,ctx}=await fixture(t);
  assert.equal((await c.run('connect',{},ctx)).code,'VTS_API_ERROR');
  assert.equal(state.calls.filter(([x])=>x==='AuthenticationTokenRequest').length,1);
  assert.equal(await c.store.read('vts-token'),null);
});
test('表情基线跨进程保留，复位恢复原来已开启的表情',async t=>{
  const {c,root,state,ctx,ready}=await fixture(t);await ready();
  assert.equal((await c.run('expression',{expression_file:'smile.exp3.json',active:true},ctx)).ok,true);
  const reopened=new Controller(root,{rpcFactory:c.rpcFactory});
  assert.equal((await reopened.run('restore',{}, {...ctx,callId:'2'})).restored,true);
  assert.deepEqual(state.expressions,{'smile.exp3.json':false,'sad.exp3.json':true});
  assert.equal((await c.store.read('control')).baseline,undefined);
});
test('原型键不是实际表情，不能触发',async t=>{
  const {c,state,ctx,ready}=await fixture(t);await ready();
  assert.equal((await c.run('expression',{expression_file:'toString',active:true},ctx)).code,'UNKNOWN_EXPRESSION');
  assert.equal(state.calls.some(([x])=>x==='ExpressionActivationRequest'),false);
});
test('换会话、新会话 epoch 和换角色不覆盖基线',async t=>{
  const {c,state,ctx,ready}=await fixture(t);await ready();
  await c.run('expression',{expression_file:'smile.exp3.json',active:true},ctx);
  for(const other of [{sessionKey:'other'},{sessionId:'epoch-b'}]) assert.equal((await c.run('restore',{}, {...ctx,...other,callId:'2'})).code,'SESSION_BUSY');
  state.modelID='other';
  assert.equal((await c.run('restore',{}, {...ctx,callId:'3'})).code,'MODEL_MISMATCH');
});
test('断连后相同调用只回读，不重复触发表情；随后可以恢复',async t=>{
  const {c,state,ctx,ready}=await fixture(t);await ready();state.disconnect=true;
  const p={expression_file:'smile.exp3.json',active:true};
  assert.equal((await c.run('expression',p,ctx)).code,'OUTCOME_UNKNOWN');
  const count=state.calls.filter(([x])=>x==='ExpressionActivationRequest').length;
  assert.equal((await c.run('expression',p,ctx)).reconciled,true);
  assert.equal(state.calls.filter(([x])=>x==='ExpressionActivationRequest').length,count);
  assert.equal((await c.run('restore',{}, {...ctx,callId:'2'})).ok,true);
});
test('回读不一致保留恢复记录，不能声称切换成功',async t=>{
  const {c,state,ctx,ready}=await fixture(t);await ready();state.wrongReadback=true;
  assert.equal((await c.run('expression',{expression_file:'smile.exp3.json',active:true},ctx)).code,'READBACK_FAILED');
  assert.ok((await c.store.read('control')).pending);
});
test('加载响应丢失后，确认实际已加载并绑定，不重复加载',async t=>{
  const {c,state,ctx,ready}=await fixture(t);await ready();
  await c.store.write('control',{pending:{kind:'load',modelID:'role',session:c.store.session(ctx),callId:'old'}});
  assert.equal((await c.run('load',{model_id:'role'},ctx)).ok,true);
  assert.equal(state.calls.some(([x])=>x==='ModelLoadRequest'),false);
});
test('禁止远程控制地址',()=>{
  assert.throws(()=>new Rpc('ws://example.com:8001','vts'),{code:'LOCAL_ONLY'});
});
test('WebSocket 关闭时等待中的请求标记结果未知',async()=>{
  class Socket extends EventTarget {
    readyState=1;
    constructor(){super();queueMicrotask(()=>this.dispatchEvent(new Event('open')));}
    send(){queueMicrotask(()=>this.dispatchEvent(new Event('close')));}
    close(){}
  }
  const rpc=new Rpc('ws://127.0.0.1:8001','vts',{WebSocketClass:Socket,timeout:100});
  await rpc.open();
  await assert.rejects(rpc.request('ExpressionActivationRequest'),{code:'OUTCOME_UNKNOWN'});
  assert.equal(rpc.pending.size,0);
});

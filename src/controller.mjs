import * as fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Rpc, Fault, fail} from './rpc.mjs';
import {Store} from './store.mjs';
import {inspectModel, findModels} from './model.mjs';

export const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const identity={pluginName:'Live2D Streamer Agent',pluginDeveloper:'Local Creator'};
const states = data => Object.fromEntries(data.expressions.map(e=>[e.file,e.active]));
const equal = (a,b) => Object.keys(a).length===Object.keys(b).length && Object.entries(a).every(([k,v])=>b[k]===v);
const safeError = e => ({ok:false,code:e.code??'INTERNAL_ERROR',message:e instanceof Fault?e.message:'本机控制失败，请检查本地配置与应用状态',...e.details});

export class Controller {
  constructor(root=ROOT, {rpcFactory=(...args)=>new Rpc(...args)}={}) {
    this.root=root; this.store=new Store(root); this.rpcFactory=rpcFactory;
  }
  async config() {
    const config=JSON.parse(await fs.readFile(path.join(this.root,'config/project.json'),'utf8'));
    if(config.modelRoot)config.modelRoot=path.resolve(this.root,config.modelRoot);
    return config;
  }
  async vts(c,authorize=false) {
    const rpc=this.rpcFactory(c.vtsUrl,'vts');
    try {
      await rpc.open(); let token=await this.store.read('vts-token');
      if(!token) {
        if(!authorize) fail('AUTH_REQUIRED','请在 VTS 开启 API，再请求一次连接授权；查询不会弹出授权窗口');
        token=await rpc.request('AuthenticationTokenRequest',identity,60000);
        if(!token.authenticationToken) fail('AUTH_DENIED','VTS 授权未完成');
        await this.store.write('vts-token',token);
      }
      const auth=await rpc.request('AuthenticationRequest',{...identity,authenticationToken:token.authenticationToken});
      if(!auth.authenticated) fail('AUTH_DENIED','VTS 未授权此插件，请在 VTS 检查权限；不会自动反复申请');
      return rpc;
    } catch(e) {rpc.close();throw e;}
  }
  async obs(c) {
    const rpc=this.rpcFactory(c.obsUrl,'obs');
    try {
      await rpc.open();
      let password;try {password=await fs.readFile(path.join(this.store.dir,'obs-password'),'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
      await rpc.identifyObs(password?.trim()); return rpc;
    } catch(e){rpc.close();throw e;}
  }
  async using(kind,c,fn) {const rpc=await this[kind](c);try{return await fn(rpc);}finally{rpc.close();}}
  async snapshot(rpc) {
    const data=await rpc.request('ExpressionStateRequest',{details:true});
    if(!data.modelLoaded) fail('NO_MODEL','VTS 当前没有已加载角色');
    return data;
  }
  async bound(rpc,binding) {
    const s=await this.snapshot(rpc);
    if(!binding || s.modelID!==binding.modelID) fail('MODEL_MISMATCH','当前角色与本项目绑定角色不一致，请明确加载所选角色',{currentModelID:s.modelID,boundModelID:binding?.modelID??null});
    return s;
  }
  async status(c) {
    const probe=async(fn)=>{try{return {ok:true,...await fn()};}catch(e){return safeError(e);}};
    const [vts,obs]=await Promise.all([
      probe(()=>this.using('vts',c,async rpc=>({current:await rpc.request('CurrentModelRequest'),models:await rpc.request('AvailableModelsRequest')}))),
      probe(()=>this.using('obs',c,async rpc=>({version:await rpc.request('GetVersion'),scene:await rpc.request('GetSceneList'),stream:await rpc.request('GetStreamStatus'),record:await rpc.request('GetRecordStatus'),virtualCamera:await rpc.request('GetVirtualCamStatus')})))
    ]);
    const control=await this.store.read('control',{});
    return {ok:true,projectId:c.projectId,vts,obs,binding:await this.store.read('binding'),control:{hasBaseline:!!control.baseline,pending:control.pending??null},bilibili:c.bilibili,acceptance:{motion:'not_verified',microphone:'not_verified',bilibiliPreview:'not_verified',userAccepted:false}};
  }
  async inspect(c) {
    const files=await findModels(c.modelRoot);
    return {ok:true,modelRoot:c.modelRoot,models:await Promise.all(files.map(inspectModel)),approvedModels:c.approvedModels};
  }
  async load(c,p,session,callId) {
    const approved=c.approvedModels.find(m=>m.modelID===p.model_id);
    if(!approved?.source || !approved?.licenseReviewed || !approved.modelFile) fail('MODEL_NOT_APPROVED','所选角色尚未记录官方来源、许可核查和实际模型文件');
    const check=await inspectModel(approved.modelFile);
    if(!check.ok) fail('INVALID_MODEL','运行模型文件不完整',{inspection:check});
    const control=await this.store.read('control',{});
    if(control.baseline) fail('RESET_FIRST','还有未恢复的表情状态，请在原会话恢复后再加载角色');
    return this.using('vts',c,async rpc=>{
      const before=await rpc.request('CurrentModelRequest');
      if(control.pending && !(control.pending.kind==='load' && control.pending.session===session && control.pending.modelID===p.model_id && before.modelLoaded && before.modelID===p.model_id)) fail('OUTCOME_UNKNOWN','上次加载结果未知；已回读实际状态，不重复加载',{pending:control.pending,current:before});
      if(!before.modelLoaded || before.modelID!==p.model_id) {
        await this.store.write('control',{pending:{kind:'load',modelID:p.model_id,session,callId}});
        await rpc.request('ModelLoadRequest',{modelID:p.model_id});
      }
      const after=await rpc.request('CurrentModelRequest');
      if(!after.modelLoaded || after.modelID!==p.model_id) fail('READBACK_FAILED','VTS 尚未回读到所选角色，请先查询，不重复加载');
      const binding={projectId:c.projectId,modelID:after.modelID,modelName:after.modelName,modelFile:approved.modelFile,source:approved.source,license:approved.license,selectedBy:session};
      await this.store.write('binding',binding); await this.store.write('control',{});
      return {ok:true,binding,current:after,inspection:check};
    });
  }
  async expressions(c) {
    return this.using('vts',c,async rpc=>{
      const current=await this.bound(rpc,await this.store.read('binding'));
      return {ok:true,...current,hotkeys:await rpc.request('HotkeysInCurrentModelRequest')};
    });
  }
  async expression(c,p,session,callId,restore=false) {
    const control=await this.store.read('control',{});
    if(control.baseline && control.owner!==session) fail('SESSION_BUSY','原会话尚未恢复表情，本会话不能覆盖其基线');
    return this.using('vts',c,async rpc=>{
      const current=await this.bound(rpc,await this.store.read('binding')); const actual=states(current);
      if(control.modelID && control.modelID!==current.modelID) fail('MODEL_MISMATCH','恢复记录属于另一个角色，不执行切换');
      if(restore && !control.baseline) return {ok:true,changed:false,message:'当前会话没有需要恢复的表情',current};
      if(!restore && !Object.hasOwn(actual,p.expression_file)) fail('UNKNOWN_EXPRESSION','该表情不属于当前角色',{available:Object.keys(actual)});
      // 每次都先回读。结果未知时只确认原操作，不盲目再次发送。
      if(control.pending && !restore) {
        if(equal(actual,control.pending.desired)) {
          const completed={...control,pending:null,lastCallId:control.pending.callId}; await this.store.write('control',completed);
          if(callId===control.pending.callId) return {ok:true,reconciled:true,current};
        } else fail('OUTCOME_UNKNOWN','上次切换未完整确认；当前状态已回读，请先恢复原状态',{current,pending:control.pending});
      }
      if(!restore && control.lastCallId===callId) return {ok:true,replayed:true,current};
      const desired=restore?control.baseline:{...actual,[p.expression_file]:p.active};
      if(!equal(Object.fromEntries(Object.keys(desired).map(k=>[k,false])),Object.fromEntries(Object.keys(actual).map(k=>[k,false])))) fail('CONTROLS_CHANGED','表情文件发生变化，原恢复记录已失效，请在 VTS 手动核对');
      const journal={...control,owner:session,modelID:current.modelID,baseline:control.baseline??actual,pending:{kind:restore?'restore':'expression',desired,callId}};
      await this.store.write('control',journal);
      for(const [file,active] of Object.entries(desired)) if(actual[file]!==active) await rpc.request('ExpressionActivationRequest',{expressionFile:file,active,fadeTime:0});
      const after=await this.bound(rpc,await this.store.read('binding'));
      if(!equal(states(after),desired)) fail('READBACK_FAILED','表情回读与目标状态不一致，请先查询并恢复',{current:after});
      await this.store.write('control',restore?{}:{...journal,pending:null,lastCallId:callId});
      return {ok:true,restored:restore,current:after};
    });
  }
  async prepareObs(c) {
    return this.using('obs',c,async rpc=>{
      const stream=await rpc.request('GetStreamStatus'), record=await rpc.request('GetRecordStatus'), cam=await rpc.request('GetVirtualCamStatus');
      if(stream.outputActive||record.outputActive||cam.outputActive) fail('OBS_BUSY','OBS 正在输出；请结束本项目外的输出后准备场景');
      const list=await rpc.request('GetSceneList');
      const owner=await this.store.read('obs-owner');
      if(!owner) {
        const existing=await rpc.request('GetInputList');
        if(list.scenes.some(s=>s.sceneName===c.sceneName)||existing.inputs.some(i=>i.inputName===c.captureName)) fail('SOURCE_CONFLICT','项目名称已被现有 OBS 场景或源使用，请先核对归属');
        await this.store.write('obs-owner',{projectId:c.projectId,sceneName:c.sceneName,captureName:c.captureName});
      } else if(owner.projectId!==c.projectId||owner.sceneName!==c.sceneName||owner.captureName!==c.captureName) fail('SOURCE_CONFLICT','OBS 资源绑定与本项目配置不一致');
      if(!list.scenes.some(s=>s.sceneName===c.sceneName)) await rpc.request('CreateScene',{sceneName:c.sceneName});
      const inputs=await rpc.request('GetInputList');
      let input=inputs.inputs.find(i=>i.inputName===c.captureName);
      if(!input) {
        const kinds=await rpc.request('GetInputKindList',{unversioned:true});
        if(!kinds.inputKinds.includes('screen_capture')) fail('CAPTURE_UNSUPPORTED','此 OBS 未提供 macOS 屏幕捕获源');
        // 禁用创建，且 type=窗口。授权/选择窗口前不捕获整个桌面。
        await rpc.request('CreateInput',{sceneName:c.sceneName,inputName:c.captureName,inputKind:'screen_capture',inputSettings:{type:1,window:0,show_cursor:false},sceneItemEnabled:false});
      }
      const settings=await rpc.request('GetInputSettings',{inputName:c.captureName});
      if(settings.inputKind!=='screen_capture') fail('SOURCE_CONFLICT','同名源并非本项目窗口捕获源，请先核对');
      const items=await rpc.request('GetSceneItemList',{sceneName:c.sceneName});
      if(items.sceneItems.some(i=>i.sourceName!==c.captureName)) fail('SCENE_CONFLICT','项目场景含其他来源，不自动修改，请核对');
      let item=items.sceneItems.find(i=>i.sourceName===c.captureName);
      if(!item) item=await rpc.request('CreateSceneItem',{sceneName:c.sceneName,sourceName:c.captureName,sceneItemEnabled:false});
      const windows=await rpc.request('GetInputPropertiesListPropertyItems',{inputName:c.captureName,propertyName:'window'});
      const choices=windows.propertyItems.filter(i=>i.itemEnabled && /VTube Studio/i.test(i.itemName));
      if(choices.length!==1) fail('VTS_WINDOW_REQUIRED','请开启一个 VTS 窗口并在系统设置允许 OBS 窗口捕获',{matchingWindows:choices.length,sceneName:c.sceneName});
      await rpc.request('SetInputSettings',{inputName:c.captureName,inputSettings:{type:1,window:choices[0].itemValue,show_cursor:false},overlay:true});
      const video=await rpc.request('GetVideoSettings');
      await rpc.request('SetSceneItemTransform',{sceneName:c.sceneName,sceneItemId:item.sceneItemId,sceneItemTransform:{positionX:0,positionY:0,boundsType:'OBS_BOUNDS_SCALE_INNER',boundsWidth:video.baseWidth,boundsHeight:video.baseHeight,boundsAlignment:0}});
      await rpc.request('SetSceneItemEnabled',{sceneName:c.sceneName,sceneItemId:item.sceneItemId,sceneItemEnabled:true});
      await rpc.request('SetCurrentProgramScene',{sceneName:c.sceneName});
      return {ok:true,scene:await rpc.request('GetSceneItemList',{sceneName:c.sceneName}),capture:await rpc.request('GetInputSettings',{inputName:c.captureName}),note:'窗口源已准备；仍需实看边缘、半身构图、麦克风及 B站预览。不会启动直播。'};
    });
  }
  async run(action,p={},ctx={}) {
    try {
      const c=await this.config();
      if(action==='status') return await this.status(c);
      if(action==='inspect') return await this.inspect(c);
      if(action==='expressions') return await this.expressions(c);
      const session=this.store.session(ctx),callId=ctx.callId;
      if(!callId) fail('CALL_ID_REQUIRED','控制操作需要宿主调用标识');
      return await this.store.lock(async()=>{
        if(action==='connect') {const rpc=await this.vts(c,true);try{return {ok:true,current:await rpc.request('CurrentModelRequest')};}finally{rpc.close();}}
        if(action==='load') return this.load(c,p,session,callId);
        if(action==='expression') {if(typeof p.active!=='boolean'||typeof p.expression_file!=='string') fail('INVALID_INPUT','请指定实际表情文件及 active 布尔值');return this.expression(c,p,session,callId);}
        if(action==='restore') return this.expression(c,p,session,callId,true);
        if(action==='prepare_obs') return this.prepareObs(c);
        fail('UNKNOWN_ACTION','未知控制操作');
      });
    } catch(e) {return safeError(e);}
  }
}

import {Fault} from '../rpc.mjs';

const fields=['sessionKey','sessionId','modelId','modelSha256'];
function sameIdentity(state,identity) {
  if(fields.some(k=>typeof identity?.[k]!=='string'||!identity[k]||identity[k]!==state.identity[k]))
    throw new Fault('CONTROL_IDENTITY_MISMATCH','拒绝把旧会话/旧模型基线用于当前模型');
}
const resource=(type,r)=>({type,id:r.id,token:r.token});
const owned=s=>[...(s.activeExpression?[resource('expression',s.activeExpression)]:[]),...(s.activeMotion?[resource('motion',s.activeMotion)]:[]),
  ...Object.values(s.activeAppearances??{}).map(r=>resource('expression',r))];

// Private controller state; never add session keys or baselines to the public resource manifest.
// These commands are adapter-neutral plans, not a claim that Leaf exposes such an API.
export function createControlState(manifest,identity,snapshot,capabilities) {
  if(!capabilities?.readState||!capabilities?.scopedResourceRelease)throw new Fault('RUNTIME_UNSUPPORTED','运行器不能读取原状态或仅释放本owner资源，无法精准复位');
  if(fields.some(k=>typeof identity?.[k]!=='string'||!identity[k])||!Array.isArray(snapshot?.activeExpressions)||!Array.isArray(snapshot?.activeMotions)||
    [...snapshot.activeExpressions,...snapshot.activeMotions].some(id=>typeof id!=='string'||!id))
    throw new Fault('CONTROL_BASELINE_REQUIRED','缺少完整会话/模型身份或原生状态');
  return {schemaVersion:1,identity:structuredClone(identity),baseline:structuredClone(snapshot),
    resources:{expressions:structuredClone(manifest.expressions),motions:structuredClone(manifest.motions)},
    phase:'ready',activeExpression:null,activeMotion:null,activeAppearances:{},pending:null,knownTokens:[],operationIds:[]};
}

export function planControl(state,event,identity) {
  sameIdentity(state,identity);
  const s=structuredClone(state);
  if(event.type==='disconnect') {s.phase='needs_reconcile';return s;}
  if(s.phase!=='ready'||s.pending)throw new Fault('CONTROL_RECONCILE_REQUIRED','先核对原操作与当前owner资源，不重复发送未知结果操作');
  if(typeof event.operationId!=='string'||!event.operationId||s.operationIds.includes(event.operationId))
    throw new Fault('CONTROL_OPERATION_INVALID','需要未使用的操作ID');
  const commands=[],after={activeExpression:s.activeExpression,activeMotion:s.activeMotion,activeAppearances:{...s.activeAppearances}};
  const release=type=>{
    const key=type==='expression'?'activeExpression':'activeMotion',r=after[key];
    if(r)commands.push({type:'release_'+type,id:r.id,token:r.token});after[key]=null;
  };
  const releaseAppearance=group=>{
    const r=after.activeAppearances[group];
    if(r)commands.push({type:'release_expression',id:r.id,token:r.token});
    delete after.activeAppearances[group];
  };
  if(['expression','appearance','motion'].includes(event.type)) {
    const type=event.type==='motion'?'motion':'expression',list=type==='expression'?s.resources.expressions:s.resources.motions;
    if(typeof event.id!=='string'||!list.some(r=>r.id===event.id))throw new Fault('CONTROL_RESOURCE_INVALID','资源不存在或互斥表情被组合提交');
    const selected=list.find(r=>r.id===event.id);
    const group=selected.exclusiveGroup;
    const appearance=type==='expression'&&group?.startsWith('appearance.');
    if(event.type==='appearance'&&(!appearance||typeof event.enabled!=='boolean'))throw new Fault('CONTROL_RESOURCE_INVALID','请指定已绑定外观及开关状态');
    if((type==='expression'?s.baseline.activeExpressions:s.baseline.activeMotions).includes(event.id))
      throw new Fault('CONTROL_RESOURCE_INVALID','资源已由用户启用，不能冒充本次owner资源');
    if(type==='expression'&&selected.exclusiveGroup&&list.some(r=>r.exclusiveGroup===selected.exclusiveGroup&&s.baseline.activeExpressions.includes(r.id)))
      throw new Fault('CONTROL_RESOURCE_CONFLICT','同组表情已由用户启用，不能将其关闭或与之叠加');
    if(event.type==='appearance'&&event.enabled===false) {
      if(after.activeAppearances[group]?.id===event.id)releaseAppearance(group);
    } else if(!appearance||after.activeAppearances[group]?.id!==event.id) {
      if(appearance)releaseAppearance(group);else release(type);
      const token=event.operationId+':'+type;
      commands.push({type:'activate_'+type,id:event.id,token});s.knownTokens.push(token);
      if(appearance)after.activeAppearances[group]={id:event.id,token};
      else after[type==='expression'?'activeExpression':'activeMotion']={id:event.id,token};
    }
  } else if(event.type==='cancel_motion')release('motion');
  else if(event.type==='reset_expression')release('expression');
  else if(event.type==='restore') {release('motion');release('expression');for(const group of Object.keys(after.activeAppearances))releaseAppearance(group);}
  else throw new Fault('CONTROL_EVENT_INVALID','不支持的控制事件');
  s.operationIds.push(event.operationId);s.pending={operationId:event.operationId,commands,after};s.phase='pending';return s;
}

export function confirmControlPlan(state,result) {
  if(!state.pending||state.pending.operationId!==result.operationId)throw new Fault('CONTROL_OPERATION_INVALID','回执不属于当前操作');
  const s=structuredClone(state);
  if(result.status==='applied') {Object.assign(s,s.pending.after);s.pending=null;s.phase='ready';}
  // Even a partial failure may have changed the host. Always query, never assume rollback.
  else if(['unknown','failed'].includes(result.status))s.phase='needs_reconcile';
  else throw new Fault('CONTROL_OPERATION_INVALID','不支持的操作回执');
  return s;
}

export function reconcileControl(state,identity,observation) {
  sameIdentity(state,identity);
  const s=structuredClone(state),seen=observation?.owned;
  if(s.pending&&observation?.pendingOperationSettled!==true)throw new Fault('CONTROL_RECONCILE_REQUIRED','原操作仍可能迟到，先确认其终态再复位');
  if(!Array.isArray(seen)||seen.some(r=>!['expression','motion'].includes(r.type)||!s.knownTokens.includes(r.token)||
    !(r.type==='expression'?s.resources.expressions:s.resources.motions).some(v=>v.id===r.id)))
    throw new Fault('CONTROL_RESOURCE_INVALID','查询必须只返回本owner已登记token对应的原生资源');
  const expected=new Map([...owned(s),...(s.pending?owned(s.pending.after):[])].map(r=>[r.token,r]));
  if(seen.some(r=>!expected.has(r.token)||expected.get(r.token).id!==r.id||expected.get(r.token).type!==r.type))
    throw new Fault('CONTROL_RESOURCE_INVALID','资源token与原操作绑定不符');
  const group=r=>r.type==='motion'?'motion':s.resources.expressions.find(e=>e.id===r.id)?.exclusiveGroup??'emotion';
  if(new Set(seen.map(group)).size!==seen.length)throw new Fault('CONTROL_RESOURCE_INVALID','同组返回了多个互斥资源');
  s.activeExpression=seen.find(r=>r.type==='expression'&&!group(r).startsWith('appearance.'))??null;
  s.activeAppearances=Object.fromEntries(seen.filter(r=>r.type==='expression'&&group(r).startsWith('appearance.')).map(r=>[group(r),r]));
  s.activeMotion=seen.find(r=>r.type==='motion')??null;
  s.pending=null;s.phase='ready';return s;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {createControlState, planControl, confirmControlPlan, reconcileControl} from '../src/dynamics/control.mjs';

// Pure state fixture: no Leaf/VTS call or actual parameter/visual acceptance.
const identity={sessionKey:'fixture-key',sessionId:'fixture-session',modelId:'fixture-model',modelSha256:'a'.repeat(64)};
const manifest={expressions:[{id:'dyn_happy',exclusiveGroup:'emotion'},{id:'dyn_angry',exclusiveGroup:'emotion'}],motions:[{id:'dyn_idle'}]};
const snapshot={activeExpressions:['user-expression'],activeMotions:['user-motion']};
const capabilities={readState:true,scopedResourceRelease:true};
const begin=()=>createControlState(manifest,identity,snapshot,capabilities);
const applied=s=>confirmControlPlan(s,{operationId:s.pending.operationId,status:'applied'});

test('A → B → restore releases only owned handles and preserves user baseline',()=>{
  let s=begin();
  s=applied(planControl(s,{type:'expression',id:'dyn_happy',operationId:'op-a'},identity));
  s=planControl(s,{type:'expression',id:'dyn_angry',operationId:'op-b'},identity);
  assert.deepEqual(s.pending.commands.map(c=>c.type),['release_expression','activate_expression']);
  assert.equal(s.pending.commands[0].token,'op-a:expression');
  s=applied(s);
  s=planControl(s,{type:'restore',operationId:'op-restore'},identity);
  assert.equal(s.pending.commands.length,1);
  assert.equal(s.pending.commands[0].token,'op-b:expression');
  assert.ok(s.pending.commands.every(c=>!('values' in c)),'never reset tracking parameters');
  s=applied(s);
  assert.equal(s.activeExpression,null);
  assert.deepEqual(s.baseline,snapshot);
});

test('motion cancellation leaves the expression and tracking alone',()=>{
  let s=applied(planControl(begin(),{type:'expression',id:'dyn_happy',operationId:'a'},identity));
  s=applied(planControl(s,{type:'motion',id:'dyn_idle',operationId:'b'},identity));
  s=planControl(s,{type:'cancel_motion',operationId:'c'},identity);
  assert.deepEqual(s.pending.commands,[{type:'release_motion',id:'dyn_idle',token:'b:motion'}]);
  s=applied(s);assert.equal(s.activeExpression.id,'dyn_happy');assert.equal(s.activeMotion,null);
});

test('reset_expression releases only the owned emotion, preserving motion, bow and user baseline',()=>{
  const resources=structuredClone(manifest);
  resources.expressions.push({id:'bow_off',exclusiveGroup:'appearance.chest_bow.hidden'});
  let s=createControlState(resources,identity,snapshot,capabilities);
  for(const event of [{type:'expression',id:'dyn_angry'}, {type:'appearance',id:'bow_off',enabled:true}, {type:'motion',id:'dyn_idle'}])
    s=applied(planControl(s,{...event,operationId:event.id},identity));
  s=planControl(s,{type:'reset_expression',operationId:'emotion-reset'},identity);
  assert.deepEqual(s.pending.commands,[{type:'release_expression',id:'dyn_angry',token:'dyn_angry:expression'}]);
  s=applied(s);assert.equal(s.activeExpression,null);
  assert.equal(s.activeMotion.id,'dyn_idle');
  assert.equal(s.activeAppearances['appearance.chest_bow.hidden'].id,'bow_off');
  assert.deepEqual(s.baseline,snapshot);
});

test('restore operation IDs cannot be reused and a partial failure requires native reconciliation',()=>{
  let s=applied(planControl(begin(),{type:'restore',operationId:'restore'},identity));
  assert.throws(()=>planControl(s,{type:'restore',operationId:'restore'},identity),{code:'CONTROL_OPERATION_INVALID'});
  s=applied(planControl(s,{type:'expression',id:'dyn_happy',operationId:'a'},identity));
  s=confirmControlPlan(planControl(s,{type:'expression',id:'dyn_angry',operationId:'b'},identity),{operationId:'b',status:'failed'});
  // Host may have released A before rejecting B. Do not silently claim A was restored.
  s=reconcileControl(s,identity,{owned:[],pendingOperationSettled:true});assert.equal(s.activeExpression,null);
});

test('cross-session, cross-model and invalid expression combinations reject',()=>{
  for(const changed of ['sessionKey','sessionId','modelId','modelSha256']) {
    assert.throws(()=>planControl(begin(),{type:'restore',operationId:'r'},{...identity,[changed]:'other'}),{code:'CONTROL_IDENTITY_MISMATCH'});
  }
  assert.throws(()=>planControl(begin(),{type:'expression',id:['dyn_happy','dyn_angry'],operationId:'both'},identity),{code:'CONTROL_RESOURCE_INVALID'});
  assert.throws(()=>createControlState(manifest,identity,snapshot,{readState:false,scopedResourceRelease:false}),{code:'RUNTIME_UNSUPPORTED'});
});

test('unknown/disconnected operation cannot be replayed; reconnect requires reconciliation',()=>{
  let s=planControl(begin(),{type:'expression',id:'dyn_happy',operationId:'a'},identity);
  s=confirmControlPlan(s,{operationId:'a',status:'unknown'});
  assert.equal(s.phase,'needs_reconcile');
  assert.throws(()=>planControl(s,{type:'restore',operationId:'b'},identity),{code:'CONTROL_RECONCILE_REQUIRED'});
  const pending=s.pending;
  assert.throws(()=>reconcileControl(s,identity,{owned:[]}),{code:'CONTROL_RECONCILE_REQUIRED'});
  s=reconcileControl(s,identity,{owned:[{type:'expression',id:'dyn_happy',token:'a:expression'}],pendingOperationSettled:true});
  assert.equal(s.activeExpression.token,'a:expression');assert.equal(s.pending,null);
  assert.equal(pending.operationId,'a');
  s=planControl(s,{type:'disconnect'},identity);assert.equal(s.phase,'needs_reconcile');
  assert.throws(()=>reconcileControl(s,identity,{owned:[{type:'expression',id:'dyn_angry',token:'someone-else'}]}),{code:'CONTROL_RESOURCE_INVALID'});
});

test('a user-owned expression in the same exclusive group is preserved, with an explicit conflict',()=>{
  const s=createControlState(manifest,identity,{activeExpressions:['dyn_happy'],activeMotions:[]},capabilities);
  assert.throws(()=>planControl(s,{type:'expression',id:'dyn_angry',operationId:'b'},identity),{code:'CONTROL_RESOURCE_CONFLICT'});
});

test('bow toggle, emotion and motion use independent owned resources across reconnect',()=>{
  const bow={id:'dyn_appearance_chest_bow',exclusiveGroup:'appearance.chest_bow.hidden'};
  let s=createControlState({...manifest,expressions:[...manifest.expressions,bow]},identity,snapshot,capabilities);
  const set=(type,id,operationId,enabled)=>{s=applied(planControl(s,{type,id,operationId,enabled},identity));};
  set('expression','dyn_happy','happy');set('appearance',bow.id,'hide',true);set('motion','dyn_idle','idle');
  set('expression','dyn_angry','angry');
  s=reconcileControl(planControl(s,{type:'disconnect'},identity),identity,{owned:[
    {type:'expression',id:bow.id,token:'hide:expression'},{type:'expression',id:'dyn_angry',token:'angry:expression'},
    {type:'motion',id:'dyn_idle',token:'idle:motion'}]});
  let next=planControl(s,{type:'appearance',id:bow.id,enabled:false,operationId:'show'},identity);
  assert.deepEqual(next.pending.commands,[{type:'release_expression',id:bow.id,token:'hide:expression'}]);
  s=applied(next);assert.equal(s.activeExpression.id,'dyn_angry');assert.equal(s.activeMotion.id,'dyn_idle');
  set('appearance',bow.id,'hide-again',true);
  next=planControl(s,{type:'restore',operationId:'restore'},identity);
  assert.deepEqual(next.pending.commands.map(c=>c.token).sort(),['angry:expression','hide-again:expression','idle:motion']);
  assert.deepEqual(applied(next).baseline,snapshot);
});

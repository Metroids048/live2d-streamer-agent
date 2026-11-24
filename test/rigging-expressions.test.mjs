import test from 'node:test';
import assert from 'node:assert/strict';
import {closedMouthOperations,openMouthOperations,browOperations,applyExpressionRefinement} from '../src/rigging/expressions.mjs';

const cubic=(c,t)=>c[0]*(1-t)**3+3*c[1]*(1-t)**2*t+3*c[2]*(1-t)*t*t+c[3]*t**3;
const nativeMouthBounds={
  cavity:[.16756918,.26257348,.8248855,.71485406],
  upper:[.19316553,.20938957,.7983385,.40058154],
  lower:[.3473339,.5846338,.6460458,.77615845],
};
const expressionQuery=axes=>async(op,req)=>({data:op==='mesh_get_topology'
  ?{target:req.target,coordinate_space:'mesh_rest',bounds:nativeMouthBounds.cavity}
  :{axes,parent:'DeformSharedMouthAperture'}});
test('different native lip cages follow the same parent-space speaking field',()=>{
  const commonBounds=nativeMouthBounds.cavity;
  for(const form of [-1,1])for(const bounds of Object.values(nativeMouthBounds)) {
    const controls=openMouthOperations(form,{bounds,commonBounds})[0].controls;
    const reference=openMouthOperations(form)[0].controls;
    for(let i=0;i<=100;i++) {
      const t=i/100,x=bounds[0]+t*(bounds[2]-bounds[0]);
      const commonT=(x-commonBounds[0])/(commonBounds[2]-commonBounds[0]);
      const expected=cubic(reference,commonT)*(commonBounds[3]-commonBounds[1]);
      const actual=cubic(controls,t)*(bounds[3]-bounds[1]);
      assert(Math.abs(actual-expected)<1e-12,`${form}: shared x=${x}, ${actual} != ${expected}`);
    }
  }
});
test('mouth fields reject invalid native rest bounds',()=>{
  for(const bounds of [[0,0,0,1],[0,1,1,0],[NaN,0,1,1],null])
    assert.throws(()=>openMouthOperations(-1,{bounds,commonBounds:nativeMouthBounds.cavity}),/EXPRESSION_MOUTH_BOUNDS_INVALID/);
});
test('closed mouth reverses the source smile and widens a happy closed line',()=>{
  const angry=closedMouthOperations(-1),happy=closedMouthOperations(1);
  assert(angry[0].factors[0]>0&&happy[0].factors[0]>1);
  // Source r8 MOC lip bounds are 4.78 logical pixels high. At the actual
  // expression strength .65 this exceeds the source smile's ~1.5 px rise.
  const rise=c=>cubic(c,0)-cubic(c,.5);
  assert(rise(angry[1].controls)*4.78*.65>1.5);
  assert(rise(happy[1].controls)<0);
  assert.deepEqual(closedMouthOperations(0),[{type:'scale',factors:[1,1]}]);
});
test('angry brows lower their inner ends on both sides without reversing geometry',()=>{
  for(const [side,sign] of [['left',-1],['right',1]]) {
    const angry=browOperations(side,-1),happy=browOperations(side,1);
    assert.equal(Math.sign(angry[0].degrees),sign);
    assert(angry[1].delta[1]>0&&happy[1].delta[1]<0);
    assert.equal(Math.sign(happy[0].degrees),-sign);
    // Rotation/translation preserve oriented area; y=f(x) curve shear and
    // positive horizontal scale cannot flip any lip/brow cell.
    const a=angry[0].degrees*Math.PI/180;
    assert(Math.abs(Math.cos(a)**2+Math.sin(a)**2-1)<1e-12);
  }
});
test('expression repair seeds and resets only its direct geometry, preserving all opacity tracks',async()=>{
  const parts=[{id:'browL',tags:['brow','left']},{id:'browR',tags:['brow','right']},{id:'lip',tags:['mouth','closed']},{id:'open',tags:['mouth','open']}];
  const objects=parts.map(p=>({layerId:p.id,target:'mesh:'+p.id}));
  const calls=[],session={query:expressionQuery({}),async step(key,operation,body){calls.push({key,operation,body});}};
  const result=await applyExpressionRefinement(session,parts,objects,{intent:{expressions:[{id:'happy'},{id:'angry'}]}});
  assert.equal(result.targets.length,4);
  assert.equal(calls.length,13);
  for(let i=0;i<9;i+=3) {
    assert.equal(calls[i].operation,'author_axis');
    assert.equal(calls[i+1].operation,'keyform_apply');
    assert.equal(calls[i+1].body.changes[0].to,'rest');
    assert.equal(calls[i+2].operation,'rig_deform');
    assert(calls[i+2].body.changes.every(c=>!Object.hasOwn(c,'channels')));
  }
  assert(calls.every(c=>c.body.changes?.every(x=>!Object.hasOwn(x,'channels'))??true));
  const open=calls.find(c=>c.operation==='rig_deform'&&c.body.changes[0].target==='mesh:open');
  assert.equal(open.body.changes.length,15);
  for(const v of [0,.25,.5,.75,1])for(const f of [-1,0,1])
    assert(open.body.changes.some(c=>c.key.ParamMouthOpenY===v&&c.key.ParamMouthForm===f));
  assert(open.body.changes.every(c=>c.operations.every(op=>op.type!=='scale'||op.factors[1]===1)),'parent owns aperture; no second compression');
});
test('speaking angry mouth changes its source curve while neutral aperture geometry stays untouched',()=>{
  const angry=openMouthOperations(-1)[0],happy=openMouthOperations(1)[0];
  assert(cubic(angry.controls,0)>cubic(angry.controls,.5));
  assert(cubic(happy.controls,0)<cubic(happy.controls,.5));
  assert(Math.abs(cubic(angry.controls,.5))<1e-12,'do not displace the cavity center');
  assert.deepEqual(openMouthOperations(0),[{type:'scale',factors:[1,1]}]);
});
test('full angry form limits corner displacement to avoid the observed pointed speaking cavity',()=>{
  // r9 after-mouth tile E (Form=-1, Open=.65) showed a pointed roof and
  // hooked tongue. A .7-height corner shear over-corrected the source smile.
  const controls=openMouthOperations(-1)[0].controls;
  for(let i=0;i<=100;i++)assert(Math.abs(cubic(controls,i/100))<=.5);
  assert(cubic(controls,0)>.3,'retain an actual frown correction');
});
test('existing mouth aperture cells receive the same new form without interpolation holes',async()=>{
  const calls=[],session={query:expressionQuery({ParamMouthOpenY:[0,.1,.6,1],ParamMouthForm:[-1,0,1]}),async step(k,op,body){calls.push({op,body});}};
  await applyExpressionRefinement(session,[{id:'open',tags:['mouth','open']}],[{layerId:'open',target:'mesh:open'}],{intent:{expressions:[{id:'angry'}]}});
  const changes=calls.find(c=>c.op==='rig_deform').body.changes;
  for(const v of [.1,.6])for(const f of [-1,0,1])assert(changes.some(c=>c.key.ParamMouthOpenY===v&&c.key.ParamMouthForm===f));
});
test('unexpected expression axes fail before authoring instead of erasing combinations',async()=>{
  const calls=[],session={async query(){return{data:{axes:{ParamAngleX:[-15,0,15]}}};},async step(...c){calls.push(c);}};
  await assert.rejects(applyExpressionRefinement(session,[{id:'lip',tags:['mouth','closed']}],[{layerId:'lip',target:'mesh:lip'}],{intent:{expressions:[{id:'angry'}]}}),/EXPRESSION_UNEXPECTED_DIRECT_AXIS/);
  assert.equal(calls.length,0);
});
test('native expression geometry warnings remain a blocking failure',async()=>{
  const session={async query(){return{data:{axes:{}}};},async step(key,op){return{data:op==='rig_deform'?{geometry_diagnostics:{warnings:['folded cell']}}:{}};}};
  await assert.rejects(applyExpressionRefinement(session,[{id:'lip',tags:['mouth','closed']}],[{layerId:'lip',target:'mesh:lip'}],{intent:{expressions:[{id:'angry'}]}}),/EXPRESSION_GEOMETRY_REVIEW_REQUIRED/);
});
test('speaking lip fields reject different parents before authoring',async()=>{
  const parts=[{id:'open',tags:['mouth','open']},{id:'upper',tags:['mouth','open','line','upper']}];
  const calls=[],session={query:async(op,req)=>op==='mesh_get_topology'
    ?expressionQuery({})(op,req):{data:{parent:req.target,axes:{}}},async step(...args){calls.push(args);}};
  await assert.rejects(applyExpressionRefinement(session,parts,parts.map(p=>({layerId:p.id,target:'mesh:'+p.id})),{intent:{expressions:[{id:'angry'}]}}),/EXPRESSION_MOUTH_PARENT_MISMATCH/);
  assert.equal(calls.length,0);
});

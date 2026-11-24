import test from 'node:test';
import assert from 'node:assert/strict';
import {applySharedFaceRig,applyEyeApertureKeys,portraitParallax} from '../src/rigging/shared-face.mjs';
test('relative turn of the foreground locks and ornament tips keeps the scalp and bases attached',()=>{
 const face={geometry:{canvasBounds:[10,25,50,65]}};
 const locks={tags:['hair','front','root'],geometry:{canvasBounds:[0,0,60,75]}};
 const ornament={tags:['head','accessory'],geometry:{canvasBounds:[0,0,60,32]}};
 for(const turn of [-15,15]) {
  assert.equal(Math.abs(portraitParallax(locks,face,[13,25],turn)[0]),0);
  assert.equal(Math.abs(portraitParallax(ornament,face,[13,30],turn)[0]),0);
  assert.equal(Math.abs(portraitParallax(locks,face,[13,55],turn)[0]),0);
  assert.equal(Math.sign(portraitParallax(locks,face,[13,41],turn)[0]),-Math.sign(turn));
  assert.equal(Math.sign(portraitParallax(locks,face,[3,50],turn)[0]),-Math.sign(turn));
  assert.equal(Math.sign(portraitParallax(ornament,face,[13,3],turn)[0]),-Math.sign(turn));
 }
});
test('upper lash follows the half-closed aperture while retaining its own thickness',async()=>{
 const calls=[],session={async step(key,operation,body){calls.push({operation,body});}};
 await applyEyeApertureKeys(session,'L','ParamEyeLOpen',[0,.25,.5,.75,1],[.5,.6],{articulated:true,lashCenter:[.5,.4]});
 const changes=calls.find(c=>c.operation==='rig_deform').body.changes;
 const half=changes.find(c=>c.key.ParamEyeLOpen===.5&&c.key.ParamEyeSmile===0).operations;
 assert.equal(half[0].factors[1]*half[1].factors[1],.75);
 assert(Math.abs(half[1].pivot[1]-.5)<1e-9);
 const open=changes.find(c=>c.key.ParamEyeLOpen===1&&c.key.ParamEyeSmile===0).operations;
 assert.deepEqual(open,[{type:'scale',factors:[1,1],pivot:[.5,.6]}]);
});
test('angry eye seeds a full independent lattice and preserves absolute blink quartiles',async()=>{
 const calls=[],session={async step(key,operation,body){calls.push({operation,body});}};
 for(const [id,axis] of [['L','ParamEyeLOpen'],['R','ParamEyeROpen']])
  await applyEyeApertureKeys(session,id,axis,[0,.25,.5,.75,1],[.5,.5],{angry:true});
 for(const [id,axis,sign] of [['L','ParamEyeLOpen',-1],['R','ParamEyeROpen',1]]) {
  const target='warp:'+id,geometry=calls.findIndex(c=>c.operation==='rig_deform'&&c.body.changes[0].target===target);
  const seed=calls.findIndex(c=>c.operation==='author_axis'&&c.body.parameter.id==='ParamEyeAngry'&&c.body.shapes[0].target===target);
  assert(seed>=0&&seed<geometry);
  assert.equal(calls[seed].body.shapes.length,10,'both Smile states exist before Angry is shaped');
  const changes=calls[geometry].body.changes;
  assert.equal(changes.length,20);
  for(const c of changes) {
   assert.equal(c.operations[0].factors[1],Math.max(.05,c.key[axis])*(c.key.ParamEyeSmile?.84:1)*(c.key.ParamEyeAngry?.88:1));
   assert.equal(c.operations[1]?.degrees??0,c.key.ParamEyeAngry?sign*7:0);
  }
  assert(calls.slice(seed+1,geometry).some(c=>c.operation==='keyform_apply'&&c.body.changes.some(s=>s.target===target&&s.all_keys)));
 }
});
test('new portrait blinks inherit head yaw without a second compression or tilt',async()=>{
 const cells=async linkedBlink=>{
  const changes=[];
  await applyEyeApertureKeys({async step(_key,operation,body){
   if(operation==='rig_deform')changes.push(...body.changes);
  }},'L','ParamEyeLOpen',[0,.25,.5,.75,1],[.5,.6],{farYaw:-18,linkedBlink});
  return changes;
 };
 const half=changes=>changes.filter(c=>c.key.ParamEyeLOpen===.5&&c.key.ParamEyeSmile===0);
 const historical=half(await cells(false));
 assert(historical.some(c=>c.key.ParamAngleX===-18&&c.operations[0].factors[1]<.5&&c.operations[1].type==='rotate'));
 const current=half(await cells(true));
 assert.equal(current.length,1);
 assert.deepEqual(current[0].operations,[{type:'scale',factors:[1,.5],pivot:[.5,.6]}]);
});
test('eye quartiles are absolute scales after the full key lattice is seeded',async()=>{
 const p=(id,tags)=>({id,tags,geometry:{canvasBounds:[10,10,30,20]}});
 const parts=[p('face',['face']),p('white',['eye','white','left']),p('closed',['eye','closed','left'])];
 const objects=[{target:'warp:DeformHeadContainer'},...parts.map(p=>({target:'mesh:'+p.id,layerId:p.id,parentId:'DeformHeadContainer'}))];
 const calls=[],session={capturePlan:async(_key,read)=>read(),async query(op){return{data:op==='mesh_get_topology'?{bounds:[.2,.3,.6,.5]}:{axes:{}}};},async step(key,operation,body){calls.push({operation,body});}};
 await applySharedFaceRig(session,parts,objects,{intent:{headMotion:{yawDegrees:10,pitchDegrees:8,rollDegrees:6},eyes:{blink:true},mouth:{speech:true},expressions:[],actions:[]}});
 // Model native author_axis's incremental interpolation for a newly added key.
 // A quarter key created after an already compressed zero inherits that shape.
 const forms=new Map([[1,1]]),sample=x=>{const keys=[...forms.keys()].sort((a,b)=>a-b);if(forms.has(x))return forms.get(x);const l=keys.filter(k=>k<x).at(-1)??keys[0],r=keys.find(k=>k>x)??keys.at(-1);return l===r?forms.get(l):forms.get(l)+(forms.get(r)-forms.get(l))*(x-l)/(r-l);};
 const target='warp:DeformSharedApertureL';
 for(const c of calls){
  if(c.operation==='author_axis'&&c.body.parameter.id==='ParamEyeLOpen')for(const s of c.body.shapes)forms.set(s.value,sample(s.value)*s.operations[0].factors[1]);
  if(c.operation==='keyform_apply'&&c.body.changes.some(s=>s.target===target&&s.op==='reset'&&s.all_keys))for(const k of forms.keys())forms.set(k,1);
  if(c.operation==='rig_deform')for(const s of c.body.changes.filter(s=>s.target===target&&(s.key.ParamEyeSmile??0)===0))forms.set(s.key.ParamEyeLOpen,sample(s.key.ParamEyeLOpen)*s.operations[0].factors[1]);
 }
 for(const v of [0,.25,.5,.75,1])assert.equal(forms.get(v),Math.max(.05,v),'eye '+v+' keeps the requested aperture');
 const reset=calls.findIndex(c=>c.operation==='keyform_apply'&&c.body.changes.some(s=>s.target===target&&s.all_keys));
 const geometry=calls.findIndex(c=>c.operation==='rig_deform'&&c.body.changes.some(s=>s.target===target));
 assert(reset>=0&&reset<geometry);
 assert.equal(calls[reset].body.changes[0].to,'default','native warps have a default shape, not a mesh rest shape');
 const cells=calls[geometry].body.changes.filter(s=>s.target===target);
 assert.equal(cells.length,10);
 for(const s of cells)assert.equal(s.operations[0].factors[1],Math.max(.05,s.key.ParamEyeLOpen)*(s.key.ParamEyeSmile?.84:1));
});
test('generated descendant head fields are neutralized and aperture layers share one native warp',async()=>{
 const p=(id,tags)=>({id,tags,geometry:{canvasBounds:[10,10,30,20]}});
 const parts=[p('face',['face']),p('white',['eye','white','left']),p('upper',['eye','lash','left']),p('rim',['eye','rim','left']),p('iris',['eye','iris','left']),p('patch',['eye','closed','left','patch']),p('closed',['mouth','closed']),p('cavity',['mouth','open']),p('lip',['mouth','open','line'])];
 const objects=[{target:'warp:DeformHeadContainer',parentId:'DeformHeadRotation'},{target:'warp:DeformFaceNinePose',parentId:'DeformHeadContainer'},...parts.map(p=>({target:'mesh:'+p.id,layerId:p.id,parentId:'DeformFaceNinePose'}))];
 const calls=[];const session={capturePlan:async(_key,read)=>read(),async query(op,b){return {data:op==='mesh_get_topology'?{bounds:[.2,.3,.6,.5]}:{axes:{ParamAngleX:[-45,0,45],ParamAngleY:[-30,0,30]}}};},async step(key,operation,body){calls.push({key,operation,body});return {data:{}};}};
 const report=await applySharedFaceRig(session,parts,objects,{intent:{headMotion:{yawDegrees:10,pitchDegrees:8,rollDegrees:6},eyes:{blink:true},mouth:{speech:true},expressions:[],actions:[]}});
 assert(report.headResetTargets.includes('warp:DeformFaceNinePose'));
 assert.deepEqual(calls.filter(c=>c.operation==='warp_set_topology').map(c=>c.body),[
  {target:'warp:DeformHeadContainer',rows:16,columns:16},
  {target:'warp:DeformFaceNinePose',rows:16,columns:16}
 ]);
 assert(report.featureResetTargets.includes('mesh:upper'));
 const eye=calls.find(c=>c.operation==='rig_create_warp'&&c.body.id==='DeformSharedApertureL');
 assert.deepEqual(eye.body.targets,['mesh:white','mesh:upper','mesh:rim']);
 assert(!eye.body.targets.includes('mesh:patch'));assert(!eye.body.targets.includes('mesh:iris'));
 const smile=calls.find(c=>c.operation==='author_axis'&&c.body.parameter.id==='ParamEyeSmile');
 assert.equal(smile.body.shapes[0].target,'warp:DeformSharedApertureL');
 assert.deepEqual(smile.body.shapes[0].operations[0].pivot,[.4,.4]);
 const mouth=calls.find(c=>c.operation==='rig_create_warp'&&c.body.id==='DeformSharedMouthAperture');
 assert.deepEqual(mouth.body.targets,['mesh:cavity','mesh:lip']);
 assert.deepEqual(report.apertures.at(-1).pivot,[.4,.4]);
 for(const id of ['cavity','lip'])assert(report.opacity.some(c=>c.target==='mesh:'+id&&c.key.ParamMouthOpenY===.12&&c.channels.opacity===1));
 assert(report.opacity.some(c=>c.target==='mesh:closed'&&c.key.ParamMouthOpenY===.12&&c.channels.opacity===0));
 assert(report.opacity.some(c=>c.target==='mesh:patch'&&c.key.ParamEyeLOpen===.2&&c.channels.opacity===0));
 assert(report.opacity.some(c=>c.target==='mesh:upper'&&c.key.ParamEyeLOpen===.2&&c.channels.opacity===1));
 assert(report.opacity.some(c=>c.target==='mesh:rim'&&c.key.ParamEyeLOpen===.2&&c.channels.opacity===1));
 assert(calls.filter(c=>c.operation==='author_axis'&&['ParamAngleX','ParamAngleY'].includes(c.body.parameter.id)).every(c=>c.body.shapes.every(s=>s.target==='warp:DeformHeadContainer')));
});

test('feature rest reset excludes unkeyed geometry even when opacity is keyed',async()=>{
 const parts=[{id:'face',tags:['face'],geometry:{canvasBounds:[0,0,20,30]}},...['keyed','unkeyed'].map(id=>({id,tags:['eye','iris'],geometry:{canvasBounds:[2,2,3,3]}}))];
 const objects=[{target:'warp:DeformHeadContainer'},...parts.map(p=>({target:'mesh:'+p.id,layerId:p.id,parentId:'DeformHeadContainer'}))];
 const calls=[];const session={capturePlan:async(_key,read)=>read(),async query(op,b){return {data:{axes:b.target==='mesh:keyed'?{ParamEyeBallForm:[-1,0,1]}:{},channels:[{channel:'opacity',axes:{ParamEyeLOpen:[0,1]}}]}};},async step(key,operation,body){calls.push({key,operation,body});}};
 await applySharedFaceRig(session,parts,objects,{intent:{headMotion:{yawDegrees:10,pitchDegrees:8,rollDegrees:6},eyes:{blink:true},mouth:{speech:true},expressions:[],actions:[]}});
 assert.deepEqual(calls.find(c=>c.key.endsWith('feature-rest')).body.changes,[{op:'reset',target:'mesh:keyed',all_keys:true,to:'rest'}]);
});


test('resume pins only the completed feature-rest receipt before later expression axes',async()=>{
 const {createHash}=await import('node:crypto');
 const body={changes:[{op:'reset',target:'mesh:keyed',all_keys:true,to:'rest'}]};
 const bodyHash=createHash('sha256').update(JSON.stringify({operation:'keyform_apply',body,lifecycle:false})).digest('hex');
 const parts=[{id:'face',tags:['face'],geometry:{canvasBounds:[0,0,20,30]}},...['keyed','later-expression'].map(id=>({id,tags:['eye','iris'],geometry:{canvasBounds:[2,2,3,3]}}))];
 const objects=[{target:'warp:DeformHeadContainer'},...parts.map(p=>({target:'mesh:'+p.id,layerId:p.id,parentId:'DeformHeadContainer'}))];
 const brief={intent:{headMotion:{yawDegrees:10,pitchDegrees:8,rollDegrees:6},eyes:{blink:true},mouth:{speech:true},expressions:[],actions:[]}};
 const done={operation:'keyform_apply',bodyHash,data:{changed:['mesh:keyed']}};
 const calls=[],session={capturePlan:async(_key,read)=>read(),journal:{done:{'shared-face-v5-feature-rest':done}},async query(){return {data:{axes:{ParamMouthForm:[-1,0,1]}}};},async step(key,operation,actual){if(key==='shared-face-v5-feature-rest')assert.equal(createHash('sha256').update(JSON.stringify({operation,body:actual,lifecycle:false})).digest('hex'),done.bodyHash,'strict completed request hash');calls.push({key,body:actual});}};
 await applySharedFaceRig(session,parts,objects,brief);
 assert.deepEqual(calls.find(c=>c.key==='shared-face-v5-feature-rest').body,body);
 done.bodyHash='0'.repeat(64);
 await assert.rejects(applySharedFaceRig(session,parts,objects,brief),/strict completed request hash/);
});

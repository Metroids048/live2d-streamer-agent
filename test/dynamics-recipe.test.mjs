import test from 'node:test';
import assert from 'node:assert/strict';
import {compileDynamicsRecipe} from '../src/dynamics/recipe.mjs';

// 03's published map structure. PNG paths/pixel counts are explicitly simulated fixture data.
function parameter(id,semantic,owner='rigging') {
  return {id,semantic,min:-1,max:1,default:0,available:true,owner,
    targets:['warp:'+id],bindings:[{target:'warp:'+id,directAxes:{[id]:[-1,0,1]},inherited:[]}],
    motionEvidence:[{value:1,defaultImage:'rigging/neutral.png',posedImage:'rigging/'+id+'.png',changedPixels:10,totalPixels:100}]};
}
function fixture() {
  return {schemaVersion:1,parameters:[parameter('turn','head.x'),parameter('tilt','head.z'),
    parameter('front','hair.front','physics'),parameter('back','hair.back','physics'),parameter('charm','accessory.swing','physics'),
    parameter('breathe','body.breath','motion'),parameter('brows','expression.brow','expression'),
    parameter('eyes','expression.eye','expression'),parameter('shape','mouth.form','expression'),
    {...parameter('opening','mouth.open'),min:0,max:1},parameter('blink','eye.left.open')],
    dynamics:{expressions:[{id:'happy',name:'开心',values:{brows:0.45,eyes:0.65,shape:0.8}},
      {id:'angry',name:'生气',values:{brows:-0.65,eyes:-0.5,shape:-0.7}}]}};
}

test('recipe derives distinct physical groups; expressions and idle never seize tracking inputs',()=>{
  const p=compileDynamicsRecipe(fixture());
  assert.equal(p.unresolved.length,0);
  assert.equal(p.physics.length,3);
  assert.notDeepEqual(p.physics[0].segments,p.physics[1].segments);
  assert.equal(new Set(p.physics.flatMap(g=>g.outputs.map(o=>o.parameter))).size,3);
  assert.ok(p.expressions.every(e=>e.entries.length===3&&e.entries.every(v=>v.blend==='Add')));
  assert.deepEqual(p.motions[0].curves.map(c=>c.parameter),['breathe']);
  assert.ok(p.physics.flatMap(g=>g.outputs).every(o=>!['turn','tilt','opening','blink'].includes(o.parameter)));
});

test('segmented hair consumes a shared pendulum with distinct measured root and tip outputs',()=>{
  const m=fixture(),base=m.parameters.find(p=>p.id==='back');
  base.physicsChain={id:base.id,vertex:1};
  const tip={...parameter('tip','hair.back.tip','physics'),targets:base.targets,physicsChain:{id:base.id,vertex:2}};
  tip.bindings[0].target=base.bindings[0].target;
  m.parameters.push(tip);
  const recipe=compileDynamicsRecipe(m),chain=recipe.physics.find(g=>g.id==='dyn_back');
  assert.deepEqual(recipe.unresolved,[]);
  assert.deepEqual(chain.outputs.map(({parameter,vertex})=>[parameter,vertex]),[['back',1],['tip',2]]);
  assert(chain.segments[0].delay<chain.segments[1].delay);
  assert.equal(recipe.physics.some(g=>g.id==='dyn_tip'),false);
  tip.bindings[0].target='warp:wrong';
  assert.throws(()=>compileDynamicsRecipe(m),{code:'DYNAMICS_PHYSICS_CHAIN_INVALID'});
});

test('a parameter without real moving forms is a blocker, even if marked available',()=>{
  const m=fixture();m.parameters.find(p=>p.id==='front').motionEvidence[0].changedPixels=0;
  const p=compileDynamicsRecipe(m);
  assert.ok(p.unresolved.some(u=>u.code==='DYNAMICS_SHAPE_MISSING'));
  assert.ok(p.physics.every(g=>g.outputs.every(o=>o.parameter!=='front')));
});

test('consumes 03 semantics and creator ownership; uses brief.intent and honors default reset',()=>{
  const m=fixture();delete m.dynamics;
  for(const p of m.parameters) {
    p.owner='rigging';p.semantic=({'head.x':'head.yaw','head.z':'head.roll','expression.brow':'brow.left','expression.eye':'eyes.emotion'})[p.semantic]??p.semantic;
  }
  m.parameters.find(p=>p.id==='breathe').min=0;
  const p=compileDynamicsRecipe(m,{intent:{expressions:[{id:'happy',label:'开心'},{id:'angry',label:'生气'}],actions:[{id:'reset'}]}});
  assert.equal(p.unresolved.length,0);assert.equal(p.physics.length,3);
  assert.equal(p.expressions[0].entries.length,3);
  assert.equal(p.motions.length,1);
  assert.deepEqual(p.ownership.tracking,['turn','tilt','opening','blink']);
});

test('03 one-sided Smile and Angry eye shapes are emotion-specific; zero-pixel angry stays blocked',()=>{
  const m=fixture();delete m.dynamics;
  m.parameters=m.parameters.filter(p=>p.id!=='eyes');
  m.parameters.push({...parameter('smile','eyes.smile'),min:0},
    {...parameter('angryEye','expression.eye.angry'),min:0});
  const recipe=compileDynamicsRecipe(m);
  assert.equal(recipe.unresolved.length,0);
  assert(recipe.expressions[0].entries.some(e=>e.parameter==='smile'&&e.value>0));
  assert(!recipe.expressions[0].entries.some(e=>e.parameter==='angryEye'));
  assert(recipe.expressions[1].entries.some(e=>e.parameter==='angryEye'&&e.value>0));
  assert(!recipe.expressions[1].entries.some(e=>e.parameter==='smile'));
  m.parameters.find(p=>p.id==='angryEye').motionEvidence[0].changedPixels=0;
  const rejected=compileDynamicsRecipe(m);
  assert(rejected.unresolved.some(e=>e.code==='DYNAMICS_EXPRESSION_INCOMPLETE'&&e.message.startsWith('angry')));
  assert(!rejected.expressions.find(e=>e.id==='dyn_angry').entries.some(e=>e.parameter==='angryEye'));
});

test('smile and surprise use their own rendered eye shapes while tracking stays available',()=>{
  const map=fixture();delete map.dynamics;
  map.parameters=map.parameters.filter(p=>p.id!=='eyes');
  map.parameters.push({...parameter('smile','eyes.smile'),min:0},
    {...parameter('surprisedEyes','expression.eye.surprise'),min:0});
  const brief={intent:{expressions:[{id:'smile'},{id:'surprise'}],actions:[{id:'reset'}]}};
  const result=compileDynamicsRecipe(map,brief);
  assert.deepEqual(result.unresolved,[]);
  assert.deepEqual(result.expressions.map(e=>e.id),['dyn_smile','dyn_surprise']);
  assert.deepEqual(result.expressions.map(e=>e.entries.find(v=>['smile','surprisedEyes'].includes(v.parameter)).parameter),['smile','surprisedEyes']);
  assert.ok(result.expressions[1].entries.find(v=>v.parameter==='brows').value>0);
  assert.ok(result.expressions[1].entries.find(v=>v.parameter==='shape').value<0);
  assert.ok(result.ownership.tracking.includes('blink'));
  map.parameters.at(-1).motionEvidence[0].changedPixels=0;
  assert.ok(compileDynamicsRecipe(map,brief).unresolved.some(u=>u.code==='DYNAMICS_EXPRESSION_INCOMPLETE'&&u.message.startsWith('surprise')));
});

test('independent strands replace overlapping generated hair outputs and no double writer is allowed',()=>{
  const m=fixture(),s=parameter('strand','hair.strand.front','physics');
  s.targets=['warp:front'];s.bindings[0].target='warp:front';m.parameters.push(s);
  const p=compileDynamicsRecipe(m);
  assert.ok(!p.physics.some(g=>g.outputs.some(o=>o.parameter==='front')));
  assert.ok(p.physics.some(g=>g.outputs.some(o=>o.parameter==='strand')));
  const other=parameter('other','hair.strand.other','physics');other.targets=s.targets;m.parameters.push(other);
  assert.throws(()=>compileDynamicsRecipe(m),{code:'DYNAMICS_OWNERSHIP_CONFLICT'});
});

test('cloth and chest bow use proven body inputs while hair retains head inputs; physics owns only separate outputs',()=>{
  const m=fixture();
  const body=parameter('bodyTurn','body.angleX'),roll=parameter('bodyRoll','body.angleZ');
  const cloth=parameter('skirt','cloth.lower','physics'),bow=parameter('bowSwing','accessory.chest_bow.source','physics');
  cloth.runtimeOwner='physics';bow.runtimeOwner='physics';m.parameters.push(body,roll,cloth,bow);
  const recipe=compileDynamicsRecipe(m),group=id=>recipe.physics.find(g=>g.outputs.some(o=>o.parameter===id));
  assert.equal(recipe.unresolved.length,0);
  for(const id of ['skirt','bowSwing']) {
    assert(group(id),'missing physics for '+id);
    assert.deepEqual(group(id).inputs.map(i=>i.parameter),['bodyTurn','bodyRoll']);
    assert.equal(group(id).inputs.reduce((sum,i)=>sum+i.weight,0),100);
    assert.equal(group(id).outputs[0].scale,.75);
    assert(recipe.ownership.physics.includes(id));
    for(const owner of ['tracking','expression','motion'])assert(!recipe.ownership[owner].includes(id));
  }
  assert.deepEqual(group('front').inputs.map(i=>i.parameter),['turn','tilt']);
  assert(!recipe.ownership.physics.includes('bodyTurn'));assert(!recipe.ownership.physics.includes('bodyRoll'));
  body.motionEvidence[0].changedPixels=0;roll.bindings=[];
  const fallback=compileDynamicsRecipe(m);
  assert.deepEqual(fallback.physics.find(g=>g.outputs[0].parameter==='skirt').inputs.map(i=>i.parameter),['turn','tilt']);
  cloth.motionEvidence[0].changedPixels=0;
  const still=compileDynamicsRecipe(m);
  assert(still.unresolved.some(u=>u.code==='DYNAMICS_SHAPE_MISSING'&&u.parameter==='skirt'));
  assert(!still.physics.some(g=>g.outputs[0].parameter==='skirt'));
  cloth.motionEvidence[0].changedPixels=10;cloth.runtimeOwner='motion';
  assert.throws(()=>compileDynamicsRecipe(m),{code:'DYNAMICS_OWNERSHIP_CONFLICT'});
  cloth.runtimeOwner='physics';cloth.targets=bow.targets;cloth.bindings[0].target=bow.bindings[0].target;
  assert.throws(()=>compileDynamicsRecipe(m),{code:'DYNAMICS_OWNERSHIP_CONFLICT'});
});

test('segmented sleeve receives head input even when the runtime leaves body axes at neutral',()=>{
  const map=fixture();
  const root={...parameter('sleeve','cloth.sleeve.root','physics'),physicsChain:{id:'sleeve',vertex:1}};
  const tip={...parameter('sleeveTip','cloth.sleeve.tip','physics'),targets:root.targets,physicsChain:{id:'sleeve',vertex:2}};
  tip.bindings[0].target=root.bindings[0].target;
  map.parameters.push(parameter('bodyTurn','body.angleX'),parameter('bodyRoll','body.angleZ'),root,tip);
  const group=compileDynamicsRecipe(map).physics.find(g=>g.id==='dyn_sleeve');
  assert.deepEqual(group.inputs.map(({parameter,weight})=>[parameter,weight]),[['bodyTurn',35],['bodyRoll',15],['turn',50]]);
  assert.deepEqual(group.outputs.map(({parameter,vertex})=>[parameter,vertex]),[['sleeve',1],['sleeveTip',2]]);
});

test('requested custom emotion is preserved as a gap instead of replaced by happy/angry',()=>{
  const p=compileDynamicsRecipe(fixture(),{intent:{expressions:[{id:'surprised',label:'惊讶'}],actions:[{id:'reset'}]}});
  assert.equal(p.expressions.length,0);
  assert.ok(p.unresolved.some(u=>u.message.includes('surprised')));
});

test('bound requested gesture uses only its allocated real axis and validates keyframes',()=>{
  const m=fixture();m.parameters.push(parameter('armWave','action.wave','motion'));
  m.dynamics.motions=[{id:'wave',name:'挥手',duration:1,loop:false,fps:30,
    curves:[{parameter:'armWave',keys:[{time:0,value:0},{time:.5,value:1},{time:1,value:0}]}]}];
  const p=compileDynamicsRecipe(m,{intent:{actions:[{id:'wave'}]}});
  assert.equal(p.unresolved.length,0);assert.equal(p.motions[1].id,'dyn_wave');
  m.dynamics.motions[0].name='Wave';
  assert.equal(compileDynamicsRecipe(m,{actions:['wave']}).motions[1].name,'Wave (custom)');
  m.dynamics.motions[0].curves[0].keys[1].value=2;
  assert.throws(()=>compileDynamicsRecipe(m,{actions:['wave']}),{code:'DYNAMICS_MAP_INVALID'});
});

test('missing binding and one-sided physics outputs cannot pass with a positive pixel count',()=>{
  const m=fixture();m.parameters.find(p=>p.id==='front').bindings=[];
  assert.ok(compileDynamicsRecipe(m).unresolved.some(u=>u.parameter==='front'));
  const n=fixture();n.parameters.find(p=>p.id==='front').min=0;
  assert.ok(compileDynamicsRecipe(n).unresolved.some(u=>u.code==='DYNAMICS_PHYSICS_RANGE_UNSUPPORTED'));
});

test('an appearance requires its own real switch and neutral return value',()=>{
  const intent={clothingVariants:[{id:'chest_bow',label:'摘下胸前蝴蝶结'}]},m=fixture();
  assert.ok(compileDynamicsRecipe(m,{intent}).unresolved.some(v=>v.code==='DYNAMICS_APPEARANCE_UNAVAILABLE'));
  const p=parameter('bow','appearance.chest_bow.hidden','expression');
  delete p.bindings[0].directAxes;p.bindings[0].opacityAxes={bow:[0,1]};m.parameters.push(p);
  m.dynamics.appearances=[{id:'chest_bow',parameter:'bow',on:1,off:0}];
  const recipe=compileDynamicsRecipe(m,{intent});
  assert.equal(recipe.unresolved.length,0);assert.equal(recipe.appearanceGroups.dyn_appearance_chest_bow,p.semantic);
  assert.deepEqual(recipe.expressions.at(-1).entries,[{parameter:'bow',blend:'Add',value:1}]);
  m.dynamics.appearances[0].off=-1;assert.throws(()=>compileDynamicsRecipe(m,{intent}),{code:'DYNAMICS_MAP_INVALID'});
});

test('expressions cannot lock MouthOpen/eyes/head, silently omit eyes, or ignore requested gestures',()=>{
  const m=fixture();m.dynamics.expressions[0].values.opening=0.8;
  assert.throws(()=>compileDynamicsRecipe(m),{code:'DYNAMICS_OWNERSHIP_CONFLICT'});
  const n=fixture();delete n.dynamics.expressions[0].values.eyes;
  assert.ok(compileDynamicsRecipe(n).unresolved.some(u=>u.code==='DYNAMICS_EXPRESSION_INCOMPLETE'));
  assert.ok(compileDynamicsRecipe(fixture(),{actions:['wave']}).unresolved.some(u=>u.code==='DYNAMICS_ACTION_UNAVAILABLE'));
});

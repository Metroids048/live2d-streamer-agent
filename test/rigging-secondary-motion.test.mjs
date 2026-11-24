import test from 'node:test';
import assert from 'node:assert/strict';
import {encodePng} from '../src/artwork/png.mjs';
import {alphaGeometry,decodePng} from '../src/rigging/geometry.mjs';
import {planRefinements,RIG_REPAIR_PROFILE} from '../src/rigging/recipe.mjs';

const brief={intent:{headMotion:{yawDegrees:12,pitchDegrees:8,rollDegrees:6},eyes:{},mouth:{},expressions:[],actions:[]}};
const rgba=Buffer.from(Array.from({length:64},(_,i)=>[130,90,180,i%8>=Math.floor(i/8/3)&&i%8<=6?255:0]).flat());
const geometry=alphaGeometry(decodePng(encodePng({width:8,height:8,data:rgba})),{left:17,top:31,width:80,height:120});

test('current profile authors separate bow and cloth swing shapes from source roles and measured root/tip',()=>{
  const layer=(id,tags,extra={})=>({id,tags,geometry,...extra});
  const parts=[layer('a',['appearance','chest_bow']),layer('b',['appearance:chest_bow']),
    layer('c',['lower-body']),layer('d',['cloth:waist-ribbon']),layer('e',['hair','front']),
    layer('f',['appearance','chest_bow','underlay']),layer('g',['appearance:chest_bow:underlay']),
    layer('h',['lower-body','underlay']),layer('i',['waist-ribbon','gesture','wave','raised']),
    layer('j',['accessory','gesture:wave:rest']),layer('k',['lower-body'],{reference:true}),layer('l',['upper-body'])];
  const plan=planRefinements(parts,parts.map(p=>({target:'mesh:'+p.id,layerId:p.id})),brief);
  const expected=new Map([['a','accessory.chest_bow.a'],['b','accessory.chest_bow.b'],['c','cloth.c'],['d','cloth.d'],['e','hair.strand.e']]);
  const shapes=plan.steps.flatMap(s=>s.shapes.map(shape=>({id:s.parameter.id,...shape})));
  assert.deepEqual(new Set(shapes.map(s=>s.target)),new Set([...expected.keys()].map(id=>'mesh:'+id)));
  for(const [layerId,semantic] of expected) {
    const spec=plan.specs.find(s=>s.semantic===semantic);assert(spec,semantic);
    assert.equal(spec.runtimeOwner,'physics');
    const endpoints=shapes.filter(s=>s.id===spec.id);assert.deepEqual(endpoints.map(s=>s.value),[-1,1]);
    for(const shape of endpoints) {
      assert.equal(shape.target,'mesh:'+layerId);
      const op=shape.operations[0];assert.equal(op.type,'arc');
      assert.deepEqual(op.root,geometry.root);assert.deepEqual(op.tip,geometry.tip);
      assert(op.root_pin>=.18);assert.equal(Math.sign(op.degrees),shape.value);
      assert.equal(Math.abs(op.degrees),semantic.startsWith('cloth.')?1.5:semantic.startsWith('accessory.')?2:3);
    }
  }
  const withoutMesh=planRefinements([parts[0]],[],brief);
  assert(!withoutMesh.specs.some(s=>s.semantic.startsWith('accessory.')));
  assert.equal(plan.repairProfile,RIG_REPAIR_PROFILE);
});

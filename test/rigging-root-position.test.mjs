import test from 'node:test';
import assert from 'node:assert/strict';
import {applyRootPositionRig} from '../src/rigging/root-position.mjs';

test('position wraps the complete original root and uses independent X/Y axes',async()=>{
  const calls=[],session={async step(key,op,body){calls.push({key,op,body});}};
  await applyRootPositionRig(session,{width:800,height:800});
  assert.deepEqual(calls[0].body,{id:'DeformRootPosition',name:'画面内位置',meshes:[],add_to:'parent_of_deformer',deformer_id:'DeformBodyXY',bounds:{x:0,y:0,w:800,h:800},rows:1,columns:1});
  for(const [id,axis] of [['ParamBaseX',0],['ParamBaseY',1]]){
    const call=calls.find(c=>c.op==='author_axis'&&c.body.parameter.id===id);
    assert.deepEqual(call.body.parameter,{id,min:-1,max:1,default:0});
    assert.deepEqual([...new Set(call.body.shapes.map(s=>s.value))],[-1,1]);
    assert.equal(call.body.shapes.length,axis===0?2:6);
    for(const s of call.body.shapes){
      assert.equal(s.target,'warp:DeformRootPosition');
      assert.equal(s.operations[0].delta[axis],s.value*.1);
      assert.equal(s.operations[0].delta[1-axis],0);
    }
  }
  assert.deepEqual(calls[2].body.shapes.map(s=>s.key.ParamBaseX),[-1,0,1,-1,0,1]);
});

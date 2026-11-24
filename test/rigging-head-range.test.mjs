import test from 'node:test';
import assert from 'node:assert/strict';
import {applyHeadRangeClamps} from '../src/rigging/head-range.mjs';

test('outer head cells retain the nearest authored turn at every body-lean state',async()=>{
  const axes={ParamAngleX:[-45,-15,0,15,45],ParamAngleY:[-30,-10,0,10,30],ParamBodyLean:[-10,0,10]};
  const calls=[],session={async query(op,body){assert.equal(body.target,'warp:DeformHeadContainer');return {data:{axes}};},
    async step(key,operation,body){calls.push({key,operation,body});}};
  const report=await applyHeadRangeClamps(session,{yaw:15,pitch:10});
  const changes=calls.flatMap(c=>c.body.changes);
  assert.equal(changes.length,48);
  assert.equal(report.copiedCells,48);
  for(const c of changes){
    assert.equal(c.op,'copy');assert.equal(c.target,'warp:DeformHeadContainer');
    assert.deepEqual(c.from,{ParamAngleX:Math.max(-15,Math.min(15,c.key.ParamAngleX)),
      ParamAngleY:Math.max(-10,Math.min(10,c.key.ParamAngleY)),ParamBodyLean:c.key.ParamBodyLean});
    assert(Math.abs(c.key.ParamAngleX)>15||Math.abs(c.key.ParamAngleY)>10);
    assert.equal(c.channels,undefined,'preserve the complete native geometry form');
  }
  assert.equal(new Set(changes.map(c=>JSON.stringify(c.key))).size,48);
  assert(calls.every(c=>c.operation==='keyform_apply'&&c.body.changes.length<=64));
});

test('missing authored boundary rejects before changing the native model',async()=>{
  let writes=0;
  const session={async query(){return {data:{axes:{ParamAngleX:[-45,0,45],ParamAngleY:[-30,0,30]}}};},async step(){writes++;}};
  await assert.rejects(applyHeadRangeClamps(session,{yaw:15,pitch:10}),/HEAD_RANGE_AUTHORED_BOUNDARY_MISSING/);
  assert.equal(writes,0);
});

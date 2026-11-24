import test from 'node:test';
import assert from 'node:assert/strict';
import {unmatteGreen} from '../src/artwork/chroma-matte.mjs';

test('green matte keeps the real foreground and recovers a mixed dark edge',()=>{
  const image={width:3,height:1,data:Buffer.from([40,40,40,255,20,148,20,255,0,255,0,255])};
  const out=unmatteGreen(image);
  assert.deepEqual([...out.data.subarray(0,4)],[40,40,40,255]);
  assert.ok(Math.abs(out.data[7]-128)<=1);
  for(const c of out.data.subarray(4,7))assert.ok(Math.abs(c-40)<=2);
  assert.deepEqual([...out.data.subarray(8,12)],[0,0,0,0]);
  assert.equal(image.data[7],255);
});
test('yellow/lime hair ornament is not classified as green background',()=>{
  const image={width:2,height:1,data:Buffer.from([190,255,0,255,235,225,50,255])};
  assert.deepEqual(unmatteGreen(image).data,image.data);
});

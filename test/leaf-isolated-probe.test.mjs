import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {packageControls,probe} from '../scripts/leaf-isolated-probe.mjs';

const manifest={
  requirementCoverage:{requested:{expressions:['smile','surprise'],clothingVariants:['chest_bow'],actions:['wave','reset']}},
  expressions:[{id:'dyn_smile',name:'Smile',leafId:'0',file:'smile.json',exclusiveGroup:'emotion'},
    {id:'dyn_surprise',name:'Surprise',leafId:'1',file:'surprise.json',exclusiveGroup:'emotion'},
    {id:'dyn_appearance_chest_bow',name:'Remove chest bow',leafId:'2',file:'bow.json',exclusiveGroup:'appearance.chest_bow.toggle'}],
  motions:[{id:'dyn_idle',leafId:'idle:0',file:'idle.json'},{id:'dyn_wave',leafId:'gesture:3',file:'wave.json'}]
};

test('isolated runtime drives the registered Leaf indices in the requested order',()=>{
  const controls=packageControls(manifest);
  assert.deepEqual(controls.expressions.map(e=>[e.kind,e.leafId]),
    [['emotion','0'],['emotion','1'],['appearance','2']]);
  assert.equal(controls.motion.leafId,'gesture:3');
});

test('isolated runtime cannot treat an incomplete download as a full character check',()=>{
  for(const drop of [...manifest.expressions,...manifest.motions.filter(m=>m.id==='dyn_wave')]) {
    assert.throws(()=>packageControls({...manifest,expressions:manifest.expressions.filter(e=>e!==drop),
      motions:manifest.motions.filter(e=>e!==drop)}),/未逐项覆盖/);
  }
});

test('untrusted ZIP bytes stop before extraction and never create an evidence folder',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'leaf-zip-negative-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const zip=path.join(dir,'download.zip'),output=path.join(dir,'proof');
  await fs.writeFile(zip,'altered');
  await assert.rejects(probe({package:zip,sha256:'0'.repeat(64),output}),/SHA256/);
  assert.deepEqual(await fs.readdir(dir),['download.zip']);
});
